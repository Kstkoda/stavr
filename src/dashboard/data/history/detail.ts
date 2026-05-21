/**
 * Per-kind detail renderer. Given a kind + id, look up the underlying
 * record and return an HTML body for the side drawer.
 *
 * Read-only by construction. Returns `{ html, missing? }` so the page
 * can surface "the BOM file no longer exists on disk" + suchlike
 * gracefully (BOM Footgun #4).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { renderSafeMarkdown } from '../../components/history-drawer.js';
import { renderSourceLink, gitHubCommitUrl, gitHubPrUrl } from '../../components/source-link.js';

export interface DetailSources {
  db: Database.Database;
  bomsDir: string;
  /** GitHub repo coords (owner/name) for commit/PR cross-links. Optional. */
  githubRepo?: string;
}

export interface DetailResult {
  html: string;
  missing?: boolean;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dl(rows: Array<[string, string | undefined | null]>): string {
  const filtered = rows.filter(([, v]) => v != null && v !== '');
  if (filtered.length === 0) return '';
  return `<dl>${filtered.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>`;
}

function renderBomFileDetail(id: string, bomsDir: string): DetailResult {
  const abs = join(bomsDir, id);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return {
      missing: true,
      html: `<p class="hist-drawer-missing">BOM file no longer on disk — only the dispatch event is preserved. Original filename: <code>proposed/${escapeHtml(id)}</code></p>`,
    };
  }
  // Strip the YAML frontmatter from the rendered body — it shows in dl
  // above instead. Keep the rest as markdown.
  let body = raw;
  if (raw.startsWith('---')) {
    const closeIdx = raw.indexOf('\n---', 3);
    if (closeIdx > -1) body = raw.slice(closeIdx + 4);
  }
  return {
    html: [
      `<header><strong>${escapeHtml(id)}</strong></header>`,
      `<div class="bom-md">${renderSafeMarkdown(body)}</div>`,
    ].join(''),
  };
}

function renderDecisionDetail(id: string, db: Database.Database): DetailResult {
  const row = db.prepare(`SELECT * FROM decisions WHERE correlation_id = ?`).get(id) as
    | {
        correlation_id: string;
        question: string;
        options_json: string;
        default_option_id: string | null;
        timeout_sec: number;
        status: string;
        requested_at: string;
        expires_at: string;
        responded_at: string | null;
        responded_by: string | null;
        chosen_option_id: string | null;
        response_reason: string | null;
      }
    | undefined;
  if (!row) return { missing: true, html: `<p class="hist-drawer-missing">Decision not found.</p>` };
  const options = JSON.parse(row.options_json) as Array<{ id: string; label: string }>;
  return {
    html: [
      `<h1>${escapeHtml(row.question)}</h1>`,
      dl([
        ['Correlation id', row.correlation_id],
        ['Status',         row.status],
        ['Requested at',   row.requested_at],
        ['Expires at',     row.expires_at],
        ['Responded at',   row.responded_at],
        ['Responder',      row.responded_by],
        ['Chosen option',  row.chosen_option_id],
        ['Reason',         row.response_reason],
      ]),
      `<h2>Options offered</h2>`,
      `<ul>${options.map((o) => `<li><code>${escapeHtml(o.id)}</code> — ${escapeHtml(o.label)}</li>`).join('')}</ul>`,
    ].join(''),
  };
}

