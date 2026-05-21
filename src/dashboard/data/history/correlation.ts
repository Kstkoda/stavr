/**
 * Correlation walker. Given a starting node (kind + id or a bare
 * correlation_id), walks every related event across all sources and
 * returns an ordered list.
 *
 * Kind-agnostic by design: the walk follows `correlation_id` linkage,
 * not the kind enum. New event kinds (LLM-call, DB-query, MCP-traffic,
 * federation-traffic per ADR-041) become walkable the moment they
 * carry a correlation_id — no walker code change required.
 *
 * Direction:
 *   - `forward`  — useful when reviewing a dispatch's outcome ("what
 *                  happened after I granted this scope?"). Sorts ASC by
 *                  `at` so the operator reads top-down.
 *   - `backward` — useful when responding to a notification ("where did
 *                  this come from?"). Sorts DESC by `at` and the head of
 *                  the list is the most recent terminal event, with the
 *                  originating operator action at the tail.
 *
 * Implementation: we resolve the start node's correlation_id, then
 * fetch every row across all sources sharing that cid, plus the
 * notification's source_event link (parent edge). The "graph" is
 * mostly a chain in practice; we return a flattened DAG with
 * indent-depth annotations so the UI can render it as a tree.
 */
import type Database from 'better-sqlite3';
import type { HistoryItem, HistoryKind } from './types.js';
import { fetchDecisionsHistory } from './decisions.js';
import { fetchScopesHistory } from './scopes.js';
import { fetchPlansHistory } from './plans.js';
import { fetchHostExecHistory } from './host-exec.js';
import { fetchNotificationsHistory } from './notifications.js';

export type TraceDirection = 'forward' | 'backward';

export interface TraceNode {
  item: HistoryItem;
  /** Depth in the rendered tree. 0 = origin/terminal, 1+ = descendants. */
  depth: number;
  /** Optional parent reference for the UI's collapse/expand affordance. */
  parent?: { kind: HistoryKind; id: string };
}

export interface TraceResult {
  direction: TraceDirection;
  /** Resolved correlation_id used to drive the walk. NULL when the
   *  starting node had no correlation hint. */
  correlation_id: string | null;
  /** Origin node — the row the operator clicked. */
  origin: HistoryItem | null;
  /** All nodes in the trace, ordered for direct UI render. */
  nodes: TraceNode[];
  /** Hop depth — number of distinct events in the chain (excluding the
   *  origin). The notification row badge surfaces this as `↩ N hops`. */
  hop_depth: number;
}

export interface CorrelationSources {
  db: Database.Database;
}

interface EventRow {
  id: string;
  kind: string;
  correlation_id: string | null;
  source_agent: string;
  payload_json: string;
  at: string;
}

function safeJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

/**
 * Resolve the canonical correlation_id for a starting node. Falls back
 * through several lookup paths because not every kind stores its
 * correlation_id in the same column.
 */
function resolveCorrelationId(
  kind: string,
  id: string,
  db: Database.Database,
): string | null {
  switch (kind) {
    case 'decision': {
      // For decisions, the row id IS the correlation_id.
      const row = db.prepare(`SELECT correlation_id FROM decisions WHERE correlation_id = ?`).get(id) as { correlation_id: string } | undefined;
      return row?.correlation_id ?? id;
    }
    case 'scope': {
      // Trust scopes use their own id; we treat that as the correlation
      // hint so host_execs tagged with the scope id thread to the scope.
      return id;
    }
    case 'plan': {
      const row = db.prepare(`SELECT correlation_id FROM boms WHERE id = ?`).get(id) as { correlation_id: string } | undefined;
      return row?.correlation_id ?? null;
    }
    case 'host-exec': {
      const row = db.prepare(`SELECT correlation_id FROM events WHERE id = ?`).get(id) as { correlation_id: string | null } | undefined;
      return row?.correlation_id ?? null;
    }
    case 'notification': {
      const row = db.prepare(`SELECT correlation_id FROM notifications WHERE id = ?`).get(id) as { correlation_id: string } | undefined;
      return row?.correlation_id ?? null;
    }
    case 'commit':
    case 'ci':
    case 'bom-file':
    default:
      return null;
  }
}

/**
 * Walk every source for rows sharing the given correlation_id. We rely
 * on the per-source fetchers' read-only contract; pass a wide range
 * (last 90d) so we don't drop rows older than the page's current view.
 */
