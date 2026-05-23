/**
 * Notifications history. Reads the `notifications` table (from v0.6 —
 * see proposed/v0_6-notifications-bom.md) with optional severity +
 * source-agent filters.
 *
 * The source_agent attribution is NOT stored on the notifications row
 * itself — it lives on the originating event referenced by
 * `source_event_id`. We LEFT JOIN through `events` to surface it on the
 * row so the UI's `[steward-agent]` / `[cowork-claude]` source-badge
 * works without a second round-trip.
 *
 * Hop-depth (`↩ N hops` chip) is NOT computed here — that's the P4
 * walker's job. The fetcher just emits the leaf row; the page
 * lazy-loads depth when the operator hovers.
 */
import type { Database } from '../../../db/index.js';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStatus,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface NotificationsHistoryQuery extends HistoryQuery {
  /** Filter by notification severity (info / warn / crit). */
  severity?: 'info' | 'warn' | 'crit';
  /** Filter by the source event's source_agent
   *  (operator / steward-agent / cowork-claude / cc / federated peer). */
  sourceAgent?: string;
}

export interface NotificationsHistorySources {
  db: Database;
}

export interface NotificationPayload {
  id: string;
  correlation_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  source_event_id?: string;
  source_agent?: string;
  created_at: number;
  delivered_channels?: string;
  failed_channels?: string;
  consumed_at?: number | null;
  consumed_by?: string | null;
  dispatched_at?: number | null;
  /** True when the notification has an action_id set — drawer surfaces
   *  the action labels via actions_json. */
  has_actions: boolean;
}

interface NotificationRow {
  id: string;
  correlation_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  source_event_id: string | null;
  source_event_agent: string | null;
  created_at: number;
  actions_json: string | null;
  delivered_channels: string | null;
  failed_channels: string | null;
  consumed_at: number | null;
  consumed_by: string | null;
  dispatched_at: number | null;
}

function severityToStatus(sev: string, failed: string | null): HistoryStatus {
  if (failed && failed.length > 0) return 'failure';
  if (sev === 'crit') return 'failure';
  if (sev === 'warn') return 'pending';
  return 'success';
}

export function fetchNotificationsHistory(
  sources: NotificationsHistorySources,
  query: NotificationsHistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const where: string[] = [];
  const params: unknown[] = [];
  if (since) {
    where.push('n.created_at >= ?');
    params.push(Date.parse(since));
  }
  if (until) {
    where.push('n.created_at < ?');
    params.push(Date.parse(until));
  }
  if (query.severity) {
    where.push('n.severity = ?');
    params.push(query.severity);
  }
  if (query.sourceAgent) {
    where.push('e.source_agent = ?');
    params.push(query.sourceAgent);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = sources.db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications n
       LEFT JOIN events e ON e.id = n.source_event_id ${whereSql}`,
    )
    .get(...params) as { c: number };

  const rows = sources.db
    .prepare(
      `SELECT n.id, n.correlation_id, n.kind, n.severity, n.title, n.body,
              n.source_event_id, e.source_agent AS source_event_agent,
              n.created_at, n.actions_json, n.delivered_channels, n.failed_channels,
              n.consumed_at, n.consumed_by, n.dispatched_at
       FROM notifications n
       LEFT JOIN events e ON e.id = n.source_event_id
       ${whereSql}
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as NotificationRow[];

  const items: HistoryItem[] = rows.map((row) => {
    const payload: NotificationPayload = {
      id: row.id,
      correlation_id: row.correlation_id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      source_event_id: row.source_event_id ?? undefined,
      source_agent: row.source_event_agent ?? undefined,
      created_at: row.created_at,
      delivered_channels: row.delivered_channels ?? undefined,
      failed_channels: row.failed_channels ?? undefined,
      consumed_at: row.consumed_at,
      consumed_by: row.consumed_by,
      dispatched_at: row.dispatched_at,
      has_actions: Boolean(row.actions_json && row.actions_json.length > 2),
    };
    return {
      kind: 'notification',
      id: row.id,
      at: new Date(row.created_at).toISOString(),
      title: row.title,
      actor: row.source_event_agent ?? 'system',
      correlation_id: row.correlation_id,
      status: severityToStatus(row.severity, row.failed_channels),
      payload,
    };
  });

  return {
    items,
    next_cursor: nextCursor(offset, limit, rows.length),
    total_estimate: totalRow.c,
  };
}
