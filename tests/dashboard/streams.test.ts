/**
 * C6 acceptance — Streams page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore, type WorkerRecord, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderStreamsPage, type StreamsData } from '../../src/dashboard/pages/streams.js';

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

function snap(over: Partial<StreamsData> = {}): StreamsData {
  return { workers: [], recent: {}, ...over };
}

describe('Streams page — unit', () => {
  it('renders one pane per worker with name, type, status pill', () => {
    const html = renderStreamsPage(snap({
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
    const html = renderStreamsPage(snap({ workers }));
    const paneMatches = html.match(/data-worker-id="w/g);
    expect(paneMatches?.length).toBe(20);
    expect(html).toContain('capped at 20 of 25');
  });

  it('renders recent events as tail lines per pane', () => {
    const w = worker({ id: 'w1' });
    const html = renderStreamsPage(snap({
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
    const html = renderStreamsPage(snap({
      workers: [worker({ id: 'w1' })],
      recent: {},
    }));
    expect(html).toContain('No output yet.');
  });

  it('emits filter selects with the union of worker types', () => {
    const html = renderStreamsPage(snap({
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
    const html = renderStreamsPage(snap());
    expect(html).toContain('No workers running.');
  });

  it('wires SSE for live append', () => {
    const html = renderStreamsPage(snap({ workers: [worker({ id: 'w1' })] }));
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('EventSource');
    expect(html).toContain('appendLine');
  });

  it('attaches data-last-at so the quiet check has something to look at', () => {
    const startedAt = new Date('2030-01-01T00:00:00Z').toISOString();
    const html = renderStreamsPage(snap({
      workers: [worker({ id: 'w1', started_at: startedAt })],
    }));
    expect(html).toContain(`data-last-at="${startedAt}"`);
  });

  it('v0.6.10 Task 2 — Worker roster table lifted from Topology renders below the grid', () => {
    const html = renderStreamsPage(snap({
      workers: [
        worker({ id: 'w1', name: 'alpha', status: 'running' }),
        worker({ id: 'w2', name: 'beta',  status: 'idle' }),
      ],
    }));
    expect(html).toContain('Worker roster');
    expect(html).toContain('data-role="streams-roster"');
    expect(html).toContain('class="roster-row"');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    // Lifecycle pills (running → info, idle → success): asserting the
    // pill classes anchors the visual variant just like the old Topology
    // roster test did, but on the new owning page.
    expect(html).toContain('pill-info');
    expect(html).toContain('pill-success');
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

describe('Streams page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/streams renders panes for persisted workers', async () => {
    h.store.upsertWorker(worker({ id: 'w-int', name: 'cc-int', status: 'running' }));
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      correlation_id: 'w-int',
      source_agent: 'cc',
      payload: { message: 'integration test event' },
    });
    const r = await fetch(`${h.base}/dashboard/streams`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-int');
    expect(body).toContain('integration test event');
    expect(body).toContain('data-page="streams"');
  });
});
