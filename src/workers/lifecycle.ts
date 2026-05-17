/**
 * src/workers/lifecycle.ts
 *
 * Derived "lifecycle state" for workers — the source of truth for what's
 * actually running vs what's history, vs what we lost track of.
 *
 * The existing `status` enum on WorkerRecord (starting | running | idle |
 * terminated | crashed) has mixed semantics: "terminated" lumps together
 * clean exit, exit with error code, and operator-issued kill; "idle" doesn't
 * say whether the process is alive; and there's no way to distinguish a
 * worker that crashed days ago from one that crashed five seconds ago.
 *
 * Per BOM v0.6.5/v0.6.6 (worker status fidelity), we add a finer-grained
 * lifecycle_state that the dashboard uses for counts and rendering. The
 * column is additive — existing rows with NULL lifecycle_state are derived
 * on read from the legacy fields.
 *
 * The 2026-05-17 E2E session exposed the cost of conflation: Helm L2
 * showed "6 active workers" when 0 were actually running. The lifecycle
 * states below were chosen specifically to make that lie impossible.
 */
import type { WorkerRecord } from '../persistence.js';

export type LifecycleState =
  | 'starting'            // spawn issued, process not yet confirmed up
  | 'running'             // process confirmed up, no exit yet
  | 'completed-clean'     // exited 0 of its own accord
  | 'completed-error'     // exited non-zero of its own accord
  | 'killed-by-operator'  // worker_terminate called (operator action)
  | 'killed-by-system'    // OOM / AV / OS-level kill (heuristic match)
  | 'crashed'             // exit code non-zero AND not killed (segfault style)
  | 'stale';              // last_activity_at older than threshold, no exit

/**
 * Worker shape used by the derivation helpers. We accept a slim object so
 * callers can pass either a full WorkerRecord or just the fields we need
 * (handy for tests and for the watchdog path that doesn't load metadata).
 */
export interface LifecycleInput {
  status: WorkerRecord['status'];
  ended_at?: string;
  last_activity_at?: string;
  termination_reason?: WorkerRecord['termination_reason'];
  exit_code?: number;
  /** Optional pre-stored lifecycle_state; if set and valid, returned as-is. */
  lifecycle_state?: LifecycleState | null;
}

/**
 * Threshold beyond which a worker without exit info is classified as
 * `stale`. BOM v0.6.6 footgun #3: active heartbeat within last 60s should
 * keep `running`; everything between 60s and STALE_THRESHOLD_MS still
 * counts as running (we trust the process); beyond that we mark stale.
 */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1h

/**
 * Compute the LifecycleState for a worker.
 *
 * If the worker row already has a non-null `lifecycle_state`, we return it
 * verbatim — that means the orchestrator wrote it explicitly and we should
 * not second-guess. Otherwise we derive from the legacy fields.
 *
 * `now` is parameterised so tests don't have to mock the clock.
 */
export function deriveLifecycleState(
  input: LifecycleInput,
  now: number = Date.now(),
): LifecycleState {
  // Prefer the explicit value if present (orchestrator-authoritative).
  if (input.lifecycle_state) {
    if (isValidLifecycleState(input.lifecycle_state)) return input.lifecycle_state;
    // Fall through to derivation if the stored value is garbage.
  }

  const { status, termination_reason, exit_code, last_activity_at } = input;

  if (status === 'starting') return 'starting';

  if (status === 'crashed') {
    // termination_reason='crashed' OR a null reason both land here.
    // We currently can't distinguish OS-level kills (OOM, AV) from a
    // proc-internal segfault from the persisted row alone — that needs
    // killed-by-system telemetry from spawner-side detection (v0.6.7).
    // Until then: anything `crashed` is `crashed`.
    return 'crashed';
  }

  if (status === 'terminated') {
    if (termination_reason === 'terminated_by_user') return 'killed-by-operator';
    if (termination_reason === 'completed') {
      // exit_code 0 => clean, any other code => completed-error. NULL
      // exit_code is treated as clean (consistent with how the daemon
      // already records "completed" — see persistence.markWorkerTerminated).
      if (exit_code === undefined || exit_code === null || exit_code === 0) {
        return 'completed-clean';
      }
      return 'completed-error';
    }
    // Unknown termination_reason on a `terminated` row — be conservative
    // and treat as completed-clean so historical rows aren't surprised
    // into "error" status retroactively.
    return 'completed-clean';
  }

  // status is 'running' or 'idle' — the worker still claims to be alive.
  // BOM footgun #4: the May-15 zombies have null/old heartbeats and old
  // started_at. They should classify as `stale`, not `running`.
  if (last_activity_at) {
    const age = now - Date.parse(last_activity_at);
    if (Number.isFinite(age) && age > STALE_THRESHOLD_MS) return 'stale';
  } else {
    // No heartbeat ever recorded. If the worker is fresh enough that we
    // can't expect a heartbeat yet, leave it as running; otherwise stale.
    // We can't see started_at here, so the conservative call is to treat
    // a heartbeat-less worker as `running` only when the orchestrator
    // explicitly set status='running'. status='idle' with no heartbeat
    // history is stale by definition.
    if (status === 'idle') return 'stale';
  }

  return 'running';
}

const VALID_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'starting',
  'running',
  'completed-clean',
  'completed-error',
  'killed-by-operator',
  'killed-by-system',
  'crashed',
  'stale',
]);

function isValidLifecycleState(s: string): s is LifecycleState {
  return VALID_STATES.has(s as LifecycleState);
}

/**
 * Per BOM §1: `starting` and `running` are the only states that count as
 * currently-active. `stale` is explicitly NOT active — we don't know if
 * the process is up; treating it as active is exactly the lie this work
 * is meant to fix.
 */
export function isCurrentlyActive(state: LifecycleState): boolean {
  return state === 'starting' || state === 'running';
}

/**
 * Historic = not currently active AND not stale. Stale is its own bucket
 * because operators may want to act on it (e.g. issue `worker_terminate`).
 * If you want "everything that isn't running right now," combine
 * !isCurrentlyActive(s) directly instead.
 */
export function isHistoric(state: LifecycleState): boolean {
  return !isCurrentlyActive(state) && state !== 'stale';
}

/**
 * Categorical halo color used by the iron palette per CLAUDE.md §5.
 *
 * - Status = halo ring; type = node color. We never paint the worker
 *   itself based on status, only the halo.
 * - `killed-by-operator` gets a distinct pink/violet halo so it reads
 *   visually different from `crashed`/`killed-by-system` (which are
 *   failures) — the operator's own action is not a failure.
 */
export type LifecycleHalo = 'ok' | 'warn' | 'crit' | 'neutral' | 'operator';

export function lifecycleHalo(state: LifecycleState): LifecycleHalo {
  switch (state) {
    case 'starting':
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
 * Human-readable label that maps 1:1 to a state — used for the chip text
 * and the roster pill. Distinct enough that the operator can tell apart
 * `killed by operator` (intentional) vs `crashed` (unintentional) at a
 * glance.
 */
export function lifecycleLabel(state: LifecycleState): string {
  switch (state) {
    case 'starting':           return 'starting';
    case 'running':            return 'running';
    case 'completed-clean':    return 'completed cleanly';
    case 'completed-error':    return 'completed with error';
    case 'killed-by-operator': return 'killed by operator';
    case 'killed-by-system':   return 'killed by system';
    case 'crashed':            return 'crashed';
    case 'stale':              return 'stale';
  }
}
