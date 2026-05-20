/**
 * Diagnostics drill pages — Connections / Workers / Federation / Alerts.
 *
 * Phase 4 (v0.6.12): real pages. Each shares the same template (breadcrumb,
 * title, summary tiles, roster table, recent events tail) so the operator
 * doesn't have to re-orient between drills.
 *
 * Engine detail is in pages/diagnostics.ts (the existing dense layout,
 * enhanced in Phase 3 with the 4-section jump-bar).
 */
import type { WorkerRecord } from '../../persistence.js';
import type { InstalledBrickLite } from '../adapters/topology.js';
import { renderShell } from '../shell.js';
import { fetchWorkerCounters } from '../data/worker-counters.js';
import { deriveLifecycleState } from '../../workers/lifecycle.js';

export type DiagnosticsDetailId = 'connections' | 'workers' | 'federation' | 'alerts';

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DETAIL_CSS = `
.diag-detail {
  display: flex; flex-direction: column; gap: 16px;
  padding: 4px 0;
}
.diag-bread {
  font-family: var(--mono); font-size: 11px; color: var(--ink-2);
  display: flex; align-items: center; gap: 8px;
}
.diag-bread a { color: var(--rust); }
.diag-bread .sep { color: var(--ink-3); }
.diag-detail-head { display: flex; align-items: baseline; justify-content: space-between; }
.diag-detail-title { margin: 0; font-size: 22px; font-weight: 500; color: var(--ink-0); }
.diag-detail-sub  { font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
.diag-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.diag-summary-tile {
  padding: 12px 14px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  display: flex; flex-direction: column; gap: 4px;
}
.diag-summary-tile .l {
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-3);
}
.diag-summary-tile .v {
  font-family: var(--mono); font-size: 18px;
  color: var(--ink-0);
}
.diag-summary-tile.ok   .v { color: var(--ok); }
.diag-summary-tile.warn .v { color: var(--warn); }
.diag-summary-tile.crit .v { color: var(--crit); }
.diag-summary-tile.idle .v { color: var(--ink-2); }
.diag-table {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.diag-table-head {
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2);
  display: flex; align-items: baseline; justify-content: space-between;
}
.diag-table table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; }
.diag-table th, .diag-table td {
  padding: 5px 6px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  color: var(--ink-1);
}
.diag-table th {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-3);
  font-weight: 500;
}
.diag-table tr:hover td { background: rgba(255,255,255,0.03); }
.diag-pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px;
  font-family: var(--mono);
}
.diag-pill.ok   { background: rgba(109,213,140,0.12); color: var(--ok); }
.diag-pill.warn { background: rgba(226,169,66,0.14);  color: var(--warn); }
.diag-pill.crit { background: rgba(239,90,111,0.14);  color: var(--crit); }
.diag-pill.idle { background: rgba(155,155,155,0.10); color: var(--ink-2); }
.diag-empty {
  padding: 18px; text-align: center;
  font-family: var(--mono); font-size: 12px;
  color: var(--ink-3); font-style: italic;
}
.diag-related {
  display: flex; gap: 10px; flex-wrap: wrap;
  font-family: var(--mono); font-size: 11px;
}
.diag-related a {
  padding: 5px 12px; border-radius: 6px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--line-2);
  color: var(--ink-1);
}
.diag-related a:hover { color: var(--ink-0); border-color: var(--rust); }
`;

interface DetailHeaderProps {
  id: DiagnosticsDetailId;
  title: string;
  sub: string;
}

function renderHeader(p: DetailHeaderProps): string {
  return [
    `<div class="diag-bread">`,
    `<a href="/dashboard/diagnostics">Diagnostics</a>`,
    `<span class="sep">/</span>`,
    `<span>${escapeHtml(p.id)}</span>`,
    `</div>`,
    `<div class="diag-detail-head">`,
    `<div>`,
    `<h1 class="diag-detail-title">${escapeHtml(p.title)}</h1>`,
    `<div class="diag-detail-sub">${escapeHtml(p.sub)}</div>`,
    `</div>`,
    `</div>`,
  ].join('');
}

