/**
 * Spec 40 Phase 3 — audit dashboard HTTP surface.
 *
 * Boots a real daemon-mode transport on an ephemeral port and exercises every
 * /dashboard* route from the outside, the same way a browser would. The live
 * SSE tail is verified by emitting an event after subscribing and asserting
 * the JSON payload lands on the wire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports, type MountedTransports } from '../src/transports.js';

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

describe('Spec 40 Phase 3 — dashboard HTTP', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('GET /dashboard redirects to /dashboard/helm and serves the v0.4 shell', async () => {
    // v0.4: /dashboard is now a redirect entry-point pointing at Helm
    // (the rename of Home in the v8 visual refresh). fetch follows by default.
    const r = await fetch(`${h.base}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.url.endsWith('/dashboard/helm')).toBe(true);
    const body = await r.text();
    // v0.6.11 Phase 5 — wordmark is `stav` + Raido rune (UX audit T1 dropped
    // the SR-only STAVR duplicate). Both `brand-mark` and the `.stav` span
    // are stable shell-mount markers.
    expect(body).toContain('class="stav"');
    // Nav links to every primary page surface live in the shell.
    expect(body).toContain('href="/dashboard/topology"');
    expect(body).toContain('href="/dashboard/plans"');
    expect(body).toContain('href="/dashboard/decide"');
  });

  it('GET /dashboard returns a 302 when redirects are disabled', async () => {
    const r = await fetch(`${h.base}/dashboard`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/dashboard/helm');
  });

  it('GET /dashboard/status reports uptime, clients, scopes', async () => {
    const r = await fetch(`${h.base}/dashboard/status`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.uptime_sec).toBe('number');
    expect(j.connected_clients).toBe(0);
    expect(j.active_scopes).toBe(0);
    expect(Array.isArray(j.scopes)).toBe(true);
  });

  it('GET /dashboard/workers/data lists workers from the store', async () => {
    // chore/streams-to-workers — moved off the bare `/dashboard/workers`
    // path so that URL can serve the renamed (was Streams) HTML page.
    h.store.upsertWorker({
      id: 'w-1',
      name: 'cc-feat-x',
      type: 'cc',
      cwd: '/tmp/x',
      status: 'running',
      started_at: new Date().toISOString(),
      metadata: { branch: 'feat/x' },
      spawn_params_hash: 'h1',
    });
    const r = await fetch(`${h.base}/dashboard/workers/data`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.workers).toHaveLength(1);
    expect(j.workers[0].id).toBe('w-1');
    expect(j.workers[0].metadata.branch).toBe('feat/x');
  });

  it('GET /dashboard/workers/:id returns worker + recent events + tool_calls', async () => {
    h.store.upsertWorker({
      id: 'w-2',
      name: 'cc-feat-y',
      type: 'cc',
      cwd: '/tmp/y',
      status: 'running',
      started_at: new Date().toISOString(),
      metadata: {},
      spawn_params_hash: 'h2',
    });
    await h.broker.publish({
      kind: 'worker_progress',
      at: new Date().toISOString(),
      correlation_id: 'w-2',
      source_agent: 'orchestrator',
      payload: { id: 'w-2', message: 'started' },
    });
    await h.broker.publish({
      kind: 'command_run',
      at: new Date().toISOString(),
      correlation_id: 'w-2',
      source_agent: 'cc',
      payload: { command: 'npm test', exit_code: 0, duration_ms: 1234 },
    });
    const r = await fetch(`${h.base}/dashboard/workers/w-2`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.worker.id).toBe('w-2');
    expect(j.events.length).toBeGreaterThanOrEqual(2);
    expect(j.tool_calls.length).toBe(1);
    expect(j.tool_calls[0].kind).toBe('command_run');
  });

  it('GET /dashboard/workers/:id 404s for unknown id', async () => {
    const r = await fetch(`${h.base}/dashboard/workers/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('GET /dashboard/events filters by kind, since, correlation_id', async () => {
    const e1 = await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      correlation_id: 'corr-A',
      source_agent: 'cc',
      payload: { message: 'one' },
    });
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      correlation_id: 'corr-B',
      source_agent: 'cc',
      payload: { message: 'two' },
    });
    await h.broker.publish({
      kind: 'command_run',
      at: new Date().toISOString(),
      correlation_id: 'corr-A',
      source_agent: 'cc',
      payload: { command: 'tsc', exit_code: 0, duration_ms: 200 },
    });

    const allR = await fetch(`${h.base}/dashboard/events?limit=10`);
    const all = await allR.json();
    expect(all.events.length).toBe(3);

    const byKindR = await fetch(`${h.base}/dashboard/events?kind=command_run`);
    const byKind = await byKindR.json();
    expect(byKind.events.length).toBe(1);
    expect(byKind.events[0].kind).toBe('command_run');

    const byCorrR = await fetch(`${h.base}/dashboard/events?correlation_id=corr-A`);
    const byCorr = await byCorrR.json();
    expect(byCorr.events.length).toBe(2);
    expect(byCorr.events.every((e: { correlation_id: string }) => e.correlation_id === 'corr-A')).toBe(true);

    const sinceR = await fetch(`${h.base}/dashboard/events?since=${e1.id}`);
    const since = await sinceR.json();
    expect(since.events.length).toBe(2); // strictly after e1
  });

  it('GET /dashboard/decisions returns open decisions only by default', async () => {
    h.store.createDecision('d-1', 'approve?', [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], 300, 'no');
    h.store.createDecision('d-2', 'approve?', [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], 300, 'no');
    h.store.respondToDecision('d-2', 'yes', 'because', 'someone');

    const openR = await fetch(`${h.base}/dashboard/decisions`);
    const open = await openR.json();
    expect(open.decisions.map((d: { correlation_id: string }) => d.correlation_id)).toEqual(['d-1']);

    const allR = await fetch(`${h.base}/dashboard/decisions?status=all`);
    const all = await allR.json();
    expect(all.decisions.length).toBe(2);
  });

  it('POST /dashboard/decisions/:id/respond resolves the decision and publishes', async () => {
    h.store.createDecision('d-X', 'merge?', [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], 300, 'reject');

    const r = await fetch(`${h.base}/dashboard/decisions/d-X/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chosen_option_id: 'approve', responder: 'kenneth', reason: 'looks good' }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);

    const after = h.store.getDecision('d-X');
    expect(after?.status).toBe('responded');
    expect(after?.chosen_option_id).toBe('approve');
    expect(after?.responded_by).toBe('kenneth');

    const evs = h.store.getEvents({ kinds: ['decision_response'] }).events;
    expect(evs.length).toBe(1);
    expect((evs[0].payload as { responder: string }).responder).toBe('kenneth');
  });

  it('POST /dashboard/decisions/:id/respond 404s for unknown id', async () => {
    const r = await fetch(`${h.base}/dashboard/decisions/nope/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chosen_option_id: 'whatever' }),
    });
    expect(r.status).toBe(404);
  });

  it('POST /dashboard/decisions/:id/respond 400 when chosen_option_id missing', async () => {
    h.store.createDecision('d-Y', 'q', [{ id: 'a', label: 'A' }], 60);
    const r = await fetch(`${h.base}/dashboard/decisions/d-Y/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('GET /dashboard/export?format=json dumps events with content-disposition', async () => {
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'cc',
      payload: { message: 'hi' },
    });
    const r = await fetch(`${h.base}/dashboard/export?format=json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/stavr-audit-.*\.json/);
    const j = await r.json();
    expect(j.count).toBe(1);
    expect(j.events[0].kind).toBe('progress');
  });

  it('GET /dashboard/export?format=csv dumps a parseable CSV', async () => {
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'cc',
      payload: { message: 'commas, and "quotes"' },
    });
    const r = await fetch(`${h.base}/dashboard/export?format=csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await r.text();
    const [header, row] = text.trim().split('\n');
    expect(header).toBe('id,at,persisted_at,kind,source_agent,correlation_id,tenant_id,payload');
    expect(row).toContain('progress');
    expect(row).toContain('""message""'); // CSV doubles every embedded "
    expect(row.startsWith('"') === false || row.endsWith('"')).toBe(true); // CSV-balanced
  });

  it('GET /dashboard/stream delivers a live event over SSE', async () => {
    const ctrl = new AbortController();
    const got: Array<{ event: string; data: string }> = [];
    const reader = (async () => {
      const r = await fetch(`${h.base}/dashboard/stream`, { signal: ctrl.signal });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
      const stream = r.body!;
      const decoder = new TextDecoder();
      let buf = '';
      const rdr = stream.getReader();
      while (true) {
        const { done, value } = await rdr.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
          const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '';
          got.push({ event, data });
          if (got.some((g) => g.event === 'event')) {
            ctrl.abort();
            return;
          }
        }
      }
    })().catch(() => { /* aborted */ });

    // Give the stream a tick to land its initial ping + tap registration.
    await new Promise((r) => setTimeout(r, 80));
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'cc',
      payload: { message: 'live tail proof' },
    });

    // Wait for the reader to either grab the event or hit a sensible deadline.
    // 3000ms (was 1500ms) to absorb Ubuntu CI runner slack on the SSE live-tail race.
    await Promise.race([
      reader,
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    ctrl.abort();

    const realEvent = got.find((g) => g.event === 'event');
    expect(realEvent).toBeDefined();
    const parsed = JSON.parse(realEvent!.data);
    expect(parsed.kind).toBe('progress');
    expect(parsed.payload.message).toBe('live tail proof');
  }, 5_000);
});
