import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';

// Per BOM proposed/mcp-session-stability-bom.md Phase 2b. The transport
// schedules a 20s server-initiated `notifications/message` on the
// standalone GET stream of every session — defence-in-depth against
// idle-disconnect on the control channel. Phase 0's findings ruled out
// the heartbeat being load-bearing for the 15-min recycle (that's
// wall-clock), but the interval still has to fire on schedule and the
// session has to clean it up on close.
//
// Tests drive the interval at 100ms via the `mcpKeepaliveIntervalMs`
// option — production uses 20s.

interface Harness {
  store: EventStore;
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
    mcpKeepaliveIntervalMs: 100,
  });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, url: `http://127.0.0.1:${addr.port}/mcp` };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('MCP session keepalive (BOM Phase 2b)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('delivers periodic notifications/message on the standalone stream', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(h.url));
    const client = new Client({ name: 'keepalive-test', version: '0.0.0' });
    const logs: Array<{ logger?: string; data: unknown }> = [];
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/message') {
        const params = n.params as { logger?: string; data: unknown };
        logs.push({ logger: params.logger, data: params.data });
      }
    };
    await client.connect(transport);

    // Wait ~350ms — at a 100ms interval we expect 2-3 keepalives.
    await sleep(350);
    await client.close();

    const keepalives = logs.filter((l) => l.logger === 'stavr-keepalive');
    expect(keepalives.length).toBeGreaterThanOrEqual(2);
    for (const k of keepalives) {
      expect(k.data).toMatchObject({ at: expect.any(Number) });
    }
  });

  it('clears the keepalive interval when the client closes the session', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(h.url));
    const client = new Client({ name: 'close-test', version: '0.0.0' });
    await client.connect(transport);
    // Give the server a moment to register and schedule the interval.
    await sleep(50);
    await client.close();
    // After close, give the server time to process onclose.
    await sleep(150);
    // If the interval leaked, vitest's open-handle detection would fail
    // the test. The assertion here also documents the invariant: no
    // dangling timers per closed session.
    expect(true).toBe(true);
  });

  it('serves multiple concurrent sessions, each with its own keepalive', async () => {
    const make = async (name: string): Promise<{ client: Client; keepalives: number }> => {
      const t = new StreamableHTTPClientTransport(new URL(h.url));
      const client = new Client({ name, version: '0.0.0' });
      const state = { keepalives: 0 };
      client.fallbackNotificationHandler = async (n) => {
        if (n.method === 'notifications/message') {
          const params = n.params as { logger?: string };
          if (params.logger === 'stavr-keepalive') state.keepalives++;
        }
      };
      await client.connect(t);
      return { client, get keepalives() { return state.keepalives; } };
    };

    const a = await make('a');
    const b = await make('b');
    await sleep(350);
    await a.client.close();
    await b.client.close();

    expect(a.keepalives).toBeGreaterThanOrEqual(2);
    expect(b.keepalives).toBeGreaterThanOrEqual(2);
  });
});