// =================== Connections ===================
export function renderConnectionsDetail(bricks: InstalledBrickLite[] = []): string {
  const enabled = bricks.filter((b) => b.enabled);
  const disabled = bricks.filter((b) => !b.enabled);
  const summary = [
    { l: 'Live', v: String(enabled.length), cls: enabled.length > 0 ? 'ok' : 'idle' },
    { l: 'Disabled', v: String(disabled.length), cls: 'idle' },
    { l: 'Total registered', v: String(bricks.length), cls: 'idle' },
  ];
  const rows = enabled.map((b) => [
    `<tr>`,
    `<td>${escapeHtml(b.display_name || b.id)}</td>`,
    `<td>${escapeHtml(b.kind || 'mcp-remote')}</td>`,
    `<td><span data-role="conn-${escapeHtml(b.id)}-qps">·</span></td>`,
    `<td><span data-role="conn-${escapeHtml(b.id)}-p95">·</span></td>`,
    `<td><span data-role="conn-${escapeHtml(b.id)}-err">0%</span></td>`,
    `<td><span class="diag-pill ok">live</span></td>`,
    `</tr>`,
  ].join('')).join('');

  const body = [
    `<div class="diag-detail">`,
    renderHeader({ id: 'connections', title: 'Connections', sub: 'MCP servers, per-row latency + error rate. Live polling every 30s.' }),
    `<div class="diag-summary">`,
    summary.map((s) => `<div class="diag-summary-tile ${s.cls}"><div class="l">${escapeHtml(s.l)}</div><div class="v">${escapeHtml(s.v)}</div></div>`).join(''),
    `</div>`,
    `<div class="diag-table">`,
    `<div class="diag-table-head"><span>MCP roster</span><span>${enabled.length} live</span></div>`,
    enabled.length === 0
      ? `<div class="diag-empty">No MCP servers registered. <a href="/dashboard/mcps" style="color:var(--rust);">Browse the catalog →</a></div>`
      : `<table><thead><tr><th>Server</th><th>Kind</th><th>qps</th><th>p95</th><th>err</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
    `</div>`,
    `<div class="diag-related">`,
    `<a href="/dashboard/mcps">manage MCPs →</a>`,
    `<a href="/dashboard/tools">browse tools →</a>`,
    `<a href="/dashboard/diagnostics/engine#traffic">engine · traffic →</a>`,
    `</div>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Diagnostics · connections',
    activePage: 'diagnostics',
    body,
    head: `<style>${DETAIL_CSS}</style>`,
  });
}

