/**
 * src/dashboard/data/worker-counters.ts
 *
 * Single source of truth for worker counts across Helm, Topology, Workers,
 * and Diagnostics. Every page that wants to display a worker count MUST
 * read from `fetchWorkerCounters` here, not roll its own filter from
 * WorkerRecord[].
 *
 * BOM v0.6.6 hard rule #4: no page-specific definition of "active". The
 * 2026-05-17 lie ("6 active" when 0 were running) lived in the gap
 * between four pages each interpreting status differently. This module
 * closes that gap.
 *
 * The roster sibling (`worker-roster.ts`) handles per-page slicing and
 * paginating; this file is just counts.
 */
import type { WorkerRecord } from '../../persistence.js';
import {
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  type LifecycleState,
} from '../../workers/lifecycle.js';

export interface WorkerCounters {
  /**
   * Currently-active = `starting` or `running`. The number an operator
   * cares about when asking "what's the daemon doing right now?".
   */
  active: number;
  /** Cleanly-completed (exit 0) over the lifetime of this DB. */
  completed_clean: number;
  /** Completed with non-zero exit code. */
  completed_error: number;
  /** Operator pressed Terminate. Distinct from `crashed` per BOM rule #6. */
  killed_by_operator: number;
  /** OS-level kill (OOM, AV). v0.6.7 will populate this; today usually 0. */
  killed_by_system: number;
  /** Crashed (non-zero exit AND not operator-killed). */
  crashed: number;
  /** Has no heartbeat / old heartbeat AND no exit recorded yet. */
  stale: number;
  /** Total rows in the workers table (all lifecycle states). */
  total: number;
}

/**
 * Per-state breakdown — handy for callers that want to iterate without
 * branching on every field. Maps every LifecycleState to its count.
 */
export type WorkerCountersByState = Readonly<Record<LifecycleState, number>>;

/**
 * Compute lifetime counts plus the per-state breakdown.
 *
 * `now` is parameterised so callers (and tests) can pass a stable clock.
 * Defaults to Date.now(); production callers pass undefined.
 */
export function fetchWorkerCounters(
  workers: readonly WorkerRecord[],
  now: number = Date.now(),
): WorkerCounters & { byState: WorkerCountersByState } {
  const byState: Record<LifecycleState, number> = {
    'starting': 0,
    'running': 0,
    'completed-clean': 0,
    'completed-error': 0,
    'killed-by-operator': 0,
    'killed-by-system': 0,
    'crashed': 0,
    'stale': 0,
  };
  for (const w of workers) {
    const s = deriveLifecycleState(w, now);
    byState[s] += 1;
  }
  return {
    active: byState['starting'] + byState['running'],
    completed_clean: byState['completed-clean'],
    completed_error: byState['completed-error'],
    killed_by_operator: byState['killed-by-operator'],
    killed_by_system: byState['killed-by-system'],
    crashed: byState['crashed'],
    stale: byState['stale'],
    total: workers.length,
    byState,
  };
}

/**
 * The currently-active count, by itself. Equivalent to
 * `fetchWorkerCounters(ws).active` but doesn't allocate the breakdown
 * object — handy for the topbar polling path where this gets called
 * frequently.
 */
export function fetchActiveWorkerCount(
  workers: readonly WorkerRecord[],
  now: number = Date.now(),
): number {
  let n = 0;
  for (const w of workers) {
    if (isCurrentlyActive(deriveLifecycleState(w, now))) n += 1;
  }
  return n;
}

/**
 * Compact human-readable counter string used in headers and chip labels.
 * Format: "0 active · 7 completed · 1 crashed" with optional " · N stale"
 * appended when any stale workers exist (so the operator knows there are
 * orphaned rows to deal with, but stale doesn't pollute the steady state).
 *
 * BOM hard rule #5: never display a single number that conflates lifetime
 * vs current. This helper is the canonical compact form.
 */
export function formatCounterSummary(counters: WorkerCounters): string {
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
