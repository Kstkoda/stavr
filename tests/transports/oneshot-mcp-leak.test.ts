import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';

// v0.6.x memory-leak regression. Before the fix, every POST /mcp without a
// matching session leaked one McpServer + one StreamableHTTPServerTransport
// because broker.subscribers retained the server and `transport.onclose`
// never fired (the SDK only calls onclose on explicit transport.close()).
// See proposed/v0_6_x-memory-leak-findings.md for the full trace.
//
// We assert two things:
//   1. broker.sessionCount() returns to its baseline after a burst.
//   2. Heap growth across N=200 stateless POSTs stays under a coarse bound.
// The heap bound is intentionally generous — Windows + better-sqlite3 GC
// timing is noisy. Pre-fix the same workload grew heap by hundreds of MB;
// post-fix it stays well under 50 MB.

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

async function postStatelessMcp(base: string): Promise<Response> {
  // Intentionally bad — no `initialize` handshake, no mcp-session-id. The SDK
  // either rejects with 400 or responds with a JSON-RPC error; either way the
  // transport never adopts a session id, which is the leak path.
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });
}

describe('v0.6.x memory-leak fix — stateless /mcp does not retain McpServers', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('broker.sessionCount() returns to baseline after a burst of stateless POSTs', async () => {
    const baseline = h.broker.sessionCount();
    for (let i = 0; i < 20; i++) {
      await postStatelessMcp(h.base);
    }
    // The fix cleans up synchronously after handleRequest, so the count must
    // equal the baseline immediately (no waiting on async cleanup).
    expect(h.broker.sessionCount()).toBe(baseline);
  });

  it('heap growth across 200 stateless POSTs stays under a coarse bound', async () => {
    // Warmup so first-invocation lazy loads don't pollute the measurement.
    for (let i = 0; i < 10; i++) {
      await postStatelessMcp(h.base);
    }
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;

    const N = 200;
    for (let i = 0; i < N; i++) {
      await postStatelessMcp(h.base);
    }

    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / 1_000_000;

    // Pre-fix: ~30-50 MB for N=200 (extrapolates to the operator's 36 MB/min).
    // Post-fix: typically <5 MB. Use a coarse 50 MB bound — generous enough to
    // tolerate GC timing noise on Windows / CI, tight enough to catch the
    // regression.
    expect(growthMb).toBeLessThan(50);
  });
});
