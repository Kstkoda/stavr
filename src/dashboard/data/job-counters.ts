/**
 * src/dashboard/data/job-counters.ts
 *
 * Single source of truth for job counts across Helm, Topology, Jobs, and
 * Diagnostics. Every page that wants to display a job count MUST read from
 * `fetchJobCounters` here, not roll its own filter from JobRecord[].
 *
 * Carries forward BOM v0.6.6 hard rule #4 (no page-specific definition of
 * "active") from the legacy worker-counters module — the 2026-05-17 lie
 * ("6 active" when 0 were running) lived in the gap between four pages
 * each interpreting status differently. Same closure, JobRecord-shaped.
 *
 * The roster sibling (`job-roster.ts`) handles per-page slicing and
 * paginating; this file is just counts.
 */
import type { JobRecord } from '../../jobs/types.js';
import {
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  type JobLifecycleState,
} from '../../jobs/lifecycle.js';

export interface JobCounters {
  /**
   * Currently-active = `dispatched` or `running`. The number an operator
   * cares about when asking "what's the daemon doing right now?".
   */
  active: number;
  /** Cleanly-completed (exit 0) over the lifetime of this DB. */
  completed_clean: number;
  /** Completed with non-zero exit code. */
  completed_error: number;
  /** Operator pressed Terminate. Distinct from `crashed` per BOM rule #6. */
  killed_by_operator: number;
  /** OS-level kill (OOM, AV). Populated when the binding's failure path
   *  fires the right termination_reason. */
  killed_by_system: number;
  /** Crashed (non-zero exit AND not operator-killed). */
  crashed: number;
  /** Has no heartbeat / old heartbeat AND no exit recorded yet. */
  stale: number;
  /** Total rows in the jobs table (all lifecycle states). */
  total: number;
}

/**
 * Per-state breakdown — handy for callers that want to iterate without
 * branching on every field. Maps every JobLifecycleState to its count.
 */
export type JobCountersByState = Readonly<Record<JobLifecycleState, number>>;

/**
 * Compute lifetime counts plus the per-state breakdown.
 *
 * `now` is parameterised so callers (and tests) can pass a stable clock.
 * Defaults to Date.now(); production callers pass undefined.
 */
export function fetchJobCounters(
  jobs: readonly JobRecord[],
  now: number = Date.now(),
): JobCounters & { byState: JobCountersByState } {
  const byState: Record<JobLifecycleState, number> = {
    'dispatched': 0,
    'running': 0,
    'completed-clean': 0,
    'completed-error': 0,
    'killed-by-operator': 0,
    'killed-by-system': 0,
    'crashed': 0,
    'stale': 0,
  };
  for (const j of jobs) {
    const s = deriveLifecycleState(j, now);
    byState[s] += 1;
  }
  return {
    active: byState['dispatched'] + byState['running'],
    completed_clean: byState['completed-clean'],
    completed_error: byState['completed-error'],
    killed_by_operator: byState['killed-by-operator'],
    killed_by_system: byState['killed-by-system'],
    crashed: byState['crashed'],
    stale: byState['stale'],
    total: jobs.length,
    byState,
  };
}

/**
 * The currently-active count, by itself. Equivalent to
 * `fetchJobCounters(jobs).active` but doesn't allocate the breakdown
 * object — handy for the topbar polling path where this gets called
 * frequently.
 */
export function fetchActiveJobCount(
  jobs: readonly JobRecord[],
  now: number = Date.now(),
): number {
  let n = 0;
  for (const j of jobs) {
    if (isCurrentlyActive(deriveLifecycleState(j, now))) n += 1;
  }
  return n;
}

/**
 * Compact human-readable counter string used in headers and chip labels.
 * Format: "0 active · 7 completed · 1 crashed" with optional " · N stale"
 * appended when any stale jobs exist (so the operator knows there are
 * orphaned rows to deal with, but stale doesn't pollute the steady state).
 *
 * BOM hard rule #5: never display a single number that conflates lifetime
 * vs current. This helper is the canonical compact form.
 */
export function formatCounterSummary(counters: JobCounters): string {
  const completed = counters.completed_clean + counters.completed_error;
  const failed = counters.crashed + counters.killed_by_system;
  const parts: string[] = [
    `${counters.active} active`,
    `${completed} completed`,
  ];
  if (failed > 0) parts.push(`${failed} crashed`);
  if (counters.killed_by_operator > 0) parts.push(`${counters.killed_by_operator} terminated`);
  if (counters.stale > 0) parts.push(`${counters.stale} stale`);
  return parts.join(' · ');
}

// Re-export helpers callers commonly need so they don't have to deep-import
// across module boundaries.
export { isCurrentlyActive, isHistoric };