function renderScopeDetail(id: string, db: Database.Database): DetailResult {
  const row = db.prepare(`SELECT * FROM trust_scopes WHERE id = ?`).get(id) as
    | {
        id: string;
        title: string;
        description: string;
        granted_by: string;
        granted_at: string;
        expires_at: string;
        status: string;
        allowed_actions_json: string;
        spec_url: string | null;
        actions_executed: number;
        expires_after_actions: number | null;
        completed_at: string | null;
      }
    | undefined;
  if (!row) return { missing: true, html: `<p class="hist-drawer-missing">Scope not found.</p>` };
  const allowed = JSON.parse(row.allowed_actions_json) as Array<{ tool: string }>;
  const actions = db.prepare(
    `SELECT id, tool_name, executed_at FROM scope_actions WHERE scope_id = ? ORDER BY executed_at ASC LIMIT 50`,
  ).all(id) as Array<{ id: string; tool_name: string; executed_at: string }>;
  return {
    html: [
      `<h1>${escapeHtml(row.title)}</h1>`,
      `<p>${escapeHtml(row.description)}</p>`,
      dl([
        ['Scope id',          row.id],
        ['Status',            row.status],
        ['Granted by',        row.granted_by],
        ['Granted at',        row.granted_at],
        ['Expires at',        row.expires_at],
        ['Actions executed',  String(row.actions_executed)],
        ['Action cap',        row.expires_after_actions == null ? null : String(row.expires_after_actions)],
        ['Completed at',      row.completed_at],
      ]),
      `<h2>Allowed actions</h2>`,
      `<ul>${allowed.map((a) => `<li><code>${escapeHtml(a.tool)}</code></li>`).join('')}</ul>`,
      actions.length > 0
        ? `<h2>Action log</h2><ol>${actions.map((a) => `<li><code>${escapeHtml(a.tool_name)}</code> · ${escapeHtml(a.executed_at)}</li>`).join('')}</ol>`
        : '',
    ].join(''),
  };
}

function renderPlanDetail(id: string, db: Database.Database): DetailResult {
  const row = db.prepare(`SELECT * FROM boms WHERE id = ?`).get(id) as
    | {
        id: string;
        goal: string;
        requester: string;
        correlation_id: string;
        status: string;
        active_version: number;
        proposed_at: string;
        approved_at: string | null;
        started_at: string | null;
        ended_at: string | null;
        scope_id: string | null;
      }
    | undefined;
  if (!row) return { missing: true, html: `<p class="hist-drawer-missing">Plan not found.</p>` };
  const steps = db.prepare(
    `SELECT step_no, title, status, capability FROM bom_steps WHERE bom_id = ? AND version = ? ORDER BY step_no ASC`,
  ).all(id, row.active_version) as Array<{ step_no: number; title: string; status: string; capability: string }>;
  return {
    html: [
      `<h1>${escapeHtml(row.goal)}</h1>`,
      dl([
        ['Plan id',        row.id],
        ['Status',         row.status],
        ['Requester',      row.requester],
        ['Correlation id', row.correlation_id],
        ['Scope',          row.scope_id],
        ['Proposed at',    row.proposed_at],
        ['Approved at',    row.approved_at],
        ['Started at',     row.started_at],
        ['Ended at',       row.ended_at],
      ]),
      steps.length > 0
        ? `<h2>Steps</h2><ol>${steps.map((s) => `<li>[${escapeHtml(s.status)}] <code>${escapeHtml(s.capability)}</code> — ${escapeHtml(s.title)}</li>`).join('')}</ol>`
        : `<p>No steps recorded.</p>`,
    ].join(''),
  };
}

function renderHostExecDetail(id: string, db: Database.Database): DetailResult {
  const start = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
    | { id: string; kind: string; correlation_id: string | null; payload_json: string; at: string }
    | undefined;
  if (!start) return { missing: true, html: `<p class="hist-drawer-missing">host_exec event not found.</p>` };
  const payload = JSON.parse(start.payload_json) as Record<string, unknown>;
  const completed = start.correlation_id
    ? db.prepare(
        `SELECT payload_json FROM events WHERE kind = 'host_exec_completed' AND correlation_id = ? LIMIT 1`,
      ).get(start.correlation_id) as { payload_json: string } | undefined
    : undefined;
  const tail = completed ? (JSON.parse(completed.payload_json) as Record<string, unknown>) : {};
  // BOM Open Q §2: cap each arg display at 200 chars; show-raw toggle
  // exposes the rest. Args themselves are not stored — only the hash and
  // count. We surface that meta + a show-raw of the full payload JSON.
  const rawPayload = escapeHtml(JSON.stringify({ start: payload, completed: tail }, null, 2));
  return {
    html: [
      `<h1>${escapeHtml(String(payload.command ?? '(host_exec)'))}</h1>`,
      dl([
        ['Correlation id', start.correlation_id ?? ''],
        ['Scope id',       String(payload.scope_id ?? '')],
        ['Started at',     start.at],
        ['Timeout (ms)',   String(payload.timeout_ms ?? '')],
        ['Args count',     String(payload.args_count ?? '')],
        ['Args hash',      String(payload.args_hash ?? '')],
        ['Caller',         String(payload.caller ?? '')],
        ['Exit code',      tail.exit_code != null ? String(tail.exit_code) : null],
        ['Duration (ms)',  tail.duration_ms != null ? String(tail.duration_ms) : null],
        ['stdout (len)',   tail.stdout_len != null ? String(tail.stdout_len) : null],
        ['stderr (len)',   tail.stderr_len != null ? String(tail.stderr_len) : null],
        ['Timed out',      tail.timed_out === true ? 'yes' : tail.timed_out === false ? 'no' : null],
      ]),
      `<button type="button" class="hist-drawer-show-raw" data-role="show-raw">Show raw</button>`,
      `<pre class="hist-drawer-raw" hidden><code>${rawPayload}</code></pre>`,
    ].join(''),
  };
}