// =================== Workers ===================
export function renderWorkersDetail(workers: WorkerRecord[] = []): string {
  const now = Date.now();
  const counters = fetchWorkerCounters(workers, now);
  const crashed = counters.crashed + counters.killed_by_system;
  const summary = [
    { l: 'Active', v: String(counters.active), cls: counters.active > 0 ? 'ok' : 'idle' },
    { l: 'Lifetime', v: String(counters.total), cls: 'idle' },
    { l: 'Crashed', v: String(crashed), cls: crashed > 0 ? 'crit' : 'ok' },
  ];
  const rows = workers.map((w) => {
    const lifecycle = deriveLifecycleState(w, now);
    const cls: 'ok' | 'warn' | 'crit' | 'idle' =
      lifecycle === 'crashed' || lifecycle === 'killed-by-system' ? 'crit'
      : lifecycle === 'running' || lifecycle === 'starting' ? 'ok'
      : lifecycle === 'stale' || lifecycle === 'completed-error' || lifecycle === 'killed-by-operator' ? 'warn'
      : 'idle';
    return [
      `<tr>`,
      `<td>${escapeHtml(w.name || w.id)}</td>`,
      `<td>${escapeHtml(w.type)}</td>`,
      `<td style="color:var(--ink-3);">${escapeHtml(w.cwd ? w.cwd.slice(0, 30) : '—')}</td>`,
      `<td><span class="diag-pill ${cls}">${escapeHtml(lifecycle)}</span></td>`,
      `<td style="color:var(--ink-3);">${escapeHtml((w.started_at || '').slice(11, 19))}</td>`,
      `</tr>`,
    ].join('');
  }).join('');
  const body = [
    `<div class="diag-detail">`,
    renderHeader({ id: 'workers', title: 'Workers', sub: 'Active + last-4h workers (per Phase 5 retention). Per-worker output lives on the Streams page.' }),
    `<div class="diag-summary">`,
    summary.map((s) => `<div class="diag-summary-tile ${s.cls}"><div class="l">${escapeHtml(s.l)}</div><div class="v">${escapeHtml(s.v)}</div></div>`).join(''),
    `</div>`,
    `<div class="diag-table">`,
    `<div class="diag-table-head"><span>Worker roster</span><span>${workers.length} total</span></div>`,
    workers.length === 0
      ? `<div class="diag-empty">No workers yet. Workers spawn when CC dispatches or Steward runs a plan.</div>`
      : `<table><thead><tr><th>Name</th><th>Type</th><th>cwd</th><th>State</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table>`,
    `</div>`,
    `<div class="diag-related">`,
    `<a href="/dashboard/streams">live streams →</a>`,
    `<a href="/dashboard/topology">topology →</a>`,
    `</div>`,
    `</div>`,
  ].join('');
  return renderShell({
    title: 'Stavr — Diagnostics · workers',
    activePage: 'diagnostics',
    body,
    head: `<style>${DETAIL_CSS}</style>`,
  });
}

// =================== Federation ===================
export interface PeerLite {
  id: string;
  reachable: boolean;
  last_handshake_at?: string;
  latency_p95_ms?: number;
}

export function renderFederationDetail(peers: PeerLite[] = []): string {
  const reachable = peers.filter((p) => p.reachable).length;
  const summary = [
    { l: 'Peers configured', v: String(peers.length), cls: 'idle' },
    { l: 'Reachable', v: String(reachable), cls: reachable > 0 ? 'ok' : 'idle' },
    { l: 'Unreachable', v: String(peers.length - reachable), cls: peers.length - reachable > 0 ? 'warn' : 'idle' },
  ];
  const rows = peers.map((p) => [
    `<tr>`,
    `<td>${escapeHtml(p.id)}</td>`,
    `<td><span class="diag-pill ${p.reachable ? 'ok' : 'crit'}">${p.reachable ? 'reachable' : 'unreachable'}</span></td>`,
    `<td>${p.latency_p95_ms != null ? Math.round(p.latency_p95_ms) + 'ms' : '—'}</td>`,
    `<td style="color:var(--ink-3);">${escapeHtml((p.last_handshake_at || '—').slice(0, 19).replace('T', ' '))}</td>`,
    `</tr>`,
  ].join('')).join('');
  const body = [
    `<div class="diag-detail">`,
    renderHeader({ id: 'federation', title: 'Federation', sub: 'Peer roster from peers.yaml + mDNS discovery. Real post-v0.7.' }),
    `<div class="diag-summary">`,
    summary.map((s) => `<div class="diag-summary-tile ${s.cls}"><div class="l">${escapeHtml(s.l)}</div><div class="v">${escapeHtml(s.v)}</div></div>`).join(''),
    `</div>`,
    `<div class="diag-table">`,
    `<div class="diag-table-head"><span>Peer roster</span><span>${peers.length} configured</span></div>`,
    peers.length === 0
      ? `<div class="diag-empty">No peers configured. Add one in ~/.stavr/peers.yaml — see the <a href="/dashboard/family-mode" style="color:var(--rust);">family-mode quickstart →</a></div>`
      : `<table><thead><tr><th>Peer ID</th><th>Status</th><th>p95</th><th>Last handshake</th></tr></thead><tbody>${rows}</tbody></table>`,
    `</div>`,
    `<div class="diag-related">`,
    `<a href="/dashboard/family-mode">family-mode setup →</a>`,
    `<a href="/dashboard/permissions">cross-peer permissions →</a>`,
    `</div>`,
    `</div>`,
  ].join('');
  return renderShell({
    title: 'Stavr — Diagnostics · federation',
    activePage: 'diagnostics',
    body,
    head: `<style>${DETAIL_CSS}</style>`,
  });
}

