/**
 * C6 acceptance — Workers page (renamed from Streams in chore/streams-to-workers).
 * The legacy /dashboard/streams URL still serves the same page, so the
 * integration block keeps hitting that path to confirm the alias.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore, type WorkerRecord, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderWorkersPage, type WorkersData } from '../../src/dashboard/pages/workers.js';

function worker(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: 'w_' + Math.random().toString(36).slice(2, 6),
    name: 'sample',
    type: 'cc',
    cwd: '/tmp/x',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    spawn_params_hash: 'hash',
    ...over,
  };
}

function ev(over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 1,
    persisted_at: new Date().toISOString(),
    at: new Date().toISOString(),
    kind: 'progress',
    source_agent: 'cc',
    payload: { message: 'hello' },
    correlation_id: undefined,
    tenant_id: undefined,
    ...over,
  };
}

function snap(over: Partial<WorkersData> = {}): WorkersData {
  return { workers: [], recent: {}, ...over };
}

describe('Workers page — unit', () => {
  it('renders one pane per worker with name, type, status pill', () => {
    const html = renderWorkersPage(snap({
      workers: [
        worker({ id: 'w1', name: 'cc-alpha', type: 'cc', status: 'running' }),
        worker({ id: 'w2', name: 'opus-beta', type: 'opus', status: 'idle' }),
      ],
    }));
    expect(html).toContain('cc-alpha');
    expect(html).toContain('opus-beta');
    expect(html).toContain('data-worker-id="w1"');
    expect(html).toContain('data-worker-id="w2"');
    expect(html).toContain('pill-info');    // running
    expect(html).toContain('pill-success'); // idle
  });

  it('caps the visible pane count at 20', () => {
    const workers = Array.from({ length: 25 }, (_, i) => worker({ id: 'w' + i, name: 'w-' + i }));
    const html = renderWorkersPage(snap({ workers }));
    const paneMatches = html.match(/data-worker-id="w/g);
    expect(paneMatches?.length).toBe(20);
    expect(html).toContain('capped at 20 of 25');
  });

  it('renders recent events as tail lines per pane', () => {
    const w = worker({ id: 'w1' });
    const html = renderWorkersPage(snap({
      workers: [w],
      recent: {
        w1: [
          ev({ kind: 'progress', payload: { message: 'starting' } }),
          ev({ kind: 'command_run', payload: { command: 'npm test', exit_code: 0 } }),
        ],
      },
    }));
    expect(html).toContain('starting');
    expect(html).toContain('command_run');
    expect(html).toContain('npm test');
  });

  it('shows a per-pane empty-tail placeholder when there is no output', () => {
    const html = renderWorkersPage(snap({
      workers: [worker({ id: 'w1' })],
      recent: {},
    }));
    expect(html).toContain('No output yet.');
  });

  it('emits filter selects with the union of worker types', () => {
    const html = renderWorkersPage(snap({
      workers: [
        worker({ type: 'cc' }),
        worker({ type: 'opus' }),
        worker({ type: 'cc' }),
      ],
    }));
    expect(html).toContain('data-role="filter-type"');
    expect(html).toContain('<option value="cc">cc</option>');
    expect(html).toContain('<option value="opus">opus</option>');
  });

  it('shows the empty state when no workers are present', () => {
    const html = renderWorkersPage(snap());
    expect(html).toContain('No workers running.');
  });

  it('wires SSE for live append', () => {
    const html = renderWorkersPage(snap({ workers: [worker({ id: 'w1' })] }));
    // The SSE event-stream endpoint is /dashboard/stream (singular) — a
    // separate concept from the renamed Workers page. The shell's shared
    // stream singleton owns the EventSource open; the page just subscribes.
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('EventSource');
    expect(html).toContain('appendLine');
  });

  it('attaches data-last-at so the quiet check has something to look at', () => {
    const startedAt = new Date('2030-01-01T00:00:00Z').toISOString();
    const html = renderWorkersPage(snap({
      workers: [worker({ id: 'w1', started_at: startedAt })],
    }));
    expect(html).toContain(`data-last-at="${startedAt}"`);
  });

  it('v0.6.10 Task 2 — Worker roster table lifted from Topology renders below the grid', () => {
    const html = renderWorkersPage(snap({
      workers: [
        worker({ id: 'w1', name: 'alpha', status: 'running' }),
        worker({ id: 'w2', name: 'beta',  status: 'idle' }),
      ],
    }));
    expect(html).toContain('Worker roster');
    expect(html).toContain('data-role="workers-roster"');
    expect(html).toContain('class="roster-row"');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    // Lifecycle pills (running → info, idle → success): asserting the
    // pill classes anchors the visual variant just like the old Topology
    // roster test did, but on the new owning page.
    expect(html).toContain('pill-info');
    expect(html).toContain('pill-success');
  });

  it('historic split — 24h window: keeps recent terminated workers, drops older ones', () => {
    const now = Date.now();
    const recent = worker({
      id: 'h-recent', name: 'finished-1h-ago', status: 'terminated',
      started_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      ended_at:   new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    });
    const old = worker({
      id: 'h-old', name: 'finished-3d-ago', status: 'terminated',
      started_at: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
      ended_at:   new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const html = renderWorkersPage(snap({ workers: [recent, old] }));
    expect(html).toContain('finished-1h-ago');
    expect(html).not.toContain('finished-3d-ago');
    expect(html).toContain('History · last 24h · 1 pane');
    expect(html).toContain('/dashboard/history');
  });

  it('historic section is omitted entirely when there are no historic workers in window', () => {
    const html = renderWorkersPage(snap({ workers: [worker({ id: 'w1', status: 'running' })] }));
    expect(html).not.toContain('data-role="workers-history"');
  });

  it('page chrome — uses Workers activePage + title', () => {
    const html = renderWorkersPage(snap());
    expect(html).toContain('data-active-page="workers"');
    expect(html).toContain('<title>Stavr — Workers</title>');
    expect(html).toContain('<h1 class="page-title">Workers</h1>');
  });
});

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

describe('Workers page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/workers renders panes for persisted workers', async () => {
    h.store.upsertWorker(worker({ id: 'w-int', name: 'cc-int', status: 'running' }));
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      correlation_id: 'w-int',
      source_agent: 'cc',
      payload: { message: 'integration test event' },
    });
    const r = await fetch(`${h.base}/dashboard/workers`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-int');
    expect(body).toContain('integration test event');
    expect(body).toContain('data-page="workers"');
  });

  it('legacy alias — GET /dashboard/streams still serves the Workers page', async () => {
    h.store.upsertWorker(worker({ id: 'w-legacy', name: 'cc-legacy', status: 'running' }));
    const r = await fetch(`${h.base}/dashboard/streams`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-legacy');
    // Same page renderer → same activePage marker.
    expect(body).toContain('data-active-page="workers"');
    expect(body).toContain('<h1 class="page-title">Workers</h1>');
  });
});
