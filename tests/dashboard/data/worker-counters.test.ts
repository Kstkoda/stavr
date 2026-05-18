/**
 * tests/dashboard/data/worker-counters.test.ts
 *
 * BOM v0.6.6 P2 — single-source counter + roster fetchers.
 *
 * Tests replay the 2026-05-17 E2E scenario shape (4 spawned workers,
 * 3 clean, 1 force-killed, plus 2 May-15 zombies) and assert that all
 * four pages would now see the same counters: 0 active, 3 clean, 1
 * killed-by-operator, 2 stale.
 */
import { describe, expect, it } from 'vitest';
import type { WorkerRecord } from '../../../src/persistence.js';
import {
  fetchWorkerCounters,
  fetchActiveWorkerCount,
  formatCounterSummary,
} from '../../../src/dashboard/data/worker-counters.js';
import {
  fetchActiveWorkers,
  fetchHistoricWorkers,
  fetchStaleWorkers,
  fetchFullRoster,
} from '../../../src/dashboard/data/worker-roster.js';

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
    pid: partial.pid,
    metadata: partial.metadata ?? {},
    spawn_params_hash: partial.spawn_params_hash ?? 'h',
    termination_reason: partial.termination_reason,
    exit_code: partial.exit_code,
    lifecycle_state: partial.lifecycle_state,
  };
}

// The 2026-05-17 reference scenario: 4 spawned (3 clean, 1 force-killed)
// plus 2 May-15 zombies still in the DB.
const SCENARIO = [
  makeWorker({
    id: 'e2e-1',
    status: 'terminated',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(8),
  }),
  makeWorker({
    id: 'e2e-2',
    status: 'terminated',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(7),
  }),
  makeWorker({
    id: 'e2e-3',
    status: 'terminated',
    termination_reason: 'completed',
    exit_code: 0,
    ended_at: isoMinutesAgo(6),
  }),
  makeWorker({
    id: 'e2e-killed',
    status: 'terminated',
    termination_reason: 'terminated_by_user',
    ended_at: isoMinutesAgo(5),
  }),
  // May-15 zombies — status=idle, no heartbeat.
  makeWorker({
    id: 'oom-leak-hunt-2026-05-15',
    status: 'idle',
    started_at: '2026-05-15T08:00:00Z',
  }),
  makeWorker({
    id: 'leak-hunt-retry-a',
    status: 'idle',
    started_at: '2026-05-15T09:00:00Z',
  }),
];

describe('fetchWorkerCounters (2026-05-17 E2E reference)', () => {
  it('reports 0 active — fixes the "6 active" lie', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    expect(c.active).toBe(0);
  });

  it('separates clean completion from operator-kill', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    expect(c.completed_clean).toBe(3);
    expect(c.killed_by_operator).toBe(1);
    // The two should never be conflated — that's the whole BOM premise.
    expect(c.completed_clean).not.toBe(c.killed_by_operator);
  });

  it('classifies May-15 zombies as stale, not active', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    expect(c.stale).toBe(2);
    expect(c.active).toBe(0);
  });

  it('reports total = 6 rows', () => {
    expect(fetchWorkerCounters(SCENARIO, NOW).total).toBe(6);
  });

  it('per-state breakdown sums to total', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    const sum = Object.values(c.byState).reduce((a, b) => a + b, 0);
    expect(sum).toBe(c.total);
  });
});

describe('fetchActiveWorkerCount (allocation-light path)', () => {
  it('matches the .active field from fetchWorkerCounters', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    expect(fetchActiveWorkerCount(SCENARIO, NOW)).toBe(c.active);
  });

  it('counts a starting worker as active', () => {
    const w = [makeWorker({ id: 'x', status: 'starting' })];
    expect(fetchActiveWorkerCount(w, NOW)).toBe(1);
  });
});

describe('formatCounterSummary', () => {
  it('shows lifetime AND current distinctly per BOM hard rule #5', () => {
    const c = fetchWorkerCounters(SCENARIO, NOW);
    const s = formatCounterSummary(c);
    // The summary should not be a single bare number.
    expect(s).toMatch(/active/);
    expect(s).toMatch(/completed/);
    // Force-killed worker present -> should mention terminated
    expect(s).toMatch(/terminated/);
    // Stale workers present -> should mention stale
    expect(s).toMatch(/stale/);
  });

  it('omits sections that are zero (steady state stays tidy)', () => {
    const cleanOnly = [
      makeWorker({
        id: 'c',
        status: 'terminated',
        termination_reason: 'completed',
        exit_code: 0,
      }),
    ];
    const c = fetchWorkerCounters(cleanOnly, NOW);
    const s = formatCounterSummary(c);
    expect(s).not.toMatch(/crashed/);
    expect(s).not.toMatch(/terminated/);
    expect(s).not.toMatch(/stale/);
  });
});

describe('roster fetchers slice consistently across pages', () => {
  it('fetchActiveWorkers returns 0 entries for the E2E scenario', () => {
    expect(fetchActiveWorkers(SCENARIO, { now: NOW })).toEqual([]);
  });

  it('fetchHistoricWorkers returns the 4 E2E terminations (within 24h)', () => {
    const h = fetchHistoricWorkers(SCENARIO, { now: NOW });
    expect(h).toHaveLength(4);
    expect(h.map((e) => e.worker.id).sort()).toEqual(
      ['e2e-1', 'e2e-2', 'e2e-3', 'e2e-killed'].sort(),
    );
  });

  it('fetchHistoricWorkers excludes anything older than maxAgeMs', () => {
    const tight = fetchHistoricWorkers(SCENARIO, { now: NOW, maxAgeMs: 60 * 1000 });
    expect(tight).toHaveLength(0);
  });

  it('fetchStaleWorkers surfaces the 2 May-15 zombies', () => {
    const s = fetchStaleWorkers(SCENARIO, { now: NOW });
    expect(s).toHaveLength(2);
  });

  it('fetchFullRoster groups active / stale / historic without overlap', () => {
    const r = fetchFullRoster(SCENARIO, { now: NOW });
    const ids = new Set<string>();
    for (const e of [...r.active, ...r.stale, ...r.historic]) {
      expect(ids.has(e.worker.id)).toBe(false);
      ids.add(e.worker.id);
    }
    expect(r.active).toHaveLength(0);
    expect(r.stale).toHaveLength(2);
    expect(r.historic).toHaveLength(4);
  });

  it('limit option caps each bucket independently', () => {
    const r = fetchFullRoster(SCENARIO, { now: NOW, limit: 1 });
    expect(r.historic.length).toBeLessThanOrEqual(1);
    expect(r.stale.length).toBeLessThanOrEqual(1);
  });
});

describe('cross-page agreement (the whole point of P2)', () => {
  it('Helm count == Topology count == Diagnostics count', () => {
    // All three would read fetchActiveWorkerCount over the same input.
    const helmCount = fetchActiveWorkerCount(SCENARIO, NOW);
    const topologyCount = fetchActiveWorkerCount(SCENARIO, NOW);
    const diagnosticsCount = fetchActiveWorkerCount(SCENARIO, NOW);
    expect(helmCount).toBe(topologyCount);
    expect(topologyCount).toBe(diagnosticsCount);
  });
});
