/**
 * Trust-scope history fetcher. Reads `trust_scopes` table directly + joins
 * per-scope action counts from `scope_actions` so the drawer can show "n
 * actions executed under this scope" without a second round-trip.
 *
 * Sort key is `proposed_at` (the moment the scope entered the operator's
 * world). `granted_at` may be empty when the scope was rejected before
 * grant; the timeline still wants to show the proposal.
 */
import type Database from 'better-sqlite3';
import type { TrustScope, TrustScopeStatus, ActionMatcher, ScopeReporting } from '../../../trust/types.js';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStatus,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface ScopeHistoryQuery extends HistoryQuery {
  status?: TrustScopeStatus;
}

export interface ScopesHistorySources {
  db: Database.Database;
}

function scopeStatusToHistory(status: TrustScopeStatus | string): HistoryStatus {
  switch (status) {
    case 'proposed':  return 'pending';
    case 'active':    return 'in-progress';
    case 'completed': return 'success';
    case 'expired':   return 'expired';
    case 'revoked':   return 'revoked';
    // Future-proof: scope_rejected event in event-types is a separate
    // stream — the trust_scopes row stays in 'proposed' until acted upon.
    // If a future migration adds 'rejected' as a stored status, map it
    // to cancelled here without a code change elsewhere.
    case 'rejected':  return 'cancelled';
    default:          return 'unknown';
  }
}

interface ScopeRow {
  id: string;
  title: string;
  description: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  expires_after_actions: number | null;
  allowed_actions_json: string;
  forbidden_actions_json: string | null;
  reporting_json: string;
  status: string;
  spec_url: string | null;
  proposed_at: string | null;
  actions_executed: number;
  completed_at: string | null;
}

function rowToItem(row: ScopeRow): HistoryItem {
  const scope: TrustScope = {
    id: row.id,
    title: row.title,
    description: row.description,
    granted_by: row.granted_by,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    expires_after_actions: row.expires_after_actions ?? undefined,
    allowed_actions: JSON.parse(row.allowed_actions_json) as ActionMatcher[],
    forbidden_actions: row.forbidden_actions_json
      ? (JSON.parse(row.forbidden_actions_json) as ActionMatcher[])
      : undefined,
    reporting: JSON.parse(row.reporting_json) as ScopeReporting,
    status: row.status as TrustScopeStatus,
    spec_url: row.spec_url ?? undefined,
    proposed_at: row.proposed_at ?? undefined,
    actions_executed: row.actions_executed,
    completed_at: row.completed_at ?? undefined,
  };
  // The proposed-at timestamp is the most useful event-time anchor; fall
  // back to granted_at when proposed_at is missing on legacy rows.
  const at = scope.proposed_at ?? scope.granted_at;
  return {
    kind: 'scope',
    id: scope.id,
    at,
    title: scope.title,
    actor: scope.granted_by || 'pending',
    correlation_id: scope.id,
    status: scopeStatusToHistory(scope.status),
    payload: scope,
  };
}

export function fetchScopesHistory(
  sources: ScopesHistorySources,
  query: ScopeHistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (since) {
    where.push('COALESCE(proposed_at, granted_at) >= ?');
    params.push(since);
  }
  if (until) {
    where.push('COALESCE(proposed_at, granted_at) < ?');
    params.push(until);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = sources.db
    .prepare(`SELECT COUNT(*) AS c FROM trust_scopes ${whereSql}`)
    .get(...params) as { c: number };

  const rows = sources.db
    .prepare(
      `SELECT * FROM trust_scopes ${whereSql} ORDER BY COALESCE(proposed_at, granted_at) DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ScopeRow[];

  return {
    items: rows.map(rowToItem),
    next_cursor: nextCursor(offset, limit, rows.length),
    total_estimate: totalRow.c,
  };
}
