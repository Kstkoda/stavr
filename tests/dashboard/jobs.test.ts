/**
 * Jobs page tests (worker-dispatch Phase 3c.1 — renamed from
 * tests/dashboard/workers.test.ts; the legacy /dashboard/workers + the
 * super-legacy /dashboard/streams URLs still serve the same renderer via
 * shell aliases, so the integration block keeps hitting both paths).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore, type StoredEvent } from '../../src/persistence.js';
import type { JobRecord } from '../../src/jobs/types.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderJobsPage, type JobsData } from '../../src/dashboard/pages/jobs.js';

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j_' + Math.random().toString(36).slice(2, 6),
    name: 'sample',
    binding_kind: 'process-spawn',
    binding_target: 'cc',
    params_hash: 'h',
    lifecycle_state: 'running',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    metadata: {},
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

function snap(over: Partial<JobsData> = {}): JobsData {
  return { jobs: [], recent: {}, ...over };
}

describe('Jobs page — unit', () => {
  it('renders one pane per job with name, binding label, lifecycle pill', () => {
    const html = renderJobsPage(snap({
      jobs: [
        job({ id: 'j1', name: 'cc-alpha', binding_kind: 'process-spawn', binding_target: 'cc', lifecycle_state: 'running' }),
        job({ id: 'j2', name: 'http-beta', binding_kind: 'http', binding_target: 'ollama', lifecycle_state: 'dispatched' }),
      ],
    }));
    expect(html).toContain('cc-alpha');
    expect(html).toContain('http-beta');
    expect(html).toContain('data-job-id="j1"');
    expect(html).toContain('data-job-id="j2"');
    expect(html).toContain('process-spawn:cc');
    expect(html).toContain('http:ollama');
    // Both lifecycle pills are info during active states.
    expect(html).toContain('pill-info');
  });

  it('caps the visible pane count at 20', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job({ id: 'j' + i, name: 'j-' + i }));
    const html = renderJobsPage(snap({ jobs }));
    const paneMatches = html.match(/data-job-id="j/g);
    expect(paneMatches?.length).toBe(20);
    expect(html).toContain('capped at 20 of 25');
  });

  it('renders recent events as tail lines per pane', () => {
    const j = job({ id: 'j1' });
    const html = renderJobsPage(snap({
      jobs: [j],
      recent: {
        j1: [
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
    const html = renderJobsPage(snap({
      jobs: [job({ id: 'j1' })],
      recent: {},
    }));
    expect(html).toContain('No output yet.');
  });

  it('emits filter selects with the union of binding kinds', () => {
    const html = renderJobsPage(snap({
      jobs: [
        job({ binding_kind: 'process-spawn' }),
        job({ binding_kind: 'http' }),
        job({ binding_kind: 'process-spawn' }),
      ],
    }));
    expect(html).toContain('data-role="filter-kind"');
    expect(html).toContain('<option value="process-spawn">process-spawn</option>');
    expect(html).toContain('<option value="http">http</option>');
  });

  it('shows the empty state when no jobs are present', () => {
    const html = renderJobsPage(snap());
    expect(html).toContain('No jobs running.');
  });

  it('wires SSE for live append', () => {
    const html = renderJobsPage(snap({ jobs: [job({ id: 'j1' })] }));
    // The SSE event-stream endpoint is /dashboard/stream (singular) — a
    // separate concept from the Jobs page. The shell's shared stream
    // singleton owns the EventSource open; the page just subscribes.
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('EventSource');
    expect(html).toContain('appendLine');
  });

  it('attaches data-last-at so the quiet check has something to look at', () => {
    const startedAt = new Date('2030-01-01T00:00:00Z').toISOString();
    const html = renderJobsPage(snap({
      jobs: [job({ id: 'j1', started_at: startedAt, last_activity_at: startedAt })],
    }));
    expect(html).toContain(`data-last-at="${startedAt}"`);
  });

  it('Job roster table renders below the grid', () => {
    const html = renderJobsPage(snap({
      jobs: [
        job({ id: 'j1', name: 'alpha', lifecycle_state: 'running' }),
        job({ id: 'j2', name: 'beta',  lifecycle_state: 'completed-clean' }),
      ],
    }));
    expect(html).toContain('Job roster');
    expect(html).toContain('data-role="jobs-roster"');
    expect(html).toContain('class="roster-row"');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    // Lifecycle pills: running → info, completed-clean → success.
    expect(html).toContain('pill-info');
    expect(html).toContain('pill-success');
  });

  it('historic split — 24h window: keeps recent terminated jobs, drops older ones', () => {
    const now = Date.now();
    const recent = job({
      id: 'h-recent', name: 'finished-1h-ago', lifecycle_state: 'completed-clean',
      started_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      ended_at:   new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    });
    const old = job({
      id: 'h-old', name: 'finished-3d-ago', lifecycle_state: 'completed-clean',
      started_at: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
      ended_at:   new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const html = renderJobsPage(snap({ jobs: [recent, old] }));
    expect(html).toContain('finished-1h-ago');
    expect(html).not.toContain('finished-3d-ago');
    expect(html).toContain('History · last 24h · 1 pane');
    expect(html).toContain('/dashboard/history');
  });

  it('historic section is omitted entirely when there are no historic jobs in window', () => {
    const html = renderJobsPage(snap({ jobs: [job({ id: 'j1', lifecycle_state: 'running' })] }));
    expect(html).not.toContain('data-role="jobs-history"');
  });

  it('page chrome — uses Jobs activePage + title', () => {
    const html = renderJobsPage(snap());
    expect(html).toContain('data-active-page="jobs"');
    expect(html).toContain('<title>Stavr — Jobs</title>');
    expect(html).toContain('<h1 class="page-title">Jobs</h1>');
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

describe('Jobs page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/jobs renders panes for persisted jobs', async () => {
    h.store.upsertJob(job({ id: 'j-int', name: 'cc-int', lifecycle_state: 'running' }));
    await h.broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      correlation_id: 'j-int',
      source_agent: 'cc',
      payload: { message: 'integration test event' },
    });
    const r = await fetch(`${h.base}/dashboard/jobs`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-int');
    expect(body).toContain('integration test event');
    expect(body).toContain('data-page="jobs"');
  });

  it('legacy alias — GET /dashboard/workers still serves the Jobs page', async () => {
    h.store.upsertJob(job({ id: 'j-legacy', name: 'cc-legacy', lifecycle_state: 'running' }));
    const r = await fetch(`${h.base}/dashboard/workers`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-legacy');
    // Same page renderer → same activePage marker.
    expect(body).toContain('data-active-page="jobs"');
    expect(body).toContain('<h1 class="page-title">Jobs</h1>');
  });

  it('super-legacy alias — GET /dashboard/streams still serves the Jobs page', async () => {
    h.store.upsertJob(job({ id: 'j-stream', name: 'cc-stream', lifecycle_state: 'running' }));
    const r = await fetch(`${h.base}/dashboard/streams`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('cc-stream');
    expect(body).toContain('data-active-page="jobs"');
    expect(body).toContain('<h1 class="page-title">Jobs</h1>');
  });
});
