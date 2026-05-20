/**
 * Worker retention policy (v0.6.12 Phase 5).
 *
 * Two thresholds, both env-driven:
 *   - STAVR_WORKER_RETENTION_HOURS (default 4): how long a terminated /
 *     crashed / completed worker stays visible in the primary roster
 *     views (Streams + Topology + Diagnostics). Older workers are
 *     "archived" — they still exist in the DB and the "Show archived"
 *     toggle reveals them, but the default view hides them. Archival
 *     is purely a UI filter.
 *   - STAVR_WORKER_HARD_DELETE_DAYS (default 30): how long a worker
 *     row stays in the DB at all. Older rows are deleted by the
 *     retention scheduler in daemon.ts.
 *
 * Hard-delete is destructive — the row is gone, related events stay
 * in the event store under the normal retention policy (operational
 * events 7d, audit events 90d).
 */

export interface WorkerRetentionOpts {
  /** UI archive window in hours. Env: STAVR_WORKER_RETENTION_HOURS. Default 4. */
  retentionHours: number;
  /** DB hard-delete threshold in days. Env: STAVR_WORKER_HARD_DELETE_DAYS. Default 30. */
  hardDeleteDays: number;
}

const DEFAULT_RETENTION_HOURS = 4;
const DEFAULT_HARD_DELETE_DAYS = 30;

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve worker retention policy from env. Pure function so the daemon
 * scheduler, dashboard data fetchers, and tests share one resolution
 * path.
 */
export function resolveWorkerRetentionOpts(
  overrides: Partial<WorkerRetentionOpts> = {},
): WorkerRetentionOpts {
  return {
    retentionHours: overrides.retentionHours ?? numEnv('STAVR_WORKER_RETENTION_HOURS', DEFAULT_RETENTION_HOURS),
    hardDeleteDays: overrides.hardDeleteDays ?? numEnv('STAVR_WORKER_HARD_DELETE_DAYS', DEFAULT_HARD_DELETE_DAYS),
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
