/**
 * Home page — daemon at-a-glance. Four-card layout: health, active BOMs,
 * recent decisions, quick actions.
 *
 * Wire:  the server emits a fully-formed initial paint so the page is
 * useful before any JS runs. The client then subscribes to /dashboard/stream
 * and re-fetches /dashboard/home/data on every event (debounced) to refresh
 * the cards.
 */
import type { Bom, ProfileMode } from '../../types/stavr-bom.js';
import type { DecisionRecord } from '../../persistence.js';
import { renderShell } from '../shell.js';
import { renderFoodLabel } from '../components/food-label.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import { bomToFoodLabel } from '../adapters/bom.js';
import { decisionToFoodLabel } from '../adapters/decision.js';

export interface HomeData {
  health: {
    ok: boolean;
    version: string;
    port: number;
    started_at: string;
    uptime_sec: number;
    connected_clients: number;
    event_count: number;
    active_scopes: number;
    profile_mode: ProfileMode;
  };
  boms: { recent: Bom[]; total: number; open: number };
  decisions: { recent: DecisionRecord[]; open: number };
}

const PROFILE_PILL: Record<ProfileMode, { label: string; variant: PillVariant }> = {
  turbo:    { label: 'Turbo',    variant: 'profile-turbo' },
  balanced: { label: 'Balanced', variant: 'profile-balanced' },
  eco:      { label: 'Eco',      variant: 'profile-eco' },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function renderHealthCard(h: HomeData['health']): string {
  const pill = PROFILE_PILL[h.profile_mode];
  return [
    `<section class="card home-card home-health" data-slot="health">`,
    `<header class="home-card-head">`,
    `<h2 class="card-title">Daemon health</h2>`,
    `<a href="/dashboard/settings" class="profile-badge-link"`,
    ` title="Switch profile mode" data-role="profile-link">`,
    renderPill({ text: pill.label, variant: pill.variant, title: 'Active profile mode' }),
    `</a>`,
    `</header>`,
    `<dl class="kv">`,
    `<div class="kv-row"><dt>Status</dt><dd data-role="status">`,
    renderPill({ text: h.ok ? 'OK' : 'Down', variant: h.ok ? 'success' : 'danger' }),
    `</dd></div>`,
    `<div class="kv-row"><dt>Uptime</dt><dd data-role="uptime">${escapeHtml(formatUptime(h.uptime_sec))}</dd></div>`,
    `<div class="kv-row"><dt>Port</dt><dd data-role="port">${h.port}</dd></div>`,
    `<div class="kv-row"><dt>Version</dt><dd data-role="version">${escapeHtml(h.version)}</dd></div>`,
    `<div class="kv-row"><dt>Active scopes</dt><dd data-role="active-scopes">${h.active_scopes}</dd></div>`,
    `<div class="kv-row"><dt>Events</dt><dd data-role="event-count">${h.event_count}</dd></div>`,
    `</dl>`,
    `</section>`,
  ].join('');
}

function renderBomsCard(b: HomeData['boms']): string {
  const items = b.recent.length === 0
    ? `<div class="empty">No BOMs yet — <a href="/dashboard/plans">propose one</a>.</div>`
    : b.recent.map((bom) => renderFoodLabel(bomToFoodLabel(bom))).join('');
  return [
    `<section class="card home-card home-boms" data-slot="boms">`,
    `<header class="home-card-head">`,
    `<h2 class="card-title">Active BOMs · ${b.total}</h2>`,
    `<a href="/dashboard/plans" class="see-all">Plans →</a>`,
    `</header>`,
    `<div class="home-list" data-role="boms-list">${items}</div>`,
    `</section>`,
  ].join('');
}

function renderDecisionsCard(d: HomeData['decisions']): string {
  const items = d.recent.length === 0
    ? `<div class="empty">No decisions yet — everything ran without prompting.</div>`
    : d.recent.map((rec) => renderFoodLabel(decisionToFoodLabel(rec))).join('');
  return [
    `<section class="card home-card home-decisions" data-slot="decisions">`,
    `<header class="home-card-head">`,
    `<h2 class="card-title">Recent decisions · ${d.open} open</h2>`,
    `<a href="/dashboard/decide" class="see-all">Decide →</a>`,
    `</header>`,
    `<div class="home-list" data-role="decisions-list">${items}</div>`,
    `</section>`,
  ].join('');
}

function renderActionsCard(): string {
  const actions: Array<{ href: string; label: string; sub: string }> = [
    { href: '/dashboard/plans',    label: 'Open Plans',     sub: 'Approve / reject BOMs' },
    { href: '/dashboard/decide',   label: 'Open Decide',    sub: 'Resolve pending decisions' },
    { href: '/dashboard/topology', label: 'View Topology',  sub: 'Workers + connectors' },
    { href: '/dashboard/settings', label: 'Settings',       sub: 'Profile · scopes · no-go' },
  ];
  const items = actions.map((a) => [
    `<a class="action" href="${a.href}">`,
    `<span class="action-label">${escapeHtml(a.label)}</span>`,
    `<span class="action-sub">${escapeHtml(a.sub)}</span>`,
    `</a>`,
  ].join('')).join('');
  return [
    `<section class="card home-card home-actions" data-slot="actions">`,
    `<header class="home-card-head"><h2 class="card-title">Quick actions</h2></header>`,
    `<div class="action-grid">${items}</div>`,
    `</section>`,
  ].join('');
}

const HOME_CSS = `
.home-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: auto auto;
  gap: 16px;
}
@media (max-width: 900px) {
  .home-grid { grid-template-columns: 1fr; }
}
.home-card { display: flex; flex-direction: column; min-height: 220px; }
.home-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.home-card-head .card-title { margin: 0; }
.see-all {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.see-all:hover { color: var(--text-primary); }
.profile-badge-link { display: inline-block; }
.kv {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  row-gap: 8px;
  column-gap: 16px;
}
.kv-row { display: contents; }
.kv dt {
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.kv dd {
  margin: 0;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--text-primary);
}
.home-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.home-list .food-label { font-size: 12px; }
.home-list .food-label .fl-name { font-size: 13px; }
.empty {
  color: var(--text-dim);
  font-style: italic;
  padding: 14px 4px;
}
.empty a { color: var(--accent-mcp); text-decoration: underline; }
.action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.action {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color 0.12s ease, transform 0.12s ease;
}
.action:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.action-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.action-sub {
  font-size: 11px;
  color: var(--text-secondary);
}
`;

const HOME_JS = `
(function() {
  const HOME_URL = '/dashboard/home/data';
  const STREAM_URL = '/dashboard/stream';
  let refreshTimer = null;
  let inflight = false;

  function $(sel) { return document.querySelector(sel); }
  function setText(role, value) {
    const el = document.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = value;
  }

  function formatUptime(sec) {
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }

  async function refresh() {
    if (inflight) return;
    inflight = true;
    try {
      const r = await fetch(HOME_URL, { headers: { 'accept': 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();
      const h = data.health;
      setText('uptime', formatUptime(h.uptime_sec));
      setText('port', h.port);
      setText('version', h.version);
      setText('active-scopes', h.active_scopes);
      setText('event-count', h.event_count);
      // BOM and decision lists: full-replace via server-rendered snapshot
      // would require a second round-trip; for now we update counts only,
      // C3/C4 will install client-side renderers when they exist.
      const bomTitle = document.querySelector('.home-boms .card-title');
      if (bomTitle) bomTitle.textContent = 'Active BOMs · ' + data.boms.total;
      const decTitle = document.querySelector('.home-decisions .card-title');
      if (decTitle) decTitle.textContent = 'Recent decisions · ' + data.decisions.open + ' open';
    } catch (err) {
      // Swallow — banner UX lands in C10.
    } finally {
      inflight = false;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function() {
      refreshTimer = null;
      refresh();
    }, 200);
  }

  // Auto-refresh every 5s as a fallback if SSE drops.
  setInterval(refresh, 5000);

  // Live update channel: any event nudges a debounced refresh.
  try {
    const es = new EventSource(STREAM_URL);
    es.addEventListener('event', scheduleRefresh);
    es.addEventListener('open', function() { /* connected */ });
    es.addEventListener('error', function() { /* C10 banner */ });
  } catch (err) {
    // No SSE — the 5s poll covers it.
  }
})();
`;

export function renderHomePage(data?: HomeData): string {
  // Server-side initial paint uses the supplied snapshot. When called
  // without data (tests or pure-render contexts), emit empty placeholders.
  const snapshot: HomeData = data ?? {
    health: {
      ok: true,
      version: 'unknown',
      port: 0,
      started_at: new Date().toISOString(),
      uptime_sec: 0,
      connected_clients: 0,
      event_count: 0,
      active_scopes: 0,
      profile_mode: 'balanced',
    },
    boms: { recent: [], total: 0, open: 0 },
    decisions: { recent: [], open: 0 },
  };

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Home</h1>`,
    `<span class="page-sub">Daemon at-a-glance</span>`,
    `</div>`,
    `<div class="home-grid">`,
    renderHealthCard(snapshot.health),
    renderBomsCard(snapshot.boms),
    renderDecisionsCard(snapshot.decisions),
    renderActionsCard(),
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Home',
    activePage: 'home',
    body,
    head: `<style>${HOME_CSS}</style>`,
    script: HOME_JS,
  });
}
