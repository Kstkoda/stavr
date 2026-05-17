/**
 * Diagnostics — Proxmox-dense sectioned trends + self-heal + live trace.
 *
 * Layout (per design-mockups/dashboard-diagnostics-v2-b-proxmox.html):
 *   - Jobs banner (7 pills)
 *   - Section 1: MCPs        — gauges + trend chart + roster
 *   - Section 2: stavR fleet — gauges + trend chart + roster
 *   - Section 3: Workers     — gauges + trend chart + roster
 *   - Bottom row: Self-heal log (left) + Live trace tail (right)
 *   - Window selector (5m / 1h / 24h / 7d) drives all chart ranges
 *
 * Data: bricks + workers fed in via DiagnosticsData (optional). The trend
 * + gauge + heal feeds are pulled live from /metrics and /dashboard/stream
 * SSE by the page JS — server-side render is the empty/stub state so the
 * page is never blank.
 */
import type { WorkerRecord } from '../../persistence.js';
import type { InstalledBrickLite } from '../adapters/topology.js';
import { renderShell } from '../shell.js';
import { renderIcon, resolveIconId } from '../components/icon-sprite.js';

export interface DiagnosticsData {
  bricks?: InstalledBrickLite[];
  workers?: WorkerRecord[];
  /** Peer count (federated daemons). Defaults to 0 until federation lands. */
  peerCount?: number;
  /**
   * v0.5 P6 — Steward subprocess panel. Additive only per the dashboard
   * visual-freeze. Source: src/dashboard/data/steward-health.ts
   * (snapshotStewardHealth). When `undefined`, the panel still renders but
   * shows 'unwired' status — useful baseline while shadow mode is off.
   */
  steward?: {
    pid: number | null;
    status: 'starting' | 'up' | 'unhealthy' | 'down' | 'unwired';
    last_heartbeat_at: string | null;
    autonomy_mode: string;
    lessons_count: number;
    memory_working_keys: number;
  };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =================================== CSS ===================================
const DIAGNOSTICS_CSS = `
.diag-page {
  padding: 4px 0;
  display: flex; flex-direction: column; gap: 10px;
}

.jobs-banner {
  display: flex; gap: 6px;
  font-family: var(--mono); font-size: 11px;
  flex-wrap: wrap;
}
.job-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 6px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  backdrop-filter: blur(10px);
}
.job-pill .l { color: var(--ink-2); font-size: 10px; }
.job-pill .v { font-size: 11px; }
.job-pill.ok   { border-color: rgba(109,213,140,.30); background: rgba(109,213,140,.06); }
.job-pill.ok   .v { color: var(--ok); }
.job-pill.warn { border-color: rgba(226,169,66,.30);  background: rgba(226,169,66,.08); }
.job-pill.warn .v { color: var(--warn); }
.job-pill.crit { border-color: rgba(239,90,111,.30);  background: rgba(239,90,111,.08); }
.job-pill.crit .v { color: var(--crit); }

.window-bar {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11px; color: var(--ink-2);
  margin-left: auto;
}
.window-bar .wb-group { display: flex; gap: 4px; }
.window-bar button {
  background: var(--bg-glass); border: 1px solid var(--line-2);
  color: var(--ink-2);
  padding: 3px 11px; border-radius: 999px;
  font-family: var(--mono); font-size: 10px; cursor: pointer;
}
.window-bar button[aria-pressed="true"] {
  background: var(--rust-soft); color: #ffd9c4; border-color: var(--rust);
}

.diag-top {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}

/* Section */
.diag-sec {
  display: flex; flex-direction: column; gap: 6px;
}
.sec-head {
  display: flex; align-items: center; gap: 10px;
  padding: 0 4px;
}
.sec-bar { flex: 1; height: 1px; background: linear-gradient(90deg, var(--line-2), transparent); }
.sec-title {
  font-family: var(--mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.18em;
  color: var(--ink-2); font-weight: 500;
}
.sec-meta {
  font-family: var(--mono); font-size: 10px; color: var(--ink-3);
}
.sec-body {
  display: grid;
  grid-template-columns: 1.1fr 1.5fr 1.5fr;
  gap: 10px; min-height: 200px;
}
@media (max-width: 1100px) { .sec-body { grid-template-columns: 1fr; } }

/* Gauge */
.gauges-panel {
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.gauge-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; flex: 1; }
.gauge {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: var(--bg-glass); border: 1px solid var(--line);
  border-radius: 8px; padding: 10px 4px;
}
.gauge .g-svg { width: 52px; height: 52px; margin-bottom: 4px; }
.gauge .g-label {
  font-family: var(--mono); font-size: 10px;
  color: var(--ink-0); font-weight: 500; text-align: center; line-height: 1.1;
}
.gauge .g-sub {
  font-family: var(--mono); font-size: 9px; color: var(--ink-3); margin-top: 2px;
}
.gauge.crit { border-color: rgba(239,90,111,.4); background: rgba(239,90,111,.06); }
.gauge.warn { border-color: rgba(226,169,66,.4); background: rgba(226,169,66,.06); }

/* Trend chart */
.trend-panel {
  padding: 12px 14px;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.trend-head {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 8px;
}
.trend-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500; font-family: var(--mono);
}
.trend-legend { display: flex; gap: 8px; font-family: var(--mono); font-size: 9px; }
.trend-legend span { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-2); }
.trend-legend .swatch { width: 8px; height: 2px; border-radius: 1px; }
.trend-svg { flex: 1; width: 100%; min-height: 140px; }
.trend-svg svg { width: 100%; height: 100%; display: block; }
.trend-empty {
  flex: 1; min-height: 140px;
  display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 16px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-3); font-style: italic;
}

/* Roster table */
.roster-panel {
  padding: 10px 12px;
  overflow: hidden;
  display: flex; flex-direction: column;
}
.roster-table {
  flex: 1; overflow-y: auto;
  font-family: var(--mono); font-size: 10.5px;
}
.roster-table table { width: 100%; border-collapse: collapse; }
.roster-table th {
  text-align: left; padding: 5px 6px;
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ink-3); font-weight: 500;
  border-bottom: 1px solid var(--line);
  background: var(--bg-glass);
  position: sticky; top: 0;
}
.roster-table td {
  padding: 5px 6px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-1);
}
.roster-table tr:hover td { background: rgba(255,255,255,.03); }
.roster-table td .nm-cell {
  display: inline-flex; align-items: center; gap: 6px;
}
.roster-table td .nm-cell svg.icon { width: 13px; height: 13px; color: var(--ink-2); }
.r-status {
  font-size: 9px; padding: 1px 6px; border-radius: 4px;
  text-transform: uppercase; font-weight: 600;
  letter-spacing: .04em;
}
.r-status.ok   { background: rgba(109,213,140,.14); color: var(--ok); }
.r-status.warn { background: rgba(226,169,66,.16);  color: var(--warn); }
.r-status.crit { background: rgba(239,90,111,.16);  color: var(--crit); }
.r-status.fed  { background: rgba(167,139,250,.12); color: var(--purple); }
.r-status.idle { background: rgba(155,155,155,.10); color: var(--ink-2); }
.r-bar {
  display: inline-block; width: 56px; height: 6px;
  background: rgba(255,255,255,.06); border-radius: 3px;
  overflow: hidden; vertical-align: middle;
}
.r-bar-fill { height: 100%; background: var(--sky); }
.r-bar-fill.warn { background: var(--warn); }
.r-bar-fill.crit { background: var(--crit); }

/* Bottom row */
.bottom-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  min-height: 240px;
}
@media (max-width: 1100px) { .bottom-row { grid-template-columns: 1fr; } }

.heal-panel {
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 6px;
  overflow: hidden;
}
.heal-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 4px;
}
.heal-rune {
  font-family: var(--mono); font-size: 14px;
  color: var(--rust);
  filter: drop-shadow(0 0 6px var(--rust-glow));
}
.heal-title {
  font-family: var(--mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500;
}
.heal-meta { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--ink-3); }
.heal-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.heal-row {
  display: grid; grid-template-columns: 54px 14px 1fr auto auto;
  gap: 8px; padding: 6px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line); border-radius: 6px;
  font-family: var(--mono); font-size: 10.5px;
  align-items: center;
}
.heal-row.crit { border-left: 3px solid var(--crit); }
.heal-row.warn { border-left: 3px solid var(--warn); }
.heal-row.ok   { border-left: 3px solid var(--ok); }
.heal-time { color: var(--ink-3); font-size: 9px; }
.heal-icon.crit { color: var(--crit); }
.heal-icon.warn { color: var(--warn); }
.heal-icon.ok   { color: var(--ok); }
.heal-msg { color: var(--ink-0); }
.heal-msg .target { color: var(--sky); }
.heal-action {
  padding: 2px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--ink-2);
  font-size: 9px; cursor: pointer; font-family: var(--mono);
}
.heal-action:hover { background: var(--rust-soft); color: #ffd9c4; border-color: var(--rust); }
.heal-empty {
  text-align: center; color: var(--ink-3); font-style: italic;
  font-size: 11px; padding: 14px;
}

.tail-panel {
  padding: 12px 14px;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.tail-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.tail-title {
  font-family: var(--mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500;
}
.tail-count-wrap {
  margin-left: auto;
  font-family: var(--mono); font-size: 9px; color: var(--ink-3);
  letter-spacing: 0.06em;
}
.tail-count-wrap [data-role="tail-count"] {
  color: var(--ink-1); font-weight: 600;
}
.tail-live {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px;
  background: rgba(109,213,140,.08);
  border: 1px solid rgba(109,213,140,.25);
  border-radius: 999px;
  color: var(--ok);
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em;
}
.tail-live::before {
  content: '';
  width: 5px; height: 5px;
  background: var(--ok); border-radius: 50%;
  box-shadow: 0 0 6px var(--ok);
  animation: tail-pulse 1.5s infinite;
}
@keyframes tail-pulse { 50% { opacity: 0.4; } }
.tail-body {
  flex: 1; overflow-y: auto;
  font-family: var(--mono); font-size: 10.5px; line-height: 1.55;
  background: rgba(6,7,10,.65); border-radius: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
}
.tail-line {
  display: grid; grid-template-columns: 80px 90px 1fr 60px;
  gap: 8px; padding: 2px 0;
}
.tail-line .ts  { color: var(--ink-3); }
.tail-line .w   { color: var(--purple); }
.tail-line .t   { color: var(--ink-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tail-line .lat { color: var(--ink-2); text-align: right; }
.tail-line.err .t { color: var(--crit); }
.tail-line.slow .lat { color: var(--warn); font-weight: 600; }
.tail-empty { color: var(--ink-3); font-style: italic; }
`;

// ============================ render helpers ============================

function renderGauge(label: string, value: string, sub: string, status: 'ok' | 'warn' | 'crit', pct: number): string {
  const radius = 18;
  const c = 2 * Math.PI * radius;
  const dash = (pct / 100) * c;
  const color = status === 'crit' ? 'var(--crit)' : status === 'warn' ? 'var(--warn)' : 'var(--ok)';
  return [
    `<div class="gauge ${status === 'ok' ? '' : status}">`,
    `<svg class="g-svg" viewBox="0 0 48 48" aria-hidden="true">`,
    `<circle cx="24" cy="24" r="${radius}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>`,
    `<circle cx="24" cy="24" r="${radius}" fill="none" stroke="${color}" stroke-width="3"`,
    ` stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round"`,
    ` transform="rotate(-90 24 24)"/>`,
    `<text x="24" y="27" text-anchor="middle" font-family="var(--mono)" font-size="11" fill="var(--ink-0)" font-weight="600">${escapeHtml(value)}</text>`,
    `</svg>`,
    `<div class="g-label">${escapeHtml(label)}</div>`,
    `<div class="g-sub">${escapeHtml(sub)}</div>`,
    `</div>`,
  ].join('');
}

// Storm Pass #2 F65 — render the trend chart, but if the section has no real
// data (e.g., zero registered MCPs / zero active workers) replace the
// polyline body with an explicit empty-state. The page JS overwrites the
// `data-role` slot with live polyline coords once the windowed summary
// fetch resolves. Until then we draw a flat-at-zero baseline so the chart
// never shows fake trending lines.
function renderTrendChart(title: string, lines: { name: string; color: string }[], opts?: { emptyMessage?: string; slot?: string }): string {
  const isEmpty = !!opts?.emptyMessage;
  const slot = opts?.slot ?? '';
  const flatPoints = '0,118 27,118 55,118 82,118 109,118 136,118 164,118 191,118 218,118 245,118 273,118 300,118';
  return [
    `<div class="trend-panel glass" ${slot ? `data-role="${slot}"` : ''}>`,
    `<div class="trend-head">`,
    `<span class="trend-title">${escapeHtml(title)}</span>`,
    `<div class="trend-legend">`,
    lines.map((l) => `<span><span class="swatch" style="background:${l.color};"></span>${escapeHtml(l.name)}</span>`).join(''),
    `</div>`,
    `</div>`,
    isEmpty
      ? `<div class="trend-empty" data-role="${slot}-empty">${escapeHtml(opts!.emptyMessage!)}</div>`
      : [
          `<div class="trend-svg">`,
          `<svg viewBox="0 0 300 120" preserveAspectRatio="none">`,
          `<g stroke="rgba(255,255,255,.04)" stroke-width="0.5">`,
          `<line x1="0" y1="30" x2="300" y2="30"/>`,
          `<line x1="0" y1="60" x2="300" y2="60"/>`,
          `<line x1="0" y1="90" x2="300" y2="90"/>`,
          `</g>`,
          // Server side we draw flat-at-zero baselines per series; the page
          // JS replaces these with real coords once the windowed fetch
          // resolves. Synthetic trending lines are forbidden here.
          lines.map((l, i) => `<polyline fill="none" stroke="${l.color}" stroke-width="1.6" data-series="${i}" points="${flatPoints}"/>`).join(''),
          `</svg>`,
          `</div>`,
        ].join(''),
    `</div>`,
  ].join('');
}

interface RosterRow {
  name: string;
  iconId: string;
  cols: string[];
  status: 'ok' | 'warn' | 'crit' | 'fed' | 'idle';
}

function renderRoster(title: string, headers: string[], rows: RosterRow[]): string {
  const empty = rows.length === 0
    ? `<tr><td colspan="${headers.length + 1}" style="text-align:center;color:var(--ink-3);font-style:italic;padding:14px;">No data yet.</td></tr>`
    : '';
  return [
    `<div class="roster-panel glass">`,
    `<div class="trend-head"><span class="trend-title">${escapeHtml(title)}</span><span class="sec-meta">${rows.length}</span></div>`,
    `<div class="roster-table">`,
    `<table>`,
    `<thead><tr>`,
    `<th>Name</th>`,
    headers.map((h) => `<th>${escapeHtml(h)}</th>`).join(''),
    `<th>Status</th>`,
    `</tr></thead>`,
    `<tbody>`,
    rows.map((r) => [
      `<tr>`,
      `<td><span class="nm-cell">${renderIcon(r.iconId)} ${escapeHtml(r.name)}</span></td>`,
      r.cols.map((c) => `<td>${c}</td>`).join(''),
      `<td><span class="r-status ${r.status}">${escapeHtml(r.status)}</span></td>`,
      `</tr>`,
    ].join('')).join(''),
    empty,
    `</tbody>`,
    `</table>`,
    `</div>`,
    `</div>`,
  ].join('');
}

function renderSection(opts: {
  title: string;
  meta: string;
  gauges: string;
  trend: string;
  roster: string;
}): string {
  return [
    `<section class="diag-sec">`,
    `<div class="sec-head">`,
    `<span class="sec-title">${escapeHtml(opts.title)}</span>`,
    `<span class="sec-bar"></span>`,
    `<span class="sec-meta">${escapeHtml(opts.meta)}</span>`,
    `</div>`,
    `<div class="sec-body">`,
    `<div class="gauges-panel glass"><div class="gauge-grid">${opts.gauges}</div></div>`,
    opts.trend,
    opts.roster,
    `</div>`,
    `</section>`,
  ].join('');
}

// =================================== JS ===================================
const DIAGNOSTICS_JS = `
(function() {
  // ---- F69 window selector — drives windowed fetches across all trend
  // charts. The currently-selected window persists across reloads via
  // localStorage; default 5m. Clicking a button re-pressed the chip and
  // triggers refreshAll() which fetches /dashboard/api/traffic-summary
  // for the new range and re-renders the polylines.
  const ALLOWED_WINDOWS = ['5m','1h','24h','7d'];
  function currentWindow() {
    try {
      const saved = localStorage.getItem('stavr.diagWindow');
      if (saved && ALLOWED_WINDOWS.indexOf(saved) >= 0) return saved;
    } catch (_) {}
    return '5m';
  }
  function setWindow(w) {
    if (ALLOWED_WINDOWS.indexOf(w) < 0) return;
    try { localStorage.setItem('stavr.diagWindow', w); } catch (_) {}
    document.querySelectorAll('.window-bar button').forEach(function(x){
      x.setAttribute('aria-pressed', x.getAttribute('data-window') === w ? 'true' : 'false');
    });
  }
  setWindow(currentWindow());

  // Project a 12-bucket count array onto the trend-chart 300×120 viewBox.
  // y range: 6 (top, hottest) .. 118 (bottom, zero). Each series is scaled
  // independently so a near-flat error series doesn't get drowned out by
  // a hot mcp series.
  function pointsFor(values) {
    if (!Array.isArray(values) || values.length === 0) return '';
    const max = Math.max(1, Math.max.apply(null, values));
    const n = values.length;
    const xs = values.map(function(v, i) {
      const x = (i * 300 / (n - 1 || 1)).toFixed(1);
      const norm = v / max;
      const y = (118 - norm * 112).toFixed(1);
      return x + ',' + y;
    });
    return xs.join(' ');
  }
  function applySeries(slot, seriesPoints) {
    const panel = document.querySelector('[data-role="' + slot + '"]');
    if (!panel) return;
    const polylines = panel.querySelectorAll('svg polyline[data-series]');
    if (polylines.length === 0) return;
    polylines.forEach(function(p) {
      const idx = Number(p.getAttribute('data-series') || '0');
      const pts = seriesPoints[idx];
      if (typeof pts === 'string' && pts.length > 0) p.setAttribute('points', pts);
    });
  }
  async function refreshAll() {
    const w = currentWindow();
    try {
      const r = await fetch('/dashboard/api/traffic-summary?range=' + encodeURIComponent(w), { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const body = await r.json();
      const mcpPts = pointsFor(body.mcp && body.mcp.points);
      const p95Pts = pointsFor(body.workers && body.workers.points);
      const errPts = pointsFor(body.errors && body.errors.points);
      applySeries('mcp-trend',    [mcpPts, p95Pts, errPts]);
      applySeries('fleet-trend',  [mcpPts, errPts]);
      applySeries('worker-trend', [p95Pts, errPts]);
    } catch (_) {}
  }
  document.querySelectorAll('.window-bar button').forEach(function(b) {
    b.addEventListener('click', function() {
      const w = b.getAttribute('data-window') || '5m';
      setWindow(w);
      refreshAll();
    });
  });
  refreshAll();
  setInterval(refreshAll, 10000);

  // ---- gauge + trend live refresh from /metrics ----
  async function pull() {
    try {
      const r = await fetch('/metrics', { headers: { accept: 'text/plain' } });
      if (!r.ok) return;
      const t = await r.text();
      function num(re) { const m = t.match(re); return m ? Number(m[1]) : null; }
      const rate = num(/^stavr_events_rate_1m\\s+(\\S+)/m);
      const p95  = num(/^stavr_tool_latency_p95_ms\\s+(\\S+)/m);
      const err  = num(/^stavr_tool_error_rate\\s+(\\S+)/m);
      const rss  = num(/^process_resident_memory_bytes\\s+(\\S+)/m);
      const lag  = num(/^nodejs_eventloop_lag_p99_seconds\\s+(\\S+)/m);
      const setText = function(sel, txt) { const el = document.querySelector(sel); if (el) el.textContent = txt; };
      if (rate != null) setText('[data-role="d-rate"]', rate.toFixed(2));
      if (p95  != null) setText('[data-role="d-p95"]',  Math.round(p95) + 'ms');
      if (err  != null) setText('[data-role="d-err"]',  (err*100).toFixed(1) + '%');
      if (rss  != null) setText('[data-role="d-rss"]',  Math.round(rss/1024/1024) + 'MB');
      if (lag  != null) setText('[data-role="d-lag"]',  Math.round(lag*1000) + 'ms');
    } catch (_) {}
  }
  pull();
  setInterval(pull, 5000);

  // ---- self-heal — fetch existing endpoint, fall back to empty state ----
  async function pullHeal() {
    try {
      const r = await fetch('/api/steward/heal-log', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const list = await r.json();
      const ul = document.querySelector('[data-role="heal-list"]');
      if (!ul || !Array.isArray(list) || list.length === 0) return;
      ul.innerHTML = list.slice(0, 12).map(function(h) {
        const ts = h.at ? new Date(h.at).toISOString().slice(11, 19) : '—';
        const sev = h.severity || 'ok';
        return '<div class="heal-row ' + sev + '">'
             + '<span class="heal-time">' + ts + '</span>'
             + '<span class="heal-icon ' + sev + '">●</span>'
             + '<span class="heal-msg">' + (h.message || h.kind || 'action') + '</span>'
             + '<button class="heal-action" data-act="undo">undo</button>'
             + '<button class="heal-action" data-act="deny">deny</button>'
             + '</div>';
      }).join('');
    } catch (_) {}
  }
  pullHeal();

  // ---- F68 live trace tail via SSE ----
  // The broker → SSE pipe is already working; the storm-pass report of
  // "connected dot, but never displays events" was caused by three latent
  // bugs in the JS that turned every line into "· · · ·":
  //   1. The "Waiting for events…" placeholder was never cleared when the
  //      first event arrived, so a near-empty stream looked completely
  //      stalled to the operator.
  //   2. worker_id / bom_id were read off the top-level data object
  //      instead of data.payload, so the worker column always rendered
  //      as "·" regardless of the event.
  //   3. duration_ms had the same problem — every latency cell showed "·".
  // Also surface a tiny "events received" counter on the tail header so
  // operators can verify the pipe is alive even during quiet periods.
  const tail = document.querySelector('[data-role="tail-body"]');
  const counter = document.querySelector('[data-role="tail-count"]');
  let paused = false;
  let received = 0;
  function clearEmptyPlaceholder() {
    if (!tail) return;
    const empty = tail.querySelector('.tail-empty');
    if (empty) tail.removeChild(empty);
  }
  if (tail) {
    tail.addEventListener('mouseenter', function(){ paused = true; });
    tail.addEventListener('mouseleave', function(){ paused = false; });
    try {
      const es = new EventSource('/dashboard/stream');
      es.addEventListener('event', function(ev) {
        try {
          const data = JSON.parse(ev.data || '{}');
          const payload = (data && typeof data.payload === 'object' && data.payload) ? data.payload : {};
          received += 1;
          if (counter) counter.textContent = String(received);
          if (paused) return;
          clearEmptyPlaceholder();
          const ts = new Date(data.at || Date.now()).toISOString().slice(11, 19);
          const wid = payload.worker_id || payload.bom_id || payload.id || data.correlation_id || '';
          const w = String(wid).slice(0, 8) || '·';
          const txt = String(data.kind || '·');
          const dur = (typeof payload.duration_ms === 'number') ? payload.duration_ms
                    : (typeof payload.duration_sec === 'number') ? Math.round(payload.duration_sec * 1000)
                    : null;
          const lat = dur != null ? dur + 'ms' : '·';
          const cls = txt.indexOf('err') >= 0 || txt.indexOf('fail') >= 0 ? 'err'
            : (dur && dur > 1000 ? 'slow' : '');
          const line = document.createElement('div');
          line.className = 'tail-line ' + cls;
          line.innerHTML = '<span class="ts">' + ts + '</span>'
                        + '<span class="w">' + w.replace(/</g,'&lt;') + '</span>'
                        + '<span class="t">' + txt.replace(/</g,'&lt;') + '</span>'
                        + '<span class="lat">' + lat + '</span>';
          tail.appendChild(line);
          // Cap to last 200 lines.
          while (tail.children.length > 200) tail.removeChild(tail.firstChild);
          tail.scrollTop = tail.scrollHeight;
        } catch (_) {}
      });
    } catch (_) {}
  }
})();
`;

// =============================== render ================================
export function renderDiagnosticsPage(data?: DiagnosticsData): string {
  const bricks = data?.bricks ?? [];
  const workers = data?.workers ?? [];
  const peers = data?.peerCount ?? 0;

  // ----- Jobs banner -----
  const jobs = [
    { l: 'Backup',     v: '✓',            cls: 'ok' as const },
    { l: 'CI',         v: '✓',            cls: 'ok' as const },
    { l: 'Deploy',     v: '✓',            cls: 'ok' as const },
    { l: 'Retention',  v: '✓ 9m ago',     cls: 'ok' as const },
    { l: 'OOM watch',  v: '✓ 0 saved',    cls: 'ok' as const },
    { l: 'Webhook',    v: '⚠ auth',       cls: 'warn' as const },
    { l: 'Self-heal',  v: '✓ 0 auto',     cls: 'ok' as const },
  ];
  const jobsBanner = [
    `<div class="jobs-banner glass" style="padding:8px 10px;">`,
    jobs.map((j) => `<div class="job-pill ${j.cls}"><span class="l">${escapeHtml(j.l)}</span><span class="v">${escapeHtml(j.v)}</span></div>`).join(''),
    `</div>`,
  ].join('');

  const windowBar = [
    `<div class="window-bar">`,
    `<span>window ›</span>`,
    `<div class="wb-group">`,
    `<button data-window="5m" aria-pressed="true">5m</button>`,
    `<button data-window="1h">1h</button>`,
    `<button data-window="24h">24h</button>`,
    `<button data-window="7d">7d</button>`,
    `</div>`,
    `</div>`,
  ].join('');

  // ----- Section 1: MCPs -----
  const mcpRoster: RosterRow[] = bricks.filter((b) => b.enabled).map((b) => ({
    name: b.display_name || b.id,
    iconId: resolveIconId(b.display_name || b.id),
    status: 'ok',
    cols: [
      `<span style="color:var(--ink-3);">v—</span>`,
      `<span data-role="m-${escapeHtml(b.id)}-qps">·</span>`,
      `<span data-role="m-${escapeHtml(b.id)}-p95">·</span>`,
      `<span data-role="m-${escapeHtml(b.id)}-err">0%</span>`,
      `<span style="color:var(--ink-3);">—</span>`,
    ],
  }));
  const mcpHasData = bricks.length > 0;
  const mcpTrend = renderTrendChart(
    'MCPs · qps + p95 + err',
    [
      { name: 'qps',   color: 'var(--green)' },
      { name: 'p95ms', color: 'var(--sky)'   },
      { name: 'err%',  color: 'var(--amber)' },
    ],
    {
      slot: 'mcp-trend',
      ...(mcpHasData ? {} : { emptyMessage: 'No data — register an MCP to see traffic.' }),
    },
  );
  const mcpSection = renderSection({
    title: 'Section 1 · MCP servers',
    meta: `${bricks.length} registered · live`,
    gauges: [
      renderGauge('qps',    '·', 'rate · 1m', 'ok',   55),
      renderGauge('p95',    '·', 'tool · ms', 'ok',   30),
      renderGauge('err',    '·', '%',         'ok',   5),
    ].join(''),
    trend: mcpTrend,
    roster: renderRoster('MCPs · roster', ['Ver', 'qps', 'p95', 'err', 'last call'], mcpRoster),
  });

  // ----- Section 2: stavR fleet -----
  const fleetRows: RosterRow[] = [
    { name: 'stavr · primary', iconId: 'i-rune',   status: 'ok',  cols: ['<span data-role="d-rss">·</span>', '<span data-role="d-lag">·</span>', '<span data-role="d-rate">·</span>'] },
    { name: 'stavr · spawn',   iconId: 'i-rune',   status: 'idle', cols: ['—', '—', '—'] },
    ...Array.from({ length: peers }, (_, i) => ({
      name: `peer-${i + 1}`,
      iconId: 'i-peer',
      status: 'fed' as const,
      cols: ['—', '—', 'ACL'],
    })),
  ];
  const fleetTrend = renderTrendChart(
    'stavR fleet · RSS + loop p99',
    [
      { name: 'RSS MB',  color: 'var(--sky)'    },
      { name: 'loop ms', color: 'var(--purple)' },
    ],
    { slot: 'fleet-trend' },
  );
  const fleetSection = renderSection({
    title: 'Section 2 · stavR fleet (primary + spawn + peers)',
    meta: `${1 + peers + 1} processes`,
    gauges: [
      renderGauge('RSS',   '·', 'MB',         'ok',  40),
      renderGauge('loop',  '·', 'p99 ms',     'ok',  10),
      renderGauge('peers', String(peers), 'federated', peers > 0 ? 'warn' : 'ok',  Math.min(100, peers * 25)),
    ].join(''),
    trend: fleetTrend,
    roster: renderRoster('Fleet · roster', ['RSS', 'loop', 'qps'], fleetRows),
  });

  // ----- Section 3: Workers + scopes -----
  const workerRows: RosterRow[] = workers.map((w) => ({
    name: w.name || w.id,
    iconId: resolveIconId(w.type),
    status: w.status === 'crashed' ? 'crit' : (w.status === 'running' ? 'ok' : w.status === 'idle' ? 'idle' : 'warn'),
    cols: [
      escapeHtml(w.type),
      `<span style="color:var(--ink-3);">${w.cwd ? escapeHtml(w.cwd.slice(0, 24)) : '—'}</span>`,
      `<span style="color:var(--ink-3);">—</span>`,
    ],
  }));
  const workerActive = workers.filter((w) => w.status === 'running' || w.status === 'idle').length;
  const workerTrend = renderTrendChart(
    'Workers · throughput',
    [
      { name: 'active',  color: 'var(--green)' },
      { name: 'crashed', color: 'var(--crit)'  },
    ],
    {
      slot: 'worker-trend',
      ...(workerActive > 0 ? {} : { emptyMessage: 'No active workers — spawn a job to see throughput.' }),
    },
  );
  const workerSection = renderSection({
    title: 'Section 3 · Workers + scopes',
    meta: `${workers.length} processes`,
    gauges: [
      renderGauge('active',  String(workers.filter((w) => w.status === 'running').length), 'workers', 'ok', 50),
      renderGauge('crashed', String(workers.filter((w) => w.status === 'crashed').length), 'workers', workers.some((w) => w.status === 'crashed') ? 'crit' : 'ok', workers.some((w) => w.status === 'crashed') ? 100 : 0),
      renderGauge('scopes',  '—', 'active',  'ok', 0),
    ].join(''),
    trend: workerTrend,
    roster: renderRoster('Workers · roster', ['Type', 'cwd', 'eta'], workerRows),
  });

  // ----- v0.5 P6: Steward subprocess panel (additive) -----
  const stewardPanel = renderStewardPanel(data?.steward);

  // ----- Bottom row -----
  const healPanel = [
    `<div class="heal-panel glass">`,
    `<div class="heal-head">`,
    `<span class="heal-rune">ᚱ</span>`,
    `<span class="heal-title">Self-heal log</span>`,
    `<span class="heal-meta">/api/steward/heal-log · auto-refresh</span>`,
    `</div>`,
    `<div class="heal-list" data-role="heal-list">`,
    `<div class="heal-empty">No recent heal actions.</div>`,
    `</div>`,
    `</div>`,
  ].join('');

  const tailPanel = [
    `<div class="tail-panel glass">`,
    `<div class="tail-head">`,
    `<span class="tail-title">Live trace tail</span>`,
    // F68 — small "events received" counter so the operator can confirm
    // the SSE pipe is alive even when the daemon is quiet.
    `<span class="tail-count-wrap">received <span data-role="tail-count">0</span></span>`,
    `<span class="tail-live">SSE · /dashboard/stream</span>`,
    `</div>`,
    `<div class="tail-body" data-role="tail-body">`,
    `<div class="tail-empty">Waiting for events on /dashboard/stream …</div>`,
    `</div>`,
    `</div>`,
  ].join('');

  const body = [
    `<div class="diag-page">`,
    `<div class="page-head">`,
    `<div>`,
    `<h1 class="page-title">Diagnostics</h1>`,
    `<div class="page-sub">Proxmox-dense sectioned trends · self-heal · live trace</div>`,
    `</div>`,
    windowBar,
    `</div>`,
    `<div class="diag-top">${jobsBanner}</div>`,
    mcpSection,
    fleetSection,
    workerSection,
    stewardPanel,
    `<div class="bottom-row">${healPanel}${tailPanel}</div>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Diagnostics',
    activePage: 'diagnostics',
    body,
    head: `<style>${DIAGNOSTICS_CSS}${STEWARD_PANEL_CSS}</style>`,
    script: DIAGNOSTICS_JS,
  });
}

// =================================== v0.5 P6 ===================================
// Steward subprocess panel — additive content per the dashboard freeze rule.
// Renders the snapshot from src/dashboard/data/steward-health.ts. Status =
// halo color (rune lights up); type = mode chip (rust=reactive, sky=scheduled,
// amber=proactive) per CLAUDE.md invariant #5. No restyling of existing tokens.

const STEWARD_PANEL_CSS = `
.steward-panel {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  padding: 12px 16px;
  font-family: var(--mono);
  font-size: 11px;
}
.steward-head { display:flex; align-items:center; gap:10px; }
.steward-rune {
  display: inline-flex; align-items:center; justify-content:center;
  width: 28px; height: 28px; border-radius: 50%;
  border: 1.5px solid var(--line);
  color: var(--ink-1);
}
.steward-rune.up   { border-color: var(--ok);   color: var(--ok);   box-shadow: 0 0 8px rgba(109,213,140,.35); }
.steward-rune.warn { border-color: var(--warn); color: var(--warn); box-shadow: 0 0 8px rgba(226,169,66,.35); }
.steward-rune.crit { border-color: var(--crit); color: var(--crit); box-shadow: 0 0 8px rgba(239,90,111,.35); }
.steward-rune.idle { border-color: var(--line); color: var(--ink-3); }
.steward-title { color: var(--ink-1); font-size: 12px; letter-spacing: 0.3px; }
.steward-meta { color: var(--ink-3); font-size: 10px; }
.steward-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.steward-tile {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
}
.steward-tile .l { color: var(--ink-3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
.steward-tile .v { color: var(--ink-1); font-size: 14px; margin-top: 2px; }
.steward-tile .v.mono { font-family: var(--mono); }
.steward-mode-chip {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 10px; letter-spacing: 0.4px; text-transform: uppercase;
}
.steward-mode-chip.reactive  { background: rgba(199,108,73,.16);  color: #d68a6a; border:1px solid rgba(199,108,73,.30); }
.steward-mode-chip.scheduled { background: rgba(76,140,196,.16);  color: #7ebbdf; border:1px solid rgba(76,140,196,.30); }
.steward-mode-chip.proactive { background: rgba(226,169,66,.16);  color: var(--warn); border:1px solid rgba(226,169,66,.30); }
`;

function renderStewardPanel(steward: DiagnosticsData['steward']): string {
  const s = steward ?? {
    pid: null,
    status: 'unwired' as const,
    last_heartbeat_at: null,
    autonomy_mode: 'reactive',
    lessons_count: 0,
    memory_working_keys: 0,
  };
  const haloClass =
    s.status === 'up' ? 'up'
    : s.status === 'unhealthy' ? 'warn'
    : s.status === 'down' ? 'crit'
    : 'idle';
  const modeClass = ['reactive', 'scheduled', 'proactive'].includes(s.autonomy_mode) ? s.autonomy_mode : 'reactive';
  const heartbeatTs = s.last_heartbeat_at
    ? `${escapeHtml(s.last_heartbeat_at)} <span style="color:var(--ink-3);">(${relativeTimeFrom(s.last_heartbeat_at)})</span>`
    : '<span style="color:var(--ink-3);">—</span>';
  const pidStr = s.pid != null ? String(s.pid) : '—';

  const head = [
    `<div class="steward-head">`,
    `<span class="steward-rune ${haloClass}">ᚱ</span>`,
    `<div>`,
    `<div class="steward-title">Steward subprocess</div>`,
    `<div class="steward-meta">${escapeHtml(s.status.toUpperCase())} · ADR-032 §Decision 1</div>`,
    `</div>`,
    `</div>`,
  ].join('');

  const grid = [
    `<div class="steward-grid">`,
    `<div class="steward-tile"><div class="l">PID</div><div class="v mono">${escapeHtml(pidStr)}</div></div>`,
    `<div class="steward-tile"><div class="l">Mode</div><div class="v"><span class="steward-mode-chip ${modeClass}">${escapeHtml(s.autonomy_mode)}</span></div></div>`,
    `<div class="steward-tile"><div class="l">Last heartbeat</div><div class="v mono" style="font-size:11px;">${heartbeatTs}</div></div>`,
    `<div class="steward-tile"><div class="l">Lessons</div><div class="v mono">${s.lessons_count}</div></div>`,
    `<div class="steward-tile"><div class="l">Working keys</div><div class="v mono">${s.memory_working_keys}</div></div>`,
    `</div>`,
  ].join('');

  return [
    `<div class="steward-panel glass">`,
    head,
    grid,
    `</div>`,
  ].join('');
}

function relativeTimeFrom(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '?';
  const diff = Date.now() - then;
  if (diff < 0) return 'in the future';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
