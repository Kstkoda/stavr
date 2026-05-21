/**
 * Host-exec history. Materializes a row per `host_exec_started` event,
 * with the matching `host_exec_completed` event (looked up by
 * correlation_id) folded in for the drawer.
 *
 * Why started, not completed? Because a started-without-completed
 * (timed-out / killed) is still a host_exec that the operator should see.
 * Sorting by `started` keeps the timeline coherent: events near each
 * other in time stay near each other in the row order, regardless of
 * which side of the start/complete pair completed first.
 */
import type Database from 'better-sqlite3';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface HostExecHistoryQuery extends HistoryQuery {
  /** Filter by scope_id. The drawer uses this to thread "all execs under
   *  this scope" without a second query. */
  scopeId?: string;
  /** Filter by command name (substring match on the started payload). */
  command?: string;
}

export interface HostExecHistorySources {
  db: Database.Database;
}

export interface HostExecPayload {
  correlation_id: string;
  command: string;
  scope_id: string;
  args_count: number;
  cwd?: string;
  timeout_ms: number;
  caller?: string;
  /** Filled when the matching completed event exists. */
  exit_code?: number | null;
  duration_ms?: number;
  stdout_len?: number;
  stderr_len?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  timed_out?: boolean;
  /** True when a started event exists but no completed — operator sees
   *  the exec as "in flight" or killed without a clean tail. */
  open?: boolean;
}

interface EventRow {
  id: string;
  kind: string;
  correlation_id: string | null;
  source_agent: string;
  payload_json: string;
  at: string;
}

function safeJsonParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

export function fetchHostExecHistory(
  sources: HostExecHistorySources,
  query: HostExecHistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const where: string[] = [`kind IN ('host_exec_started', 'host_exec_denied')`];
  const params: unknown[] = [];
  if (since) {
    where.push('at >= ?');
    params.push(since);
  }
  if (until) {
    where.push('at < ?');
    params.push(until);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // Over-fetch so we can apply scope/command filters after the JSON parse.
  const overFetch = Math.max(limit * 3, 50);
  const rows = sources.db
    .prepare(
      `SELECT id, kind, correlation_id, source_agent, payload_json, at
       FROM events ${whereSql} ORDER BY at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, overFetch + offset, 0) as EventRow[];

  // Count is approximate — we use the same WHERE without the JSON filter
  // so the page's "1k+" indicator stays meaningful.
  const totalRow = sources.db
    .prepare(`SELECT COUNT(*) AS c FROM events ${whereSql}`)
    .get(...params) as { c: number };

  // Fetch all corresponding completed events in one shot. We bound this
  // by the same time window to keep the lookup cheap.
  const completedRows = sources.db
    .prepare(
      `SELECT correlation_id, payload_json FROM events
       WHERE kind = 'host_exec_completed' ${since ? 'AND at >= ?' : ''} ${until ? 'AND at < ?' : ''}`,
    )
    .all(...(since ? [since] : []), ...(until ? [until] : [])) as Array<{
      correlation_id: string | null;
      payload_json: string;
    }>;
  const completedByCid = new Map<string, Record<string, unknown>>();
  for (const r of completedRows) {
    if (!r.correlation_id) continue;
    const p = safeJsonParse<Record<string, unknown>>(r.payload_json);
    if (p) completedByCid.set(r.correlation_id, p);
  }

  const items: HistoryItem[] = [];
  for (const row of rows) {
    if (items.length >= offset + limit) break;
    const payload = safeJsonParse<Record<string, unknown>>(row.payload_json);
    if (!payload) continue;
    const command = String(payload.command ?? '');
    const scope_id = String(payload.scope_id ?? '');
    if (query.scopeId && scope_id !== query.scopeId) continue;
    if (query.command && !command.includes(query.command)) continue;
    const cid = row.correlation_id ?? undefined;
    const completed = cid ? completedByCid.get(cid) : undefined;
    const denied = row.kind === 'host_exec_denied';

    const hePayload: HostExecPayload = {
      correlation_id: cid ?? '',
      command,
      scope_id,
      args_count: Number(payload.args_count ?? 0),
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      timeout_ms: Number(payload.timeout_ms ?? 0),
      caller: typeof payload.caller === 'string' ? payload.caller : undefined,
      ...(completed ? {
        exit_code: typeof completed.exit_code === 'number' ? completed.exit_code : null,
        duration_ms: Number(completed.duration_ms ?? 0),
        stdout_len: Number(completed.stdout_len ?? 0),
        stderr_len: Number(completed.stderr_len ?? 0),
        stdout_truncated: Boolean(completed.stdout_truncated),
        stderr_truncated: Boolean(completed.stderr_truncated),
        timed_out: Boolean(completed.timed_out),
      } : { open: !denied }),
    };

    items.push({
      kind: 'host-exec',
      id: row.id,
      at: row.at,
      title: command || '(host_exec)',
      actor: row.source_agent,
      correlation_id: cid,
      status: denied
        ? 'failure'
        : completed
          ? (completed.exit_code === 0 ? 'success' : 'failure')
          : 'in-progress',
      payload: hePayload,
    });
  }
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    next_cursor: nextCursor(offset, limit, page.length),
    total_estimate: totalRow.c,
  };
}
