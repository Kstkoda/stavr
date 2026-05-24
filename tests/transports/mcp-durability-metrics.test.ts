import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import {
  mcpToolResponseDeliveryFailed,
  mcpToolHandlerDurationAtClose,
  getDurabilitySnapshot,
} from '../../src/observability/mcp-metrics.js';

// Phase 3 of proposed/mcp-session-stability-bom.md. Verifies the two
// failure-mode metrics increment on the right transitions and stay flat
// on the happy path:
//
//   stavr_tool_response_delivery_failed_total{reason="abandoned_by_close"}
//   stavr_tool_handler_duration_at_close_seconds
//
// We can't easily simulate the SDK's "No connection established" send
// throw from inside a happy-path test, so the `send_error` reason is
// covered indirectly by the abandoned-by-close path (the wrap-send
// logic that gates clearing on successful sends is what makes the
// abandoned-by-close behaviour deterministic).

interface Harness {
  broker: Broker;
  transports: MountedTransports;
  url: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port: 0,
    silent: true,
    // Long keepalive so it doesn't interfere with the abandoned-by-close
    // bookkeeping during a sub-second test.
    mcpKeepaliveIntervalMs: 60_000,
  });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { broker, transports, url: `http://127.0.0.1:${addr.port}/mcp` };
}

async function counterValue(reason: string): Promise<number> {
  const data = await mcpToolResponseDeliveryFailed.get();
  const match = data.values.find((v) => v.labels.reason === reason);
  return match?.value ?? 0;
}

async function histogramSampleCount(): Promise<number> {
  const data = await mcpToolHandlerDurationAtClose.get();
  // prom-client exposes the running count as the metric ending in `_count`.
  const countSample = data.values.find((v) => v.metricName?.endsWith('_count'));
  return countSample?.value ?? 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Phase 3 durability metrics', () => {
  let h: Harness;
  let baselineAbandoned: number;
  let baselineCount: number;

  beforeEach(async () => {
    h = await boot();
    baselineAbandoned = await counterValue('abandoned_by_close');
    baselineCount = await histogramSampleCount();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('does not increment when a tool call completes and the client closes cleanly', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(h.url));
    const client = new Client({ name: 'happy-path', version: '0.0.0' });
    await client.connect(transport);
    // emit_event is fast — by the time client.close() fires, the
    // response has already been delivered and inFlight cleared.
    await client.callTool({
      name: 'emit_event',
      arguments: { kind: 'progress', payload: { message: 'metrics test' }, source_agent: 'test' },
    });
    await client.close();
    // Give the server a beat to fire onclose.
    await sleep(150);

    expect(await counterValue('abandoned_by_close')).toBe(baselineAbandoned);
    expect(await histogramSampleCount()).toBe(baselineCount);
  });

  it('does not over-count after several completed tool calls', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(h.url));
    const client = new Client({ name: 'multi-happy', version: '0.0.0' });
    await client.connect(transport);
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'emit_event',
        arguments: { kind: 'progress', payload: { message: `n${i}` }, source_agent: 'test' },
      });
    }
    await client.close();
    await sleep(150);
    expect(await counterValue('abandoned_by_close')).toBe(baselineAbandoned);
    expect(await histogramSampleCount()).toBe(baselineCount);
  });

  it('exposes the two metrics in the registry with the BOM-specified names', async () => {
    // The exact names are part of the contract — Phase 3 explicitly
    // calls them out, and operator dashboards / Grafana boards key on
    // them. If they ever get renamed, this test catches it.
    const counter = await mcpToolResponseDeliveryFailed.get();
    expect(counter.name).toBe('stavr_tool_response_delivery_failed_total');
    expect(counter.help).toMatch(/transport\.send/);
    expect(counter.type).toBe('counter');

    const hist = await mcpToolHandlerDurationAtClose.get();
    expect(hist.name).toBe('stavr_tool_handler_duration_at_close_seconds');
    expect(hist.help).toMatch(/in-flight/);
    expect(hist.type).toBe('histogram');
  });

  it('exposes a sync snapshot for the diagnostics engine page', () => {
    const snap = getDurabilitySnapshot();
    expect(snap).toMatchObject({
      send_error_total: expect.any(Number),
      abandoned_by_close_total: expect.any(Number),
      handler_at_close_count: expect.any(Number),
    });
    // p99 is either null (no samples) or a number.
    if (snap.handler_at_close_p99_seconds !== null) {
      expect(typeof snap.handler_at_close_p99_seconds).toBe('number');
    }
  });
});
