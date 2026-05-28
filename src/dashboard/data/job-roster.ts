/**
 * src/dashboard/data/job-roster.ts
 *
 * Per-page-shaped roster slicing on top of JobRecord[]. Every page that
 * needs a list of jobs (not just a count) reads through this module so
 * "what shows up" is consistent across Helm chips, Topology graph nodes,
 * Jobs panes, and Diagnostics tables.
 *
 * Carries forward BOM v0.6.6 hard rule #4 (single source) + #5 (lifetime vs
 * current distinction) + #7 (no chips for items >24h old in primary view)
 * from the legacy worker-roster module.
 */
import type { JobRecord } from '../../jobs/types.js';
import {
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  type JobLifecycleState,
} from '../../jobs/lifecycle.js';
import { resolveWorkerRetentionOpts } from '../../observability/worker-retention.js';

/**
 * Roster entry: a JobRecord enriched with the derived lifecycle_state so
 * downstream renderers don't have to call deriveLifecycleState again (and
 * so a test can assert the derivation result without running the full
 * render pipeline).
 */
export interface JobRosterEntry {
  job: JobRecord;
  lifecycle_state: JobLifecycleState;
}

export interface JobRosterOptions {
  /** Override clock for tests. Defaults to Date.now(). */
  now?: number;
  /**
   * Cap on the total entries returned. Helm's L2 row shows 6 chips; the
   * Jobs pane grid maxes at 20 before it gets unusable. Pages pass their
   * own cap.
   */
  limit?: number;
  /**
   * History window in milliseconds. Jobs with `ended_at` older than this
   * (or fallback: `started_at` older than this and not currently active)
   * are excluded from the primary view. BOM hard rule #7 names 24h as
   * the default for Helm + Topology canvas.
   */
  maxAgeMs?: number;
}

// v0.6.12 Phase 5 — job retention policy. Default window is 4h
// (env-overridable; prefers STAVR_JOB_RETENTION_HOURS, falls back to the
// legacy STAVR_WORKER_RETENTION_HOURS — see src/observability/worker-retention.ts
// for the deprecation window).
function defaultHistoryWindowMs(): number {
  const { retentionHours } = resolveWorkerRetentionOpts();
  return retentionHours * 60 * 60 * 1000;
}
const DEFAULT_HISTORY_WINDOW_MS = defaultHistoryWindowMs();
/** Toggle target — when the operator clicks "Show archived" the page passes
 *  this larger window (30 days) so archived jobs come back into view. */
export const ARCHIVED_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function entryAgeMs(j: JobRecord, now: number): number {
  const ts = j.ended_at ?? j.last_activity_at ?? j.started_at;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now - parsed);
}

/**
 * Return only currently-active jobs (dispatched + running). Used by Helm
 * L2 chips and the Topology canvas — these surfaces should NOT show
 * historic entries per BOM hard rule #7.
 *
 * Stale jobs are NOT returned here either: stale means we don't know if
 * the process is alive, and the primary view's contract is "what is
 * actually running right now."
 */
export function fetchActiveJobs(
  jobs: readonly JobRecord[],
  opts: JobRosterOptions = {},
): JobRosterEntry[] {
  const now = opts.now ?? Date.now();
  const out: JobRosterEntry[] = [];
  for (const j of jobs) {
    const state = deriveLifecycleState(j, now);
    if (isCurrentlyActive(state)) out.push({ job: j, lifecycle_state: state });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Jobs that ended within the recent history window (default 24h).
 * Used by the "View history" expansion + the Jobs page's collapsed
 * historic section.
 */
export function fetchHistoricJobs(
  jobs: readonly JobRecord[],
  opts: JobRosterOptions = {},
): JobRosterEntry[] {
  const now = opts.now ?? Date.now();
  const window = opts.maxAgeMs ?? DEFAULT_HISTORY_WINDOW_MS;
  const out: JobRosterEntry[] = [];
  for (const j of jobs) {
    const state = deriveLifecycleState(j, now);
    if (!isHistoric(state)) continue;
    if (entryAgeMs(j, now) > window) continue;
    out.push({ job: j, lifecycle_state: state });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Stale jobs (no heartbeat, no exit). Surfaced as a separate bucket
 * because the operator may want to act on them via `job_terminate`.
 * Per BOM open question §1 conservative default: no auto-cleanup.
 */
export function fetchStaleJobs(
  jobs: readonly JobRecord[],
  opts: JobRosterOptions = {},
): JobRosterEntry[] {
  const now = opts.now ?? Date.now();
  const out: JobRosterEntry[] = [];
  for (const j of jobs) {
    if (deriveLifecycleState(j, now) === 'stale') {
      out.push({ job: j, lifecycle_state: 'stale' });
    }
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Combined view: active first, then stale (so operator sees what needs
 * attention), then historic up to maxAgeMs. Used by the Jobs page's full
 * roster + Diagnostics' Jobs panel.
 */
export function fetchFullJobRoster(
  jobs: readonly JobRecord[],
  opts: JobRosterOptions = {},
): { active: JobRosterEntry[]; stale: JobRosterEntry[]; historic: JobRosterEntry[] } {
  return {
    active: fetchActiveJobs(jobs, opts),
    stale: fetchStaleJobs(jobs, opts),
    historic: fetchHistoricJobs(jobs, opts),
  };
}
