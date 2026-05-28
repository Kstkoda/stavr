/**
 * Worker retention policy (v0.6.12 Phase 5; env vars renamed in
 * worker-dispatch Phase 3a).
 *
 * Two thresholds, both env-driven:
 *   - STAVR_JOB_RETENTION_HOURS (default 4): how long a terminated /
 *     crashed / completed job stays visible in the primary roster
 *     views. Archival is a UI filter.
 *   - STAVR_JOB_HARD_DELETE_DAYS (default 30): how long a job row stays
 *     in the DB at all. The retention scheduler in daemon.ts deletes
 *     older rows.
 *
 * Legacy env var names (`STAVR_WORKER_RETENTION_HOURS`,
 * `STAVR_WORKER_HARD_DELETE_DAYS`) are still read during the deprecation
 * window so operators don't get silent breakage at boot:
 *
 *   - If BOTH are set, JOB_* wins and a console warning notes the
 *     conflict.
 *   - If only the legacy name is set, the legacy value is honored and a
 *     console warning asks the operator to rename. (Silent fallback would
 *     leave operators with archive thresholds they don't realise stopped
 *     reading their env.)
 *   - If only JOB_* is set, it's used. No warning.
 *
 * The deprecation window matches the broker-event dual-emit window —
 * `DEPRECATION_WINDOW_RELEASES` in src/event-types.ts.
 *
 * Hard-delete is destructive — the row is gone, related events stay
 * in the event store under the normal retention policy (operational
 * events 7d, audit events 90d).
 */

export interface WorkerRetentionOpts {
  /** UI archive window in hours. Env: STAVR_JOB_RETENTION_HOURS (legacy:
   *  STAVR_WORKER_RETENTION_HOURS). Default 4. */
  retentionHours: number;
  /** DB hard-delete threshold in days. Env: STAVR_JOB_HARD_DELETE_DAYS
   *  (legacy: STAVR_WORKER_HARD_DELETE_DAYS). Default 30. */
  hardDeleteDays: number;
}

const DEFAULT_RETENTION_HOURS = 4;
const DEFAULT_HARD_DELETE_DAYS = 30;

function parsePositiveNum(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read a renamed env var, accepting BOTH the new and the legacy name.
 * Logs a warning to stderr on (a) conflict — both set, JOB_* wins; or
 * (b) legacy-only — JOB_* not set, legacy value used. Silent on the
 * happy path (JOB_* only) and on the unset path.
 *
 * The warning is `console.warn` rather than a structured logger event
 * because this resolves at module-load / boot time, before the broker
 * exists. The daemon's own startup log will catch it; tests that mute
 * console.warn won't see it.
 */
function readRenamedEnv(
  newKey: string,
  legacyKey: string,
  fallback: number,
): number {
  const newVal = parsePositiveNum(process.env[newKey]);
  const legacyVal = parsePositiveNum(process.env[legacyKey]);
  if (newVal !== undefined && legacyVal !== undefined) {
    console.warn(
      `[stavr] ${newKey}=${newVal} and ${legacyKey}=${legacyVal} both set — using ${newKey}. Drop ${legacyKey} from your env; it's deprecated and removed next release.`,
    );
    return newVal;
  }
  if (newVal !== undefined) return newVal;
  if (legacyVal !== undefined) {
    console.warn(
      `[stavr] ${legacyKey} is deprecated; rename to ${newKey}. Honoring legacy value ${legacyVal} for this boot.`,
    );
    return legacyVal;
  }
  return fallback;
}

/**
 * Resolve worker retention policy from env. Pure-ish function so the daemon
 * scheduler, dashboard data fetchers, and tests share one resolution path.
 * The "pure-ish" is the deprecation warning to console.warn — never throws.
 */
export function resolveWorkerRetentionOpts(
  overrides: Partial<WorkerRetentionOpts> = {},
): WorkerRetentionOpts {
  return {
    retentionHours:
      overrides.retentionHours ??
      readRenamedEnv(
        'STAVR_JOB_RETENTION_HOURS',
        'STAVR_WORKER_RETENTION_HOURS',
        DEFAULT_RETENTION_HOURS,
      ),
    hardDeleteDays:
      overrides.hardDeleteDays ??
      readRenamedEnv(
        'STAVR_JOB_HARD_DELETE_DAYS',
        'STAVR_WORKER_HARD_DELETE_DAYS',
        DEFAULT_HARD_DELETE_DAYS,
      ),
  };
}

/** Compute the cutoff ISO timestamp for hard-delete. */
export function hardDeleteCutoffIso(opts: WorkerRetentionOpts, now: number = Date.now()): string {
  return new Date(now - opts.hardDeleteDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Compute the archive window in milliseconds. */
export function archiveWindowMs(opts: WorkerRetentionOpts): number {
  return opts.retentionHours * 60 * 60 * 1000;
}

export interface WorkerRetentionResult {
  hardDeleted: number;
  cutoff: string;
  duration_ms: number;
}
