/**
 * Plans (BOM-records) history fetcher. Reads the `boms` table — that's
 * what stavR internally calls "plans" once they've been dispatched.
 *
 * The BOM brief distinguishes between:
 *   - boms.ts (this file's neighbour) — markdown files in `proposed/`
 *   - plans.ts (this file)            — DB rows once a BOM has been
 *     parsed + dispatched
 *
 * So a single BOM markdown file may appear twice in the timeline (once
 * as the file mtime, once as the dispatch event); they share the
 * `correlation_id` so the P4 walker stitches them together.
 */
import type { Database } from '../../../db/index.js';
import type { Bom, BomStatus } from '../../../types/stavr-bom.js';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStatus,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface PlansHistoryQuery extends HistoryQuery {
  status?: BomStatus;
}

export interface PlansHistorySources {
  db: Database;
}

function bomStatusToHistory(status: BomStatus): HistoryStatus {
  switch (status) {
    case 'proposed':  return 'pending';
    case 'approved':  return 'in-progress';
    case 'running':   return 'in-progress';
    case 'done':      return 'success';
    case 'failed':    return 'failure';
    case 'cancelled': return 'cancelled';
    case 'rejected':  return 'cancelled';
  }
}

interface BomRow {
  id: string;
  goal: string;
  requester: string;
  correlation_id: string;
  status: BomStatus;
  active_version: number;
  cost_estimate: number;
  cost_max: number;
  duration_sec: number;
  cost_actual: number;
  steps_done: number;
  steps_total: number;
  profile_mode: string;
  scope_id: string | null;
  risk_envelope: string;
  proposed_at: string;
  approved_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  is_draft: number;
}

function rowToItem(row: BomRow): HistoryItem {
  const bom: Bom = {
    id: row.id,
    goal: row.goal,
    requester: row.requester,
    correlation_id: row.correlation_id,
    status: row.status,
    active_version: row.active_version,
    cost_estimate: row.cost_estimate,
    cost_max: row.cost_max,
    duration_sec: row.duration_sec,
    cost_actual: row.cost_actual,
    steps_done: row.steps_done,
    steps_total: row.steps_total,
    profile_mode: row.profile_mode as Bom['profile_mode'],
    scope_id: row.scope_id ?? undefined,
    risk_envelope: JSON.parse(row.risk_envelope) as Bom['risk_envelope'],
    proposed_at: row.proposed_at,
    approved_at: row.approved_at ?? undefined,
    started_at: row.started_at ?? undefined,
    ended_at: row.ended_at ?? undefined,
    is_draft: row.is_draft === 1,
  };
  return {
    kind: 'plan',
    id: bom.id,
    at: bom.proposed_at,
    title: bom.goal,
    actor: bom.requester,
    correlation_id: bom.correlation_id,
    status: bomStatusToHistory(bom.status),
    payload: bom,
  };
}

export function fetchPlansHistory(
  sources: PlansHistorySources,
  query: PlansHistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (since) {
    where.push('proposed_at >= ?');
    params.push(since);
  }
  if (until) {
    where.push('proposed_at < ?');
    params.push(until);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = sources.db
    .prepare(`SELECT COUNT(*) AS c FROM boms ${whereSql}`)
    .get(...params) as { c: number };

  const rows = sources.db
    .prepare(
      `SELECT * FROM boms ${whereSql} ORDER BY proposed_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as BomRow[];

  return {
    items: rows.map(rowToItem),
    next_cursor: nextCursor(offset, limit, rows.length),
    total_estimate: totalRow.c,
  };
}
