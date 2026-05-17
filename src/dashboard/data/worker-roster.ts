/**
 * src/dashboard/data/worker-roster.ts
 *
 * Per-page-shaped roster slicing on top of WorkerRecord[]. Every page that
 * needs a list of workers (not just a count) reads through this module so
 * "what shows up" is consistent across Helm chips, Topology graph nodes,
 * Streams panes, and Diagnostics tables.
 *
 * BOM v0.6.6 hard rule #4 (single source) + #5 (lifetime vs current
 * distinction) + #7 (no chips for items >24h old in primary view).
 */
import type { WorkerRecord } from '../../persistence.js';
import {
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  type LifecycleState,
} from '../../workers/lifecycle.js';

/**
 * Roster entry: a WorkerRecord enriched with the derived lifecycle_state
 * so downstream renderers don't have to call deriveLifecycleState again
 * (and so a test can assert the derivation result without running the
 * full render pipeline).
 */
export interface RosterEntry {
  worker: WorkerRecord;
  lifecycle_state: LifecycleState;
}

export interface RosterOptions {
  /** Override clock for tests. Defaults to Date.now(). */
  now?: number;
  /**
   * Cap on the total entries returned. Helm's L2 row shows 6 chips; the
   * Streams pane grid maxes at 20 before it gets unusable. Pages pass
   * their own cap.
   */
  limit?: number;
  /**
   * History window in milliseconds. Workers with `ended_at` older than
   * this (or fallback: `started_at` older than this and not currently
   * active) are excluded from the primary view. BOM hard rule #7 names
   * 24h as the default for Helm + Topology canvas.
   */
  maxAgeMs?: number;
}

const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

function entryAgeMs(w: WorkerRecord, now: number): number {
  const ts = w.ended_at ?? w.last_activity_at ?? w.started_at;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now - parsed);
}

/**
 * Return only currently-active workers (starting + running). Used by Helm
 * L2 chips and the Topology canvas — these surfaces should NOT show
 * historic entries per BOM hard rule #7.
 *
 * Stale workers are NOT returned here either: stale means we don't know
 * if the process is alive, and the primary view's contract is "what is
 * actually running right now."
 */
export function fetchActiveWorkers(
  workers: readonly WorkerRecord[],
  opts: RosterOptions = {},
): RosterEntry[] {
  const now = opts.now ?? Date.now();
  const out: RosterEntry[] = [];
  for (const w of workers) {
    const state = deriveLifecycleState(w, now);
    if (isCurrentlyActive(state)) out.push({ worker: w, lifecycle_state: state });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Workers that ended within the recent history window (default 24h).
 * Used by the "View history" expansion + the Streams page's collapsed
 * historic section.
 */
export function fetchHistoricWorkers(
  workers: readonly WorkerRecord[],
  opts: RosterOptions = {},
): RosterEntry[] {
  const now = opts.now ?? Date.now();
  const window = opts.maxAgeMs ?? DEFAULT_HISTORY_WINDOW_MS;
  const out: RosterEntry[] = [];
  for (const w of workers) {
    const state = deriveLifecycleState(w, now);
    if (!isHistoric(state)) continue;
    if (entryAgeMs(w, now) > window) continue;
    out.push({ worker: w, lifecycle_state: state });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Stale workers (no heartbeat, no exit). Surfaced as a separate bucket
 * because the operator may want to act on them via `worker_terminate`.
 * Per BOM open question §1 conservative default: no auto-cleanup.
 */
export function fetchStaleWorkers(
  workers: readonly WorkerRecord[],
  opts: RosterOptions = {},
): RosterEntry[] {
  const now = opts.now ?? Date.now();
  const out: RosterEntry[] = [];
  for (const w of workers) {
    if (deriveLifecycleState(w, now) === 'stale') {
      out.push({ worker: w, lifecycle_state: 'stale' });
    }
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Combined view: active first, then stale (so operator sees what needs
 * attention), then historic up to maxAgeMs. Used by the Streams page's
 * full roster + Diagnostics' Workers panel.
 */
export function fetchFullRoster(
  workers: readonly WorkerRecord[],
  opts: RosterOptions = {},
): { active: RosterEntry[]; stale: RosterEntry[]; historic: RosterEntry[] } {
  return {
    active: fetchActiveWorkers(workers, opts),
    stale: fetchStaleWorkers(workers, opts),
    historic: fetchHistoricWorkers(workers, opts),
  };
}
