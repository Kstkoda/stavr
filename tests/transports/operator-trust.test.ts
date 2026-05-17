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

// F69 — the Diagnostics window selector (5m/1h/24h/7d) was theatrical
// (clicks only re-pressed the chip). It now drives a real fetch against
// /dashboard/api/traffic-summary, which must answer with 12 bucketed
// counts per series for each allowed range.
describe('Operator-trust · /dashboard/api/traffic-summary (F69)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('returns 12 zero buckets per series when empty', async () => {
    const r = await fetch(`${h.base}/dashboard/api/traffic-summary?range=5m`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.window).toBe('5m');
    expect(body.buckets).toBe(12);
    expect(body.mcp.points).toHaveLength(12);
    expect(body.workers.points).toHaveLength(12);
    expect(body.errors.points).toHaveLength(12);
    expect(body.mcp.total).toBe(0);
    expect(body.workers.total).toBe(0);
    expect(body.errors.total).toBe(0);
  });

  it('counts real events into mcp/workers/errors buckets', async () => {
    const at = new Date().toISOString();
    await h.broker.publish({ kind: 'steward_tool_call', at, source_agent: 'steward', payload: { tool: 'fs.read', args: {} } });
    await h.broker.publish({ kind: 'steward_tool_call', at, source_agent: 'steward', payload: { tool: 'fs.read', args: {} } });
    await h.broker.publish({ kind: 'worker_activity', at, source_agent: 'worker:cc', payload: { id: 'w1' } });
    await h.broker.publish({ kind: 'error', at, source_agent: 'stavr-daemon', payload: { message: 'boom', recoverable: false } });

    const r = await fetch(`${h.base}/dashboard/api/traffic-summary?range=1h`);
    const body = await r.json();
    expect(body.mcp.total).toBe(2);
    expect(body.workers.total).toBe(1);
    expect(body.errors.total).toBe(1);
  });

  it('accepts all four windows and reports bucket_width_ms that scales with the window', async () => {
    const widths: Record<string, number> = {};
    for (const range of ['5m', '1h', '24h', '7d']) {
      const r = await fetch(`${h.base}/dashboard/api/traffic-summary?range=${range}`);
      const body = await r.json();
      expect(body.window).toBe(range);
      widths[range] = body.bucket_width_ms;
    }
    // Bucket width is monotonically increasing across the window sizes.
    expect(widths['5m']).toBeLessThan(widths['1h']);
    expect(widths['1h']).toBeLessThan(widths['24h']);
    expect(widths['24h']).toBeLessThan(widths['7d']);
  });
});

// F68 — Diagnostics LIVE TRACE TAIL was reported as showing a connected
// SSE dot but never displaying events. The broker → SSE pipe is in fact
// healthy; this test pins that contract so a future refactor cannot
// silently regress it.
describe('Operator-trust · /dashboard/stream forwarding (F68)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('forwards a capture_filed publish to the SSE client within 3s', async () => {
    const controller = new AbortController();
    const res = await fetch(`${h.base}/dashboard/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial ping so the next read returns our event.
    await reader.read();

    void h.broker.publish({
      kind: 'capture_filed',
      at: new Date().toISOString(),
      source_agent: 'dashboard',
      payload: { id: 'cap-1', type: 'bug', priority: 'normal', destination: '/tmp/x.jsonl' },
    });

    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('event: event\n') && buf.includes('capture_filed')) break;
    }
    controller.abort();
    expect(buf).toContain('event: event\n');
    expect(buf).toContain('capture_filed');
    expect(buf).toContain('cap-1');
  });

  it('forwards multiple distinct event kinds in order to the same SSE client', async () => {
    const controller = new AbortController();
    const res = await fetch(`${h.base}/dashboard/stream`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    const at = new Date().toISOString();
    void h.broker.publish({ kind: 'worker_spawned', at, source_agent: 'stavr-daemon', payload: { id: 'w1', name: 'w1', type: 'cc', cwd: '.', metadata: {} } });
    void h.broker.publish({ kind: 'capture_filed', at, source_agent: 'dashboard', payload: { id: 'cap-2', type: 'feature', priority: 'normal', destination: '/tmp/y.jsonl' } });

    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('worker_spawned') && buf.includes('capture_filed')) break;
    }
    controller.abort();
    expect(buf).toContain('worker_spawned');
    expect(buf).toContain('capture_filed');
    expect(buf.indexOf('worker_spawned')).toBeLessThan(buf.indexOf('capture_filed'));
  });
});
