/**
 * Job lifecycle state — the 8-state enum the BOM keeps from
 * src/workers/lifecycle.ts (recon §1: "rename in place, no semantic change").
 *
 * Phase 1 carries the enum forward as `JobLifecycleState` over the new
 * JobRecord. The worker module stays as-is during the cutover window; Phase 3
 * deletes it once nothing reads the workers table.
 *
 *   dispatched         → request accepted, binding.dispatch() not yet returned
 *   running            → binding handle live, no exit yet
 *   completed-clean    → exited 0 of its own accord
 *   completed-error    → exited non-zero of its own accord
 *   killed-by-operator → operator issued terminate
 *   killed-by-system   → OOM / AV / OS-level kill (heuristic)
 *   crashed            → exit code non-zero AND not killed
 *   stale              → last_activity_at older than threshold, no exit
 *
 * Note vs the worker enum: we add `dispatched` (the pre-binding-return state
 * — the BOM names the job lifecycle as "dispatched → running → ..."). The
 * worker enum's `starting` is a synonym; we keep `dispatched` because the
 * BOM uses that word.
 */

export type JobLifecycleState =
  | 'dispatched'
  | 'running'
  | 'completed-clean'
  | 'completed-error'
  | 'killed-by-operator'
  | 'killed-by-system'
  | 'crashed'
  | 'stale';

export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h — same as worker

const VALID_STATES: ReadonlySet<JobLifecycleState> = new Set<JobLifecycleState>([
  'dispatched',
  'running',
  'completed-clean',
  'completed-error',
  'killed-by-operator',
  'killed-by-system',
  'crashed',
  'stale',
]);

export function isValidJobLifecycleState(s: string): s is JobLifecycleState {
  return VALID_STATES.has(s as JobLifecycleState);
}

export function isCurrentlyActive(state: JobLifecycleState): boolean {
  return state === 'dispatched' || state === 'running';
}

export function isHistoric(state: JobLifecycleState): boolean {
  return !isCurrentlyActive(state) && state !== 'stale';
}
