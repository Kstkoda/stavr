/**
 * v0.8 Audit History — shared types for the read-only history dashboard.
 *
 * Every history fetcher returns the same envelope shape so the timeline
 * merger can treat sources uniformly. Items are kind-tagged so the UI can
 * pick the right icon + drawer renderer without each row carrying its own
 * render function.
 *
 * Per the BOM open-questions defaults (recorded in PR body):
 *   §1 retention: respect ADR-030 (30d default); fetchers don't enforce
 *      a hard floor — the page renders an "earlier history pruned" hint at
 *      the boundary.
 *   §3 federation: local-only in v0.8 (peer events excluded by source_agent
 *      filter at the page layer; fetchers stay kind-agnostic).
 *   §5 internal events: filtered out by default at the page; fetchers
 *      always return everything they have so a "show internal" toggle is
 *      a pure UI decision.
 *
 * The walker in correlation.ts (P4) consumes the kind enum below only as
 * a discriminator for the row icon — the actual walk follows
 * `correlation_id` linkage, which is kind-agnostic. New event kinds
 * (LLM-call, DB-query, MCP-traffic, federation-traffic) plug in by adding
 * a tag to HistoryKind and a row in HISTORY_KIND_REGISTRY in the page; no
 * walker change is required.
 */

export type HistoryKind =
  | 'decision'
  | 'scope'
  | 'bom-file'
  | 'plan'
  | 'host-exec'
  | 'commit'
  | 'ci'
  | 'notification';

export type HistoryStatus =
  | 'pending'
  | 'success'
  | 'failure'
  | 'expired'
  | 'revoked'
  | 'cancelled'
  | 'in-progress'
  | 'unknown';

/**
 * One row in the timeline. Each fetcher emits this shape; the merger
 * concatenates and sorts by `at` DESC.
 *
 * `correlation_id` is the join key for P4's bidirectional walker. NULL is
 * accepted gracefully (legacy events pre-correlation may not have one) —
 * the row still renders, just without a "trace" affordance.
 *
 * `source_url` is the optional external link (GitHub commit URL, CI run
 * URL); P3 wires this through to `source-link.ts`.
 *
 * `payload` is the per-kind raw record used by the side drawer renderer.
 * Kept loosely typed because each kind has its own shape and the drawer
 * narrows by `kind`.
 */
export interface HistoryItem {
  kind: HistoryKind;
  /** Stable per-source id. Combined with kind to form a unique row key. */
  id: string;
  /** ISO 8601 — when the underlying event happened. Drives sort order. */
  at: string;
  /** Free-text one-liner for the row body. */
  title: string;
  /** Free-text actor/source attribution: 'operator', 'cc', 'steward-agent', 'cowork-claude', 'peer:<id>'. */
  actor: string;
  /** Optional join key for cross-source threading. */
  correlation_id?: string;
  /** Status pill on the row, when meaningful. */
  status?: HistoryStatus;
  /** Optional external link (GitHub commit / PR / CI run). P3 click-through. */
  source_url?: string;
  /** Per-kind raw record for the drawer renderer. */
  payload?: unknown;
}

/**
 * Shared query envelope. All fetchers accept the same shape so the page
 * can fan out a single `range + tab + search` to every source.
 */
export interface HistoryQuery {
  /** ISO 8601 lower bound (inclusive). Omitted = no lower bound. */
  since?: string;
  /** ISO 8601 upper bound (exclusive). Omitted = no upper bound. */
  until?: string;
  /** Default 100, hard cap 500. */
  limit?: number;
  /** Cursor-style offset. Hard cap 1000 (footgun #1 — never SELECT * past 1k). */
  offset?: number;
}

/**
 * Paginated envelope. `total_estimate` is approximate (COUNT(*) with the
 * same WHERE) and only meaningful when small (<1k). Above the deep-pagination
 * cap the page shows ">1000" — operators who need exhaustive history use
 * the SQL CLI, not the dashboard.
 */
export interface HistoryPage<T = HistoryItem> {
  items: T[];
  /** Next offset, or null when the underlying source is exhausted. */
  next_cursor: string | null;
  /** Approximate count of all matching rows. */
  total_estimate: number;
}

/** Hard caps shared by every fetcher (BOM Footgun #1 + Pagination Contract). */
export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_MAX = 500;
export const HISTORY_OFFSET_MAX = 1000;

/**
 * Normalize a query: clamp the limit + offset and convert the offset to a
 * cursor string (we use offset cursors today; a future opaque-cursor
 * migration is non-breaking because the page treats `next_cursor` as
 * opaque).
 */
export function normalizeQuery(q: HistoryQuery | undefined): {
  since: string | null;
  until: string | null;
  limit: number;
  offset: number;
} {
  const limit = Math.min(
    Math.max(1, Math.floor(q?.limit ?? HISTORY_LIMIT_DEFAULT)),
    HISTORY_LIMIT_MAX,
  );
  const offset = Math.min(
    Math.max(0, Math.floor(q?.offset ?? 0)),
    HISTORY_OFFSET_MAX,
  );
  return {
    since: q?.since ?? null,
    until: q?.until ?? null,
    limit,
    offset,
  };
}

/**
 * Produce a next_cursor string from the current offset + limit + returned
 * row count. Returns null when the page didn't fill (= source exhausted)
 * or when the next offset would exceed HISTORY_OFFSET_MAX.
 */
export function nextCursor(
  currentOffset: number,
  limit: number,
  returned: number,
): string | null {
  if (returned < limit) return null;
  const next = currentOffset + limit;
  if (next > HISTORY_OFFSET_MAX) return null;
  return String(next);
}

/**
 * Read-only sentinel — fetchers MUST never write. Any attempt throws so
 * the negative-path test catches accidental misuse.
 */
export class HistoryReadOnlyError extends Error {
  code = 'HISTORY_READ_ONLY' as const;
  constructor(method: string) {
    super(`history fetcher is read-only — refused ${method}`);
    this.name = 'HistoryReadOnlyError';
  }
}
