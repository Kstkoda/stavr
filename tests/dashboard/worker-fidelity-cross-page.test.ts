/**
 * tests/dashboard/worker-fidelity-cross-page.test.ts
 *
 * BOM v0.6.6 P3 acceptance — Helm L2, Topology header, and Diagnostics
 * Workers section MUST agree on the active count, against the same
 * underlying WorkerRecord[].
 *
 * The 2026-05-17 lie ("6 active when 0 were running") could not happen
 * if every page read from the same fetcher. This test asserts that.
 */
import { describe, expect, it } from 'vitest';
import type { WorkerRecord } from '../../src/persistence.js';
import { renderHelmPage } from '../../src/dashboard/pages/helm.js';
import { renderTopologyPage } from '../../src/dashboard/pages/topology.js';
import { renderDiagnosticsPage } from '../../src/dashboard/pages/diagnostics.js';
import { renderStreamsPage } from '../../src/dashboard/pages/streams.js';
import {
  fetchWorkerCounters,
  fetchActiveWorkerCount,
} from '../../src/dashboard/data/worker-counters.js';
import { deriveLifecycleState } from '../../src/workers/lifecycle.js';

const NOW = Date.parse('2026-05-17T22:00:00Z');

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function makeWorker(partial: Partial<WorkerRecord> & { id: string }): WorkerRecord {
  return {
    id: partial.id,
    name: partial.id,
    type: partial.type ?? 'shell',
    cwd: partial.cwd ?? '/tmp',
    status: partial.status ?? 'running',
    started_at: partial.started_at ?? isoMinutesAgo(10),
    ended_at: partial.ended_at,
    last_activity_at: partial.last_activity_at,
    metadata: {},
    spawn_params_hash: 'h',
    termination_reason: partial.termination_reason,
    exit_code: partial.exit_code,
    lifecycle_state: partial.lifecycle_state,
  };
}

// The 2026-05-17 reference scenario.
const E2E_WORKERS = [
  makeWorker({ id: 'e2e-1', status: 'terminated', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(8) }),
  makeWorker({ id: 'e2e-2', status: 'terminated', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(7) }),
  makeWorker({ id: 'e2e-3', status: 'terminated', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(6) }),
  makeWorker({ id: 'e2e-killed', status: 'terminated', termination_reason: 'terminated_by_user', ended_at: isoMinutesAgo(5) }),
  makeWorker({ id: 'oom-leak-hunt-2026-05-15', status: 'idle', started_at: '2026-05-15T08:00:00Z' }),
  makeWorker({ id: 'leak-hunt-retry-a', status: 'idle', started_at: '2026-05-15T09:00:00Z' }),
];

// One healthy active worker for the contrast case.
const HEALTHY = makeWorker({
  id: 'alive-1',
  status: 'running',
  last_activity_at: isoMinutesAgo(0.5),
});

describe('cross-page agreement on active count (BOM v0.6.6 P3 acceptance)', () => {
  it('Helm L2 + Topology header + Diagnostics workers panel all read 0 active for the E2E scenario', () => {
    const expected = fetchActiveWorkerCount(E2E_WORKERS);
    expect(expected).toBe(0);

    // Build per-page snapshots from the SAME WorkerRecord[]. If any page
    // disagrees with `expected`, that's the lie BOM v0.6.6 set out to fix.
    const counters = fetchWorkerCounters(E2E_WORKERS);
    const helmHtml = renderHelmPage({
      intent: { summary: '', sub: '' },
      health: { ok: true, version: '0', port: 0, started_at: '', uptime_sec: 0, profile_mode: 'eco', event_count: 0, active_scopes: 0 },
      boms: { recent: [], total: 0, open: 0 },
      decisions: { recent: [], open: 0 },
      workers: E2E_WORKERS.map((w) => ({
        id: w.id,
        type: w.type,
        status: 'idle' as const,
        lifecycle_state: deriveLifecycleState(w),
      })),
      worker_counters: {
        active: counters.active,
        completed: counters.completed_clean + counters.completed_error,
        crashed: counters.crashed + counters.killed_by_system,
        killed_by_operator: counters.killed_by_operator,
        stale: counters.stale,
        total: counters.total,
      },
      systems: [],
    });

    const topoHtml = renderTopologyPage({
      workers: E2E_WORKERS,
      bricks: [],
      scopes: [],
      inFlightBoms: [],
    });

    const diagHtml = renderDiagnosticsPage({
      workers: E2E_WORKERS,
      bricks: [],
    });

    // Helm L2 primary "active" reads 0
    expect(helmHtml).toMatch(/0 active/);
    // Topology header reads 0 active (with lifetime gap visible)
    expect(topoHtml).toMatch(/0 active/);
    expect(topoHtml).toMatch(/6 lifetime/);
    // Diagnostics workers section reads 0 active + 6 lifetime
    expect(diagHtml).toMatch(/0 active.*6 lifetime/);
  });

  it('a single healthy worker is counted as 1 active on every page', () => {
    const ws = [HEALTHY];
    const expected = fetchActiveWorkerCount(ws);
    expect(expected).toBe(1);

    const counters = fetchWorkerCounters(ws);
    const helmHtml = renderHelmPage({
      intent: { summary: '', sub: '' },
      health: { ok: true, version: '0', port: 0, started_at: '', uptime_sec: 0, profile_mode: 'eco', event_count: 0, active_scopes: 0 },
      boms: { recent: [], total: 0, open: 0 },
      decisions: { recent: [], open: 0 },
      workers: [{ id: HEALTHY.id, type: HEALTHY.type, status: 'running', lifecycle_state: 'running' }],
      worker_counters: {
        active: counters.active,
        completed: 0, crashed: 0, killed_by_operator: 0, stale: 0, total: counters.total,
      },
      systems: [],
    });
    const topoHtml = renderTopologyPage({ workers: ws, bricks: [], scopes: [], inFlightBoms: [] });
    const diagHtml = renderDiagnosticsPage({ workers: ws, bricks: [] });

    expect(helmHtml).toMatch(/1 active/);
    expect(topoHtml).toMatch(/1 worker active/);
    expect(diagHtml).toMatch(/1 active/);
  });

  it('Streams primary view filters historic panes to a History details section', () => {
    const html = renderStreamsPage({
      workers: E2E_WORKERS,
      recent: {},
    });
    // No active workers => primary grid shows the empty-state copy.
    expect(html).toMatch(/No workers running/);
    // Historic panes get a collapsible block.
    expect(html).toMatch(/streams-history/);
    expect(html).toMatch(/History · 6 panes/);
  });

  it('Topology roster pill text reads the lifecycle label (operator-kill is distinct from crashed)', () => {
    const html = renderTopologyPage({
      workers: [
        makeWorker({
          id: 'op-killed',
          status: 'terminated',
          termination_reason: 'terminated_by_user',
          ended_at: isoMinutesAgo(2),
        }),
        makeWorker({
          id: 'really-crashed',
          status: 'crashed',
          termination_reason: 'crashed',
          exit_code: 137,
          ended_at: isoMinutesAgo(2),
        }),
      ],
      bricks: [],
      scopes: [],
      inFlightBoms: [],
    });
    // The two rows MUST be visually distinguishable.
    expect(html).toMatch(/killed by operator/);
    expect(html).toMatch(/data-lifecycle="killed-by-operator"/);
    expect(html).toMatch(/data-lifecycle="crashed"/);
  });
});
