/**
 * Job lifecycle state — the 8-state enum the BOM keeps from
 * src/workers/lifecycle.ts (recon §1: "rename in place, no semantic change").
 *
 * Phase 1 carried the enum forward as `JobLifecycleState` over the new
 * JobRecord. Phase 3c.1 lifts the dashboard's derivation + halo + label
 * helpers from src/workers/lifecycle.ts onto JobRecord here so the
 * dashboard data layer can drop the cross-package import.
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

/**
 * Threshold beyond which a job without exit info is classified as `stale`.
 * Mirrors src/workers/lifecycle.ts STALE_THRESHOLD_MS — 1h was tuned for
 * worker spawns and carries to jobs unchanged.
 */
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

/**
 * Slim derivation input — accepts either a full JobRecord or a slim shape
 * with just the fields the helper needs. The job orchestrator writes
 * `lifecycle_state` authoritatively, so derivation here is mostly a
 * stale-detection shim for the running/dispatched case.
 */
export interface JobLifecycleInput {
  lifecycle_state?: JobLifecycleState | string | null;
  last_activity_at?: string;
  started_at?: string;
}

/**
 * Resolve a job's lifecycle state. The orchestrator writes `lifecycle_state`
 * authoritatively, so we trust it when present and well-formed. The one
 * exception is `running`/`dispatched` with an aged heartbeat — stale-
 * detection lives at the read path so a daemon crash between the watchdog
 * tick and the next render still reports the right bucket.
 *
 * Stale criteria (carried forward from src/workers/lifecycle.ts):
 *   1. last_activity_at present AND older than STALE_THRESHOLD_MS → stale
 *   2. last_activity_at MISSING AND started_at older than STALE_THRESHOLD_MS
 *      → stale (the May-15 zombie shape: claims to be running, never sent
 *      a heartbeat, and the process was started a long time ago)
 */
export function deriveLifecycleState(
  input: JobLifecycleInput,
  now: number = Date.now(),
): JobLifecycleState {
  const raw = input.lifecycle_state;
  let state: JobLifecycleState = 'running';
  if (typeof raw === 'string' && isValidJobLifecycleState(raw)) {
    state = raw;
  }
  if (state === 'running' || state === 'dispatched') {
    if (input.last_activity_at) {
      const age = now - Date.parse(input.last_activity_at);
      if (Number.isFinite(age) && age > STALE_THRESHOLD_MS) return 'stale';
    } else if (input.started_at) {
      // No heartbeat ever recorded — fall back to started_at. A fresh job
      // that hasn't sent its first heartbeat yet still reads as
      // running/dispatched; one that's been alive without any signal for
      // longer than the stale threshold is a zombie.
      const age = now - Date.parse(input.started_at);
      if (Number.isFinite(age) && age > STALE_THRESHOLD_MS) return 'stale';
    }
  }
  return state;
}

/**
 * Categorical halo color used by the iron palette per CLAUDE.md §5.
 *
 * - Status = halo ring; type = node color. We never paint the job itself
 *   based on status, only the halo.
 * - `killed-by-operator` gets a distinct halo so it reads visually different
 *   from `crashed`/`killed-by-system` (which are failures) — the operator's
 *   own action is not a failure.
 */
export type JobLifecycleHalo = 'ok' | 'warn' | 'crit' | 'neutral' | 'operator';

export function lifecycleHalo(state: JobLifecycleState): JobLifecycleHalo {
  switch (state) {
    case 'dispatched':
    case 'running':
      return 'ok';
    case 'completed-clean':
      return 'neutral';
    case 'completed-error':
      return 'warn';
    case 'killed-by-operator':
      return 'operator';
    case 'killed-by-system':
    case 'crashed':
      return 'crit';
    case 'stale':
      return 'warn';
  }
}

/**
 * Human-readable label that maps 1:1 to a state — used for chip text and
 * roster pills. Distinct enough that the operator can tell apart
 * `killed by operator` (intentional) vs `crashed` (unintentional) at a
 * glance.
 */
export function lifecycleLabel(state: JobLifecycleState): string {
  switch (state) {
    case 'dispatched':         return 'dispatched';
    case 'running':            return 'running';
    case 'completed-clean':    return 'completed cleanly';
    case 'completed-error':    return 'completed with error';
    case 'killed-by-operator': return 'killed by operator';
    case 'killed-by-system':   return 'killed by system';
    case 'crashed':            return 'crashed';
    case 'stale':              return 'stale';
  }
}
