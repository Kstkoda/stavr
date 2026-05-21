/**
 * CI runs history. The actual GitHub Actions integration lives in the
 * `stavr` MCP server's `github_list_workflow_runs` tool; for the dashboard
 * we just take a pre-fetched array (the daemon caches it; see BOM footgun
 * #8 — 15min TTL acceptable for retrospective view).
 *
 * This file is thin on purpose: the page passes a `runs` array (possibly
 * empty when GitHub isn't reachable / not configured) and we normalize it
 * into HistoryItems. No network I/O here.
 *
 * Why so spare: the BOM mandates "wraps existing GitHub workflow runs
 * query", and there's nothing in the daemon yet that caches workflow runs
 * — so the page layer is responsible for fetching + caching. This fetcher
 * is the adapter that turns that array into timeline rows.
 */
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStatus,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface CiRunInput {
  /** Workflow run id (e.g. "25988903894"). */
  id: string;
  /** Workflow name ("CI", "Build", etc.). */
  name: string;
  /** "success" | "failure" | "cancelled" | "in_progress" | "queued" etc. */
  status: string;
  /** Conclusion field from GitHub API; nullable while in_progress. */
  conclusion: string | null;
  /** ISO 8601 — when the run started. */
  created_at: string;
  /** HTML link to the run on github.com. */
  html_url: string;
  /** Commit SHA the run was triggered for (correlation key). */
  head_sha?: string;
  /** Triggering actor (login). */
  actor?: string;
}

export interface CiHistorySources {
  /** Pre-fetched list of CI runs. */
  runs: CiRunInput[];
}

function ciStatusToHistory(status: string, conclusion: string | null): HistoryStatus {
  if (status === 'in_progress' || status === 'queued') return 'in-progress';
  if (status === 'completed' || conclusion) {
    const c = (conclusion ?? '').toLowerCase();
    if (c === 'success') return 'success';
    if (c === 'failure' || c === 'timed_out' || c === 'action_required') return 'failure';
    if (c === 'cancelled') return 'cancelled';
    if (c === 'skipped' || c === 'neutral') return 'unknown';
  }
  return 'unknown';
}

export function fetchCiHistory(
  sources: CiHistorySources,
  query: HistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const untilMs = until ? Date.parse(until) : Infinity;
  const filtered: HistoryItem[] = [];
  for (const r of sources.runs) {
    const tMs = Date.parse(r.created_at);
    if (!Number.isFinite(tMs)) continue;
    if (tMs < sinceMs || tMs >= untilMs) continue;
    filtered.push({
      kind: 'ci',
      id: r.id,
      at: r.created_at,
      title: r.name,
      actor: r.actor ?? 'github-actions',
      // Use the head_sha as correlation hint so a commit row + its CI
      // row can be threaded by the walker. We DON'T overload
      // correlation_id with a non-stavR id when head_sha is missing.
      correlation_id: r.head_sha,
      status: ciStatusToHistory(r.status, r.conclusion),
      source_url: r.html_url,
      payload: r,
    });
  }
  filtered.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const page = filtered.slice(offset, offset + limit);
  return {
    items: page,
    next_cursor: nextCursor(offset, limit, page.length),
    total_estimate: filtered.length,
  };
}
