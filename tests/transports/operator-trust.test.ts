import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';

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

// Storm Pass #2 — Cluster 0 (Operator Trust). The Helm L1 top-tools panel
// previously rendered a hardcoded v8-mockup array; it now resolves real
// audit-event counts via /dashboard/api/top-tools.
describe('Operator-trust · /dashboard/api/top-tools (F9)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('returns empty tools list when no tool_call events exist', async () => {
    const r = await fetch(`${h.base}/dashboard/api/top-tools?range=1h`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.window).toBe('1h');
    expect(body.total_tool_calls).toBe(0);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toHaveLength(0);
  });

  it('ranks tools by call count, top-N descending, with pct relative to the top entry', async () => {
    const at = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await h.broker.publish({ kind: 'steward_tool_call', at, source_agent: 'steward', payload: { tool: 'github.read_pr', args: {} } });
    }
    for (let i = 0; i < 3; i++) {
      await h.broker.publish({ kind: 'steward_tool_call', at, source_agent: 'steward', payload: { tool: 'fs.write', args: {} } });
    }
    await h.broker.publish({ kind: 'steward_tool_call', at, source_agent: 'steward', payload: { tool: 'slack.post', args: {} } });

    const r = await fetch(`${h.base}/dashboard/api/top-tools?range=1h&limit=2`);
    const body = await r.json();
    expect(body.total_tool_calls).toBe(9);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toMatchObject({ name: 'github.read_pr', count: 5, pct: 100 });
    expect(body.tools[1]).toMatchObject({ name: 'fs.write', count: 3 });
    expect(body.tools[1].pct).toBe(60);
  });

  it('defaults to range=1h when range param is missing or invalid', async () => {
    const r1 = await fetch(`${h.base}/dashboard/api/top-tools`);
    expect((await r1.json()).window).toBe('1h');
    const r2 = await fetch(`${h.base}/dashboard/api/top-tools?range=bogus`);
    expect((await r2.json()).window).toBe('1h');
  });

  it('accepts all four allowed window sizes (5m, 1h, 24h, 7d)', async () => {
    for (const range of ['5m', '1h', '24h', '7d']) {
      const r = await fetch(`${h.base}/dashboard/api/top-tools?range=${range}`);
      const body = await r.json();
      expect(body.window).toBe(range);
    }
  });
});
