/**
 * Decisions history fetcher. Reads the `decisions` table directly via the
 * EventStore handle — schema reuse only, no new tables.
 *
 * Status mapping (DecisionRecord.status → HistoryStatus):
 *   open      → pending
 *   responded → chose-id determines success (we don't know operator
 *               sentiment, so we record 'success' uniformly — the drawer
 *               shows the chosen option label which is what operators
 *               actually want to read)
 *   expired   → expired
 *
 * Range filter: `requested_at` is the canonical event time (BOM range
 * picker semantics — "what was happening between X and Y"). `responded_at`
 * is exposed via the drawer payload, not the timeline sort key.
 */
import type Database from 'better-sqlite3';
import type { DecisionRecord } from '../../../persistence.js';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStatus,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface DecisionHistoryQuery extends HistoryQuery {
  /** Optional status filter — pages can narrow to "expired only" etc. */
  status?: DecisionRecord['status'];
}

export interface DecisionsHistorySources {
  db: Database.Database;
}

function decisionStatusToHistory(status: DecisionRecord['status']): HistoryStatus {
  switch (status) {
    case 'open':      return 'pending';
    case 'responded': return 'success';
    case 'expired':   return 'expired';
  }
}

function rowToItem(row: DecisionRow): HistoryItem {
  const options = JSON.parse(row.options_json) as Array<{ id: string; label: string }>;
  const chosen = row.chosen_option_id
    ? options.find((o) => o.id === row.chosen_option_id)
    : undefined;
  const title = chosen
    ? `${row.question} → ${chosen.label}`
    : row.question;
  const decision: DecisionRecord = {
    correlation_id: row.correlation_id,
    question: row.question,
    options,
    default_option_id: row.default_option_id ?? undefined,
    timeout_sec: row.timeout_sec,
    status: row.status,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    responded_at: row.responded_at ?? undefined,
    responded_by: row.responded_by ?? undefined,
    chosen_option_id: row.chosen_option_id ?? undefined,
    response_reason: row.response_reason ?? undefined,
  };
  return {
    kind: 'decision',
    id: row.correlation_id,
    at: row.requested_at,
    title,
    actor: row.responded_by ?? 'pending',
    correlation_id: row.correlation_id,
    status: decisionStatusToHistory(row.status),
    payload: decision,
  };
}

interface DecisionRow {
  correlation_id: string;
  question: string;
  options_json: string;
  default_option_id: string | null;
  timeout_sec: number;
  status: DecisionRecord['status'];
  requested_at: string;
  expires_at: string;
  responded_at: string | null;
  responded_by: string | null;
  chosen_option_id: string | null;
  response_reason: string | null;
}

export function fetchDecisionsHistory(
  sources: DecisionsHistorySources,
  query: DecisionHistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (since) {
    where.push('requested_at >= ?');
    params.push(since);
  }
  if (until) {
    where.push('requested_at < ?');
    params.push(until);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = sources.db
    .prepare(`SELECT COUNT(*) AS c FROM decisions ${whereSql}`)
    .get(...params) as { c: number };

  const rows = sources.db
    .prepare(
      `SELECT * FROM decisions ${whereSql} ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as DecisionRow[];

  return {
    items: rows.map(rowToItem),
    next_cursor: nextCursor(offset, limit, rows.length),
    total_estimate: totalRow.c,
  };
}