function renderCommitDetail(id: string, repo?: string): DetailResult {
  const url = repo ? gitHubCommitUrl(id, repo) : null;
  return {
    html: [
      `<h1>Commit <code>${escapeHtml(id.slice(0, 12))}</code></h1>`,
      url ? `<p>${renderSourceLink({ href: url, label: 'View on GitHub' })}</p>` : `<p>No GitHub repo coords configured — commit lives in local git history.</p>`,
    ].join(''),
  };
}

function renderCiDetail(id: string, db: Database.Database): DetailResult {
  // CI runs aren't persisted in our DB — we only have the URL passed via
  // the page's runs array. The drawer surfaces a minimal "click out"
  // hint; the operator's primary affordance is the row's own ↗ link.
  void id;
  void db;
  return {
    html: `<p>CI runs open on GitHub Actions — use the row's ↗ link.</p>`,
  };
}

function renderNotificationDetail(id: string, db: Database.Database): DetailResult {
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as
    | {
        id: string;
        correlation_id: string;
        kind: string;
        severity: string;
        title: string;
        body: string;
        created_at: number;
        delivered_channels: string | null;
        failed_channels: string | null;
        consumed_at: number | null;
        consumed_by: string | null;
      }
    | undefined;
  if (!row) return { missing: true, html: `<p class="hist-drawer-missing">Notification not found.</p>` };
  return {
    html: [
      `<h1>${escapeHtml(row.title)}</h1>`,
      `<p>${escapeHtml(row.body)}</p>`,
      dl([
        ['Kind',               row.kind],
        ['Severity',           row.severity],
        ['Correlation id',     row.correlation_id],
        ['Created at (epoch)', String(row.created_at)],
        ['Delivered to',       row.delivered_channels],
        ['Failed channels',    row.failed_channels],
        ['Consumed at',        row.consumed_at == null ? null : String(row.consumed_at)],
        ['Consumed by',        row.consumed_by],
      ]),
    ].join(''),
  };
}

export function renderHistoryDetail(
  kind: string,
  id: string,
  sources: DetailSources,
): DetailResult {
  switch (kind) {
    case 'bom-file':     return renderBomFileDetail(id, sources.bomsDir);
    case 'decision':     return renderDecisionDetail(id, sources.db);
    case 'scope':        return renderScopeDetail(id, sources.db);
    case 'plan':         return renderPlanDetail(id, sources.db);
    case 'host-exec':    return renderHostExecDetail(id, sources.db);
    case 'commit':       return renderCommitDetail(id, sources.githubRepo);
    case 'ci':           return renderCiDetail(id, sources.db);
    case 'notification': return renderNotificationDetail(id, sources.db);
    default:             return { missing: true, html: `<p class="hist-drawer-missing">Unknown kind: ${escapeHtml(kind)}</p>` };
  }
}

/** Public re-export so callers don't reach into the gitHubCommitUrl module. */
export { gitHubCommitUrl, gitHubPrUrl };