// =================== Alerts ===================
export interface AlertLite {
  id: string;
  severity: 'ok' | 'warn' | 'crit';
  message: string;
  at: string;
  source?: string;
  acked?: boolean;
}

export function renderAlertsDetail(alerts: AlertLite[] = []): string {
  const active = alerts.filter((a) => !a.acked);
  const crit = active.filter((a) => a.severity === 'crit').length;
  const warn = active.filter((a) => a.severity === 'warn').length;
  const summary = [
    { l: 'Active', v: String(active.length), cls: active.length > 0 ? (crit > 0 ? 'crit' : 'warn') : 'ok' },
    { l: 'Critical', v: String(crit), cls: crit > 0 ? 'crit' : 'ok' },
    { l: 'Warnings', v: String(warn), cls: warn > 0 ? 'warn' : 'ok' },
    { l: 'Acknowledged (24h)', v: String(alerts.filter((a) => a.acked).length), cls: 'idle' },
  ];
  const rows = alerts.slice(0, 50).map((a) => [
    `<tr>`,
    `<td><span class="diag-pill ${a.severity}">${escapeHtml(a.severity)}</span></td>`,
    `<td>${escapeHtml(a.message)}</td>`,
    `<td style="color:var(--ink-3);">${escapeHtml(a.source || '—')}</td>`,
    `<td style="color:var(--ink-3);">${escapeHtml(a.at.slice(0, 19).replace('T', ' '))}</td>`,
    `<td>${a.acked ? '<span class="diag-pill idle">acked</span>' : '<span class="diag-pill warn">open</span>'}</td>`,
    `</tr>`,
  ].join('')).join('');
  const body = [
    `<div class="diag-detail">`,
    renderHeader({ id: 'alerts', title: 'Alerts', sub: 'Active warnings + recent history. Acks record to the event log (self-heal channel).' }),
    `<div class="diag-summary">`,
    summary.map((s) => `<div class="diag-summary-tile ${s.cls}"><div class="l">${escapeHtml(s.l)}</div><div class="v">${escapeHtml(s.v)}</div></div>`).join(''),
    `</div>`,
    `<div class="diag-table">`,
    `<div class="diag-table-head"><span>Alerts · latest 50</span><span>${alerts.length} total</span></div>`,
    alerts.length === 0
      ? `<div class="diag-empty">No alerts in the visible window. All clear.</div>`
      : `<table><thead><tr><th>Severity</th><th>Message</th><th>Source</th><th>At</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`,
    `</div>`,
    `<div class="diag-related">`,
    `<a href="/dashboard/diagnostics/engine#health">engine · health →</a>`,
    `<a href="/dashboard/settings">settings · channels →</a>`,
    `</div>`,
    `</div>`,
  ].join('');
  return renderShell({
    title: 'Stavr — Diagnostics · alerts',
    activePage: 'diagnostics',
    body,
    head: `<style>${DETAIL_CSS}</style>`,
  });
}

/**
 * Compatibility shim: the Phase 2 stub renderer used by the index.ts
 * router and tests still exists; it routes by id to the real detail
 * renderer with empty data. Existing tests that asserted "Phase 4" copy
 * are updated to assert on the real page content.
 */
export function renderDiagnosticsDetailStub(id: DiagnosticsDetailId): string {
  switch (id) {
    case 'connections': return renderConnectionsDetail([]);
    case 'workers':     return renderWorkersDetail([]);
    case 'federation':  return renderFederationDetail([]);
    case 'alerts':      return renderAlertsDetail([]);
  }
}
