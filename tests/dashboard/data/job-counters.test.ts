/**
 * tests/dashboard/data/job-counters.test.ts
 *
 * Single-source counter + roster fetchers — carries forward the BOM v0.6.6
 * P2 contract from the legacy worker-counters/worker-roster tests onto the
 * job substrate (worker-dispatch Phase 3c.1 rename).
 *
 * Tests replay the 2026-05-17 E2E scenario shape (4 dispatched jobs, 3
 * clean, 1 force-killed, plus 2 May-15 zombies) and assert that all four
 * pages would now see the same counters: 0 active, 3 clean, 1
 * killed-by-operator, 2 stale.
 */
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../../../src/jobs/types.js';
import {
  fetchJobCounters,
  fetchActiveJobCount,
  formatCounterSummary,
} from '../../../src/dashboard/data/job-counters.js';
import {
  fetchActiveJobs,
  fetchHistoricJobs,
  fetchStaleJobs,
  fetchFullJobRoster,
} from '../../../src/dashboard/data/job-roster.js';

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

// The 2026-05-17 reference scenario, retargeted at JobRecord: 4 dispatched
// (3 clean, 1 force-killed) plus 2 May-15 zombies still in the DB.
const SCENARIO = [
  makeJob({
    id: 'e2e-1',
    lifecycle_state: 'completed-clean',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(8),
  }),
  makeJob({
    id: 'e2e-2',
    lifecycle_state: 'completed-clean',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(7),
  }),
  makeJob({
    id: 'e2e-3',
    lifecycle_state: 'completed-clean',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(6),
  }),
  makeJob({
    id: 'e2e-killed',
    lifecycle_state: 'killed-by-operator',
    termination_reason: 'terminated_by_user',
    ended_at: isoMinutesAgo(5),
  }),
  // May-15 zombies — running but with no fresh heartbeat → derived as stale.
  makeJob({
    id: 'oom-leak-hunt-2026-05-15',
    lifecycle_state: 'running',
    started_at: '2026-05-15T08:00:00Z',
  }),
  makeJob({
    id: 'leak-hunt-retry-a',
    lifecycle_state: 'running',
    started_at: '2026-05-15T09:00:00Z',
  }),
];

describe('fetchJobCounters (2026-05-17 E2E reference)', () => {
  it('reports 0 active — fixes the "6 active" lie', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    expect(c.active).toBe(0);
  });

  it('separates clean completion from operator-kill', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    expect(c.completed_clean).toBe(3);
    expect(c.killed_by_operator).toBe(1);
    // The two should never be conflated — that's the whole BOM premise.
    expect(c.completed_clean).not.toBe(c.killed_by_operator);
  });

  it('classifies May-15 zombies as stale, not active', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    expect(c.stale).toBe(2);
    expect(c.active).toBe(0);
  });

  it('reports total = 6 rows', () => {
    expect(fetchJobCounters(SCENARIO, NOW).total).toBe(6);
  });

  it('per-state breakdown sums to total', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    const sum = Object.values(c.byState).reduce((a, b) => a + b, 0);
    expect(sum).toBe(c.total);
  });
});

describe('fetchActiveJobCount (allocation-light path)', () => {
  it('matches the .active field from fetchJobCounters', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    expect(fetchActiveJobCount(SCENARIO, NOW)).toBe(c.active);
  });

  it('counts a dispatched job as active', () => {
    const j = [makeJob({ id: 'x', lifecycle_state: 'dispatched' })];
    expect(fetchActiveJobCount(j, NOW)).toBe(1);
  });
});

describe('formatCounterSummary', () => {
  it('shows lifetime AND current distinctly per BOM hard rule #5', () => {
    const c = fetchJobCounters(SCENARIO, NOW);
    const s = formatCounterSummary(c);
    // The summary should not be a single bare number.
    expect(s).toMatch(/active/);
    expect(s).toMatch(/completed/);
    // Force-killed job present -> should mention terminated
    expect(s).toMatch(/terminated/);
    // Stale jobs present -> should mention stale
    expect(s).toMatch(/stale/);
  });

  it('omits sections that are zero (steady state stays tidy)', () => {
    const cleanOnly = [
      makeJob({
        id: 'c',
        lifecycle_state: 'completed-clean',
        termination_reason: 'completed',
        exit_code: 0,
      }),
    ];
    const c = fetchJobCounters(cleanOnly, NOW);
    const s = formatCounterSummary(c);
    expect(s).not.toMatch(/crashed/);
    expect(s).not.toMatch(/terminated/);
    expect(s).not.toMatch(/stale/);
  });
});

describe('roster fetchers slice consistently across pages', () => {
  it('fetchActiveJobs returns 0 entries for the E2E scenario', () => {
    expect(fetchActiveJobs(SCENARIO, { now: NOW })).toEqual([]);
  });

  it('fetchHistoricJobs returns the 4 E2E terminations (within 24h)', () => {
    const h = fetchHistoricJobs(SCENARIO, { now: NOW });
    expect(h).toHaveLength(4);
    expect(h.map((e) => e.job.id).sort()).toEqual(
      ['e2e-1', 'e2e-2', 'e2e-3', 'e2e-killed'].sort(),
    );
  });

  it('fetchHistoricJobs excludes anything older than maxAgeMs', () => {
    const tight = fetchHistoricJobs(SCENARIO, { now: NOW, maxAgeMs: 60 * 1000 });
    expect(tight).toHaveLength(0);
  });

  it('fetchStaleJobs surfaces the 2 May-15 zombies', () => {
    const s = fetchStaleJobs(SCENARIO, { now: NOW });
    expect(s).toHaveLength(2);
  });

  it('fetchFullJobRoster groups active / stale / historic without overlap', () => {
    const r = fetchFullJobRoster(SCENARIO, { now: NOW });
    const ids = new Set<string>();
    for (const e of [...r.active, ...r.stale, ...r.historic]) {
      expect(ids.has(e.job.id)).toBe(false);
      ids.add(e.job.id);
    }
    expect(r.active).toHaveLength(0);
    expect(r.stale).toHaveLength(2);
    expect(r.historic).toHaveLength(4);
  });

  it('limit option caps each bucket independently', () => {
    const r = fetchFullJobRoster(SCENARIO, { now: NOW, limit: 1 });
    expect(r.historic.length).toBeLessThanOrEqual(1);
    expect(r.stale.length).toBeLessThanOrEqual(1);
  });
});

describe('cross-page agreement (the whole point of P2)', () => {
  it('Helm count == Topology count == Diagnostics count', () => {
    // All three would read fetchActiveJobCount over the same input.
    const helmCount = fetchActiveJobCount(SCENARIO, NOW);
    const topologyCount = fetchActiveJobCount(SCENARIO, NOW);
    const diagnosticsCount = fetchActiveJobCount(SCENARIO, NOW);
    expect(helmCount).toBe(topologyCount);
    expect(topologyCount).toBe(diagnosticsCount);
  });
});