function fetchByCorrelation(
  db: Database.Database,
  correlationId: string,
): HistoryItem[] {
  const wideRange = {
    since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
    limit: 500,
  };
  const items: HistoryItem[] = [];

  // Decisions are indexed by correlation_id directly.
  try {
    const decisionPage = fetchDecisionsHistory({ db }, wideRange);
    for (const it of decisionPage.items) {
      if (it.correlation_id === correlationId) items.push(it);
    }
  } catch { /* empty */ }

  try {
    const scopePage = fetchScopesHistory({ db }, wideRange);
    for (const it of scopePage.items) {
      if (it.correlation_id === correlationId || it.id === correlationId) items.push(it);
    }
  } catch { /* empty */ }

  try {
    const planPage = fetchPlansHistory({ db }, wideRange);
    for (const it of planPage.items) {
      if (it.correlation_id === correlationId) items.push(it);
    }
  } catch { /* empty */ }

  try {
    const hePage = fetchHostExecHistory({ db }, wideRange);
    for (const it of hePage.items) {
      if (it.correlation_id === correlationId) items.push(it);
      // host_exec scope_id also forms a thread for scope-rooted traces.
      const payload = it.payload as { scope_id?: string } | undefined;
      if (payload?.scope_id === correlationId) items.push(it);
    }
  } catch { /* empty */ }

  try {
    const notifPage = fetchNotificationsHistory({ db }, wideRange);
    for (const it of notifPage.items) {
      if (it.correlation_id === correlationId) items.push(it);
    }
  } catch { /* empty */ }

  // Dedupe by kind:id (a host_exec can match both correlation_id and
  // scope_id filters above when its scope happens to equal the cid).
  const seen = new Set<string>();
  const deduped: HistoryItem[] = [];
  for (const it of items) {
    const key = `${it.kind}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  return deduped;
}

/**
 * Resolve the parent edge for a notification: its source_event row,
 * which is itself an event in the events table. The returned row is
 * shaped like an EventRow; the caller may further translate it.
 */
function resolveNotificationParent(
  db: Database.Database,
  notificationId: string,
): EventRow | null {
  const row = db.prepare(
    `SELECT e.id, e.kind, e.correlation_id, e.source_agent, e.payload_json, e.at
     FROM notifications n
     LEFT JOIN events e ON e.id = n.source_event_id
     WHERE n.id = ? AND e.id IS NOT NULL`,
  ).get(notificationId) as EventRow | undefined;
  return row ?? null;
}

function eventRowToItem(row: EventRow): HistoryItem {
  const payload = safeJson<Record<string, unknown>>(row.payload_json) ?? {};
  return {
    kind: 'host-exec',
    id: row.id,
    at: row.at,
    title: String(payload.message ?? payload.title ?? row.kind),
    actor: row.source_agent,
    correlation_id: row.correlation_id ?? undefined,
  };
}

export function walkCorrelation(
  sources: CorrelationSources,
  start: { kind: string; id: string },
  direction: TraceDirection = 'forward',
): TraceResult {
  const cid = resolveCorrelationId(start.kind, start.id, sources.db);
  if (!cid) {
    return { direction, correlation_id: null, origin: null, nodes: [], hop_depth: 0 };
  }
  const items = fetchByCorrelation(sources.db, cid);

  // Identify the origin row (the one the operator clicked). May not be
  // present in items if the start was the kind itself; for backward
  // walks from a notification, the parent event is fetched separately.
  let origin: HistoryItem | null = items.find(
    (it) => it.kind === (start.kind as HistoryKind) && it.id === start.id,
  ) ?? null;

  // For backward walks from a notification, augment with the parent
  // event (decision_request / scope_proposed / etc.) so the chain
  // reaches the operator-action root.
  if (direction === 'backward' && start.kind === 'notification') {
    const parent = resolveNotificationParent(sources.db, start.id);
    if (parent) {
      const parentItem = eventRowToItem(parent);
      // Avoid duplicating if a fetcher already surfaced it.
      const dupe = items.some((it) => it.id === parentItem.id);
      if (!dupe) items.push(parentItem);
    }
  }

  // Sort.
  const sorted = [...items].sort((a, b) =>
    direction === 'forward'
      ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
      : (a.at < b.at ? 1 : a.at > b.at ? -1 : 0),
  );

  // Flat depth model: origin at depth 0; everything else at depth 1.
  // A richer model (full DAG per host_exec / commit edges) is a v0.8.1
  // candidate — this is enough to give the operator a chain view.
  const nodes: TraceNode[] = sorted.map((item) => ({
    item,
    depth: origin && item.kind === origin.kind && item.id === origin.id ? 0 : 1,
  }));

  const hopDepth = nodes.filter((n) => n.depth > 0).length;
  return {
    direction,
    correlation_id: cid,
    origin,
    nodes,
    hop_depth: hopDepth,
  };
}

/**
 * Render a trace into HTML. The drawer fetches the JSON shape and
 * either delegates to this or its own renderer; we expose it here so
 * the API endpoint + tests can share rendering.
 */
export function renderTraceHtml(trace: TraceResult): string {
  if (!trace.correlation_id) {
    return `<p class="hist-drawer-missing">No correlation_id on this row — nothing to trace.</p>`;
  }
  const header = [
    `<header><strong>${trace.direction === 'forward' ? 'TRACE FORWARD from origin' : 'TRACE BACKWARD from notification'}</strong></header>`,
    `<p><code>${escapeHtml(trace.correlation_id)}</code> · ${trace.hop_depth} hop${trace.hop_depth === 1 ? '' : 's'}</p>`,
  ].join('');
  if (trace.nodes.length === 0) {
    return `${header}<p>No events found for this correlation.</p>`;
  }
  const items = trace.nodes.map((n) => {
    const cls = n.depth === 0 ? 'trace-node trace-origin' : 'trace-node';
    return [
      `<li class="${cls}" data-kind="${escapeHtml(n.item.kind)}" data-id="${escapeHtml(n.item.id)}">`,
      `<span class="trace-time">${escapeHtml((n.item.at || '').slice(11, 19))}</span>`,
      `<span class="trace-kind">${escapeHtml(n.item.kind)}</span>`,
      `<span class="trace-title">${escapeHtml(n.item.title)}</span>`,
      `<span class="trace-actor">${escapeHtml(n.item.actor)}</span>`,
      `</li>`,
    ].join('');
  }).join('');
  return `${header}<ol class="trace-list">${items}</ol>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
