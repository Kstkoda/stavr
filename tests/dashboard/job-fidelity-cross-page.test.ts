/**
 * tests/dashboard/job-fidelity-cross-page.test.ts
 *
 * BOM v0.6.6 P3 acceptance, carried forward to the job substrate — Helm L2,
 * Topology header, and Diagnostics Jobs section MUST agree on the active
 * count, against the same underlying JobRecord[].
 *
 * The 2026-05-17 lie ("6 active when 0 were running") could not happen if
 * every page read from the same fetcher. This test asserts that.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../src/jobs/types.js';
import { renderHelmPage } from '../../src/dashboard/pages/helm.js';
import { renderTopologyPage } from '../../src/dashboard/pages/topology.js';
import { renderDiagnosticsPage } from '../../src/dashboard/pages/diagnostics.js';
import { renderJobsPage } from '../../src/dashboard/pages/jobs.js';
import {
  fetchJobCounters,
  fetchActiveJobCount,
} from '../../src/dashboard/data/job-counters.js';
import { deriveLifecycleState } from '../../src/jobs/lifecycle.js';

const NOW = Date.parse('2026-05-17T22:00:00Z');

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function makeJob(partial: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    binding_kind: partial.binding_kind ?? 'process-spawn',
    binding_target: partial.binding_target ?? 'shell',
    params_hash: partial.params_hash ?? 'h',
    lifecycle_state: partial.lifecycle_state ?? 'running',
    started_at: partial.started_at ?? isoMinutesAgo(10),
    ended_at: partial.ended_at,
    last_activity_at: partial.last_activity_at,
    metadata: partial.metadata ?? {},
    termination_reason: partial.termination_reason,
    exit_code: partial.exit_code,
  };
}

// The 2026-05-17 reference scenario, retargeted at JobRecord.
const E2E_JOBS = [
  makeJob({ id: 'e2e-1', lifecycle_state: 'completed-clean', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(8) }),
  makeJob({ id: 'e2e-2', lifecycle_state: 'completed-clean', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(7) }),
  makeJob({ id: 'e2e-3', lifecycle_state: 'completed-clean', termination_reason: 'completed', exit_code: 0, ended_at: isoMinutesAgo(6) }),
  makeJob({ id: 'e2e-killed', lifecycle_state: 'killed-by-operator', termination_reason: 'terminated_by_user', ended_at: isoMinutesAgo(5) }),
  // Two May-15 zombies — without a fresh heartbeat, derivation classifies
  // them as `stale`.
  makeJob({ id: 'oom-leak-hunt-2026-05-15', lifecycle_state: 'running', started_at: '2026-05-15T08:00:00Z' }),
  makeJob({ id: 'leak-hunt-retry-a', lifecycle_state: 'running', started_at: '2026-05-15T09:00:00Z' }),
];

// One healthy active job for the contrast case.
const HEALTHY = makeJob({
  id: 'alive-1',
  lifecycle_state: 'running',
  last_activity_at: isoMinutesAgo(0.5),
});

describe('cross-page agreement on active count (BOM v0.6.6 P3 acceptance — job substrate)', () => {
  // Pin the clock to NOW so derivation classifies jobs consistently
  // regardless of when CI actually runs the suite.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('Helm L2 + Topology header + Diagnostics jobs panel all read 0 active for the E2E scenario', () => {
    const expected = fetchActiveJobCount(E2E_JOBS);
    expect(expected).toBe(0);

    // Build per-page snapshots from the SAME JobRecord[]. If any page
    // disagrees with `expected`, that's the lie BOM v0.6.6 set out to fix.
    const counters = fetchJobCounters(E2E_JOBS);
    const helmHtml = renderHelmPage({
      intent: { summary: '', sub: '' },
      health: { ok: true, version: '0', port: 0, started_at: '', uptime_sec: 0, profile_mode: 'eco', event_count: 0, active_scopes: 0 },
      boms: { recent: [], total: 0, open: 0 },
      decisions: { recent: [], open: 0 },
      jobs: E2E_JOBS.map((j) => ({
        id: j.id,
        binding_kind: j.binding_kind,
        binding_target: j.binding_target,
        status: 'idle' as const,
        lifecycle_state: deriveLifecycleState(j),
      })),
      job_counters: {
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
      jobs: E2E_JOBS,
      bricks: [],
      scopes: [],
      inFlightBoms: [],
    });

    const diagHtml = renderDiagnosticsPage({
      jobs: E2E_JOBS,
      bricks: [],
    });

    // Helm L2 primary "active" reads 0
    expect(helmHtml).toMatch(/0 active/);
    // Topology header reads 0 active (with lifetime gap visible)
    expect(topoHtml).toMatch(/0 active/);
    expect(topoHtml).toMatch(/6 lifetime/);
    // Diagnostics jobs section reads 0 active + 6 lifetime
    expect(diagHtml).toMatch(/0 active.*6 lifetime/);
  });

  it('a single healthy job is counted as 1 active on every page', () => {
    const js = [HEALTHY];
    const expected = fetchActiveJobCount(js);
    expect(expected).toBe(1);

    const counters = fetchJobCounters(js);
    const helmHtml = renderHelmPage({
      intent: { summary: '', sub: '' },
      health: { ok: true, version: '0', port: 0, started_at: '', uptime_sec: 0, profile_mode: 'eco', event_count: 0, active_scopes: 0 },
      boms: { recent: [], total: 0, open: 0 },
      decisions: { recent: [], open: 0 },
      jobs: [{
        id: HEALTHY.id,
        binding_kind: HEALTHY.binding_kind,
        binding_target: HEALTHY.binding_target,
        status: 'running',
        lifecycle_state: 'running',
      }],
      job_counters: {
        active: counters.active,
        completed: 0, crashed: 0, killed_by_operator: 0, stale: 0, total: counters.total,
      },
      systems: [],
    });
    const topoHtml = renderTopologyPage({ jobs: js, bricks: [], scopes: [], inFlightBoms: [] });
    const diagHtml = renderDiagnosticsPage({ jobs: js, bricks: [] });

    expect(helmHtml).toMatch(/1 active/);
    expect(topoHtml).toMatch(/1 job active/);
    expect(diagHtml).toMatch(/1 active/);
  });

  it('Jobs primary view filters historic panes to a 24h History details section', () => {
    const html = renderJobsPage({
      jobs: E2E_JOBS,
      recent: {},
    });
    // No active jobs => primary grid shows the empty-state copy.
    expect(html).toMatch(/No jobs running/);
    // Historic panes get a collapsible block. The two May-15 zombies are
    // outside the 24h window (NOW = 2026-05-17T22:00:00Z) so they fall
    // off the Jobs page; only the four recently-ended e2e-* runs remain.
    expect(html).toMatch(/jobs-history/);
    expect(html).toMatch(/History · last 24h · 4 panes/);
    expect(html).not.toMatch(/oom-leak-hunt-2026-05-15/);
    expect(html).not.toMatch(/leak-hunt-retry-a/);
    // The "older runs" link to /dashboard/history covers the dropped ones.
    expect(html).toContain('/dashboard/history');
  });

  it('Topology canvas hides historic jobs older than 24h + surfaces a Show terminated toggle', () => {
    // BOM v0.6.6 P4 acceptance: with 0 active jobs and 2 May-15 zombies,
    // the canvas should NOT render the zombies and should expose a toggle
    // for them.
    const html = renderTopologyPage({
      jobs: E2E_JOBS, // includes the 2 May-15 zombies
      bricks: [],
      scopes: [],
      inFlightBoms: [],
    });
    expect(html).not.toContain('data-id="oom-leak-hunt-2026-05-15"');
    expect(html).not.toContain('data-id="leak-hunt-retry-a"');
    // The toggle MUST surface their existence.
    expect(html).toMatch(/Show terminated \(2\)/);
  });

  it('Jobs roster pill text reads the lifecycle label (operator-kill is distinct from crashed)', () => {
    // Per CLAUDE.md §1 — tests are derivative of the spec.
    const html = renderJobsPage({
      jobs: [
        makeJob({
          id: 'op-killed',
          lifecycle_state: 'killed-by-operator',
          termination_reason: 'terminated_by_user',
          ended_at: isoMinutesAgo(2),
        }),
        makeJob({
          id: 'really-crashed',
          lifecycle_state: 'crashed',
          termination_reason: 'crashed',
          exit_code: 137,
          ended_at: isoMinutesAgo(2),
        }),
      ],
      recent: {},
    });
    // The two rows MUST be visually distinguishable.
    expect(html).toMatch(/killed by operator/);
    expect(html).toMatch(/data-lifecycle="killed-by-operator"/);
    expect(html).toMatch(/data-lifecycle="crashed"/);
  });
});
