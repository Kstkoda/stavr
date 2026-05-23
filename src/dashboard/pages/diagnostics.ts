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
import { deriveLifecycleState } from '../../workers/lifecycle.js';
import { fetchWorkerCounters } from '../data/worker-counters.js';
import {
  snapshotBuildVersions,
  formatUptime,
  type BuildVersions,
} from '../data/build-versions.js';
import { metricTooltip } from '../components/tooltips.js';
import {
  formatHostCeilingHeadline,
  hostCeilingStatusClass,
  type HostCeilingDashboardData,
} from '../data/host-ceiling.js';

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
  /**
   * v0.6.8 Section 0 — Build & Versions snapshot for the engine-room
   * top-of-page widget. When omitted the renderer calls
   * snapshotBuildVersions() with no arguments and reads the live process
   * state. Test callers inject a static snapshot to make assertions
   * deterministic.
   */
  versions?: BuildVersions;
  /**
   * Host-resource ceiling snapshot — populated by fetchHostCeilingData
   * (Phase 6 of host-resource-ceiling BOM). When omitted, the panel
   * renders an "unwired" placeholder.
   */
  hostCeiling?: HostCeilingDashboardData;
  /**
   * MCP session durability snapshot — populated by
   * `getDurabilitySnapshot()` from observability/mcp-metrics. Surfaces
   * Phase 3 of proposed/mcp-session-stability-bom.md: the
   * delivery-failed counter (split by reason) and the p99 of the
   * bounded handler-at-close histogram mirror. When omitted, the tile
   * renders an "unwired" placeholder.
   */
  durability?: {
    send_error_total: number;
    abandoned_by_close_total: number;
    handler_at_close_count: number;
    handler_at_close_p99_seconds: number | null;
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
/* v0.6.12 Phase 3 — Engine detail navigation primitives */
.diag-bread {
  font-family: var(--mono); font-size: 11px; color: var(--ink-2);
  display: flex; align-items: center; gap: 8px;
  padding: 2px 0;
}
.diag-bread a { color: var(--rust); }
.diag-bread .sep { color: var(--ink-3); }
.diag-jump {
  display: flex; gap: 6px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono); font-size: 11px;
}
.diag-jump a {
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--ink-1);
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--line-2);
}
.diag-jump a:hover { background: rgba(255,255,255,0.06); color: var(--ink-0); }
.diag-anchor {
  scroll-margin-top: 60px;
  display: flex; flex-direction: column; gap: 10px;
  padding-top: 8px;
}
.diag-anchor-title {
  margin: 8px 0 4px;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2);
  font-family: var(--mono);
}
/* Storage panel — runestone.db size + retention sweep history */
.diag-storage {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
  padding: 12px 14px;
}
@media (max-width: 900px) { .diag-storage { grid-template-columns: 1fr; } }
.diag-storage .stor-card {
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.diag-storage .stor-title {
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2);
}
.diag-storage .stor-big {
  font-family: var(--mono); font-size: 18px;
  color: var(--ink-0);
}
.diag-storage .stor-sub {
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-2);
}
.diag-storage .stor-list {
  font-family: var(--mono); font-size: 11px;
  display: flex; flex-direction: column; gap: 2px;
  color: var(--ink-1);
  max-height: 160px; overflow-y: auto;
}
.diag-storage .stor-empty {
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-3); font-style: italic;
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
.job-pill .l { color: var(--ink-2); font-size: 11px; }
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
  font-family: var(--mono); font-size: 11px; cursor: pointer;
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
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.18em;
  color: var(--ink-2); font-weight: 500;
}
.sec-meta {
  font-family: var(--mono); font-size: 11px; color: var(--ink-3);
}
.sec-body {
  display: grid;
  grid-template-columns: 1.1fr 1.5fr 1.5fr;
  gap: 10px; min-height: 200px;
}
@media (max-width: 1100px) { .sec-body { grid-template-columns: 1fr; } }

/* v0.6.11 Phase 4 — Memory + Perf section */
.sec-body.perf-body {
  grid-template-columns: 1.4fr 1.6fr 1fr 0.8fr;
}
@media (max-width: 1280px) { .sec-body.perf-body { grid-template-columns: 1fr 1fr; } }
@media (max-width: 720px)  { .sec-body.perf-body { grid-template-columns: 1fr; } }
.perf-card {
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
  min-height: 180px;
}
.perf-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.perf-card-title { font-family: var(--mono); font-size: 11px; color: var(--ink-1); letter-spacing: 0.04em; }
.perf-card-meta  { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.perf-chart { width: 100%; height: 110px; display: block; }
.perf-chart .grid line { stroke: var(--line-2); stroke-width: 0.6; stroke-dasharray: 2 4; }
.perf-chart .series { fill: none; stroke-width: 1.6; }
.perf-chart .series-heap { stroke: var(--info, #6ea8fe); }
.perf-chart .series-rss  { stroke: var(--warn, #e2a942); }
.perf-legend { display: flex; gap: 14px; font-family: var(--mono); font-size: 11px; color: var(--ink-2); }
.perf-legend .lg { display: inline-flex; align-items: center; gap: 5px; }
.perf-legend .lg::before { content: ""; display: inline-block; width: 10px; height: 2px; }
.perf-legend .lg-heap::before { background: var(--info, #6ea8fe); }
.perf-legend .lg-rss::before  { background: var(--warn, #e2a942); }
.perf-legend .lg-meta { margin-left: auto; color: var(--ink-3); }
.perf-table { display: flex; flex-direction: column; gap: 0; font-family: var(--mono); font-size: 11px; max-height: 200px; overflow-y: auto; }
.perf-row {
  display: grid;
  grid-template-columns: 1fr 36px 44px 44px 44px 38px;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  align-items: center;
}
.perf-row.perf-head { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom-color: var(--line-2); }
.perf-row span:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
.perf-row .label { color: var(--ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.perf-row .p95-slow { color: var(--warn); }
.perf-row .p95-crit { color: var(--crit); }
.perf-empty { color: var(--ink-3); font-style: italic; font-size: 11px; padding: 16px 4px; }
.evt-bars { display: flex; flex-direction: column; gap: 4px; font-family: var(--mono); font-size: 11px; max-height: 200px; overflow-y: auto; }
.evt-bar-row { display: grid; grid-template-columns: 1fr 40px; align-items: center; gap: 6px; }
.evt-bar-row .evt-bar-track { position: relative; height: 14px; background: rgba(255,255,255,0.04); border-radius: 6px; overflow: hidden; }
.evt-bar-row .evt-bar-fill  { position: absolute; left: 0; top: 0; bottom: 0; background: var(--info, #6ea8fe); opacity: 0.6; }
.evt-bar-row .evt-bar-label { font-size: 11px; color: var(--ink-1); position: absolute; left: 6px; top: 50%; transform: translateY(-50%); }
.evt-bar-row .evt-bar-count { text-align: right; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.evt-empty { color: var(--ink-3); font-style: italic; font-size: 11px; padding: 12px 4px; }
.perf-card-action .perf-action-desc { font-size: 11px; color: var(--ink-2); margin: 0; line-height: 1.4; }
.perf-action-row { display: flex; align-items: center; gap: 8px; margin-top: auto; }
.perf-action-btn {
  background: var(--bg-glass-2, rgba(255,255,255,0.04));
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 12px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-1); cursor: pointer;
}
.perf-action-btn:hover { background: rgba(255,255,255,0.06); border-color: var(--line-2); }
.perf-action-status { font-family: var(--mono); font-size: 11px; color: var(--ok); }

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
  border-radius: 10px; padding: 10px 4px;
}
.gauge .g-svg { width: 52px; height: 52px; margin-bottom: 4px; }
.gauge .g-label {
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-0); font-weight: 500; text-align: center; line-height: 1.1;
}
.gauge .g-sub {
  font-family: var(--mono); font-size: 11px; color: var(--ink-3); margin-top: 2px;
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
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500; font-family: var(--mono);
}
.trend-legend { display: flex; gap: 8px; font-family: var(--mono); font-size: 11px; }
.trend-legend span { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-2); }
.trend-legend .swatch { width: 8px; height: 2px; border-radius: 6px; }
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
  font-family: var(--mono); font-size: 11px;
}
.roster-table table { width: 100%; border-collapse: collapse; }
.roster-table th {
  text-align: left; padding: 5px 6px;
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
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
  font-size: 11px; padding: 1px 6px; border-radius: 6px;
  text-transform: uppercase; font-weight: 500;
  letter-spacing: .04em;
}
.r-status.ok   { background: rgba(109,213,140,.14); color: var(--ok); }
.r-status.warn { background: rgba(226,169,66,.16);  color: var(--warn); }
.r-status.crit { background: rgba(239,90,111,.16);  color: var(--crit); }
.r-status.fed  { background: rgba(167,139,250,.12); color: var(--purple); }
.r-status.idle { background: rgba(155,155,155,.10); color: var(--ink-2); }
.r-bar {
  display: inline-block; width: 56px; height: 6px;
  background: rgba(255,255,255,.06); border-radius: 6px;
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
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500;
}
.heal-meta { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.heal-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.heal-row {
  display: grid; grid-template-columns: 54px 14px 1fr auto auto;
  gap: 8px; padding: 6px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line); border-radius: 6px;
  font-family: var(--mono); font-size: 11px;
  align-items: center;
}
.heal-row.crit { border-left: 3px solid var(--crit); }
.heal-row.warn { border-left: 3px solid var(--warn); }
.heal-row.ok   { border-left: 3px solid var(--ok); }
.heal-time { color: var(--ink-3); font-size: 11px; }
.heal-icon.crit { color: var(--crit); }
.heal-icon.warn { color: var(--warn); }
.heal-icon.ok   { color: var(--ok); }
.heal-msg { color: var(--ink-0); }
.heal-msg .target { color: var(--sky); }
.heal-action {
  padding: 2px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--ink-2);
  font-size: 11px; cursor: pointer; font-family: var(--mono);
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
  font-family: var(--mono); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--ink-2); font-weight: 500;
}
.tail-count-wrap {
  margin-left: auto;
  font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  letter-spacing: 0.06em;
}
.tail-count-wrap [data-role="tail-count"] {
  color: var(--ink-1); font-weight: 500;
}
.tail-live {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px;
  background: rgba(109,213,140,.08);
  border: 1px solid rgba(109,213,140,.25);
  border-radius: 999px;
  color: var(--ok);
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
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
  font-family: var(--mono); font-size: 11px; line-height: 1.55;
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
.tail-line.slow .lat { color: var(--warn); font-weight: 500; }
.tail-empty { color: var(--ink-3); font-style: italic; }
`;

// ============================ render helpers ============================

function renderGauge(label: string, value: string, sub: string, status: 'ok' | 'warn' | 'crit', pct: number): string {
  const radius = 18;
  const c = 2 * Math.PI * radius;
  const dash = (pct / 100) * c;
  const color = status === 'crit' ? 'var(--crit)' : status === 'warn' ? 'var(--warn)' : 'var(--ok)';
  // v0.6.12 Phase 6 — tooltip per gauge label.
  const tip = metricTooltip(label) ?? '';
  const tipAttr = tip ? ` title="${tip.replace(/"/g, '&quot;')}"` : '';
  return [
    `<div class="gauge ${status === 'ok' ? '' : status}"${tipAttr}>`,
    `<svg class="g-svg" viewBox="0 0 48 48" aria-hidden="true">`,
    `<circle cx="24" cy="24" r="${radius}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3"/>`,
    `<circle cx="24" cy="24" r="${radius}" fill="none" stroke="${color}" stroke-width="3"`,
    ` stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" stroke-linecap="round"`,
    ` transform="rotate(-90 24 24)"/>`,
    `<text x="24" y="27" text-anchor="middle" font-family="var(--mono)" font-size="11" fill="var(--ink-0)" font-weight="500">${escapeHtml(value)}</text>`,
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

/**
 * v0.6.11 Phase 4 — Memory + perf panel for the diagnostics page.
 * Server-rendered shell; JS in PERF_PANEL_JS polls
 * /dashboard/api/diagnostics/memory + /dashboard/api/perf and tails the
 * SSE stream to update the inline SVG charts.
 *
 * Anchored as #perf so /dashboard/diagnostics#perf deep-links here.
 */
function renderPerfSection(): string {
  return [
    `<section class="diag-sec" id="perf">`,
    `<div class="sec-head">`,
    `<span class="sec-title">Section · Memory + Perf</span>`,
    `<span class="sec-bar"></span>`,
    `<span class="sec-meta" data-role="perf-meta">live · sample every 10s</span>`,
    `</div>`,
    `<div class="sec-body perf-body">`,
    // Memory card (heap_used + RSS line chart, last ~10 min)
    `<div class="perf-card glass">`,
    `<div class="perf-card-head">`,
    `<span class="perf-card-title">Memory · heap_used / RSS</span>`,
    `<span class="perf-card-meta" data-role="mem-now">·</span>`,
    `</div>`,
    `<svg class="perf-chart" data-role="mem-chart" viewBox="0 0 600 140" preserveAspectRatio="none" aria-label="Memory chart">`,
    `<g class="grid">`,
    `<line x1="0" y1="35" x2="600" y2="35" />`,
    `<line x1="0" y1="70" x2="600" y2="70" />`,
    `<line x1="0" y1="105" x2="600" y2="105" />`,
    `</g>`,
    `<polyline class="series series-heap" data-role="mem-heap" points="" />`,
    `<polyline class="series series-rss" data-role="mem-rss" points="" />`,
    `</svg>`,
    `<div class="perf-legend">`,
    `<span class="lg lg-heap">heap_used</span>`,
    `<span class="lg lg-rss">rss</span>`,
    `<span class="lg lg-meta" data-role="mem-meta">no samples yet</span>`,
    `</div>`,
    `</div>`,
    // Endpoint latency table (top-K from /dashboard/api/perf)
    `<div class="perf-card glass">`,
    `<div class="perf-card-head">`,
    `<span class="perf-card-title">Endpoint latency · p50 / p95 / p99</span>`,
    `<span class="perf-card-meta" data-role="perf-meta-count">·</span>`,
    `</div>`,
    `<div class="perf-table" data-role="perf-table">`,
    `<div class="perf-row perf-head">`,
    `<span>endpoint</span><span>n</span><span>p50</span><span>p95</span><span>p99</span><span>err%</span>`,
    `</div>`,
    `<div class="perf-empty" data-role="perf-empty">No traffic yet — exercise the daemon to populate.</div>`,
    `</div>`,
    `</div>`,
    // Event throughput per kind (counts last 60s from SSE tail)
    `<div class="perf-card glass">`,
    `<div class="perf-card-head">`,
    `<span class="perf-card-title">Event throughput · last 60s</span>`,
    `<span class="perf-card-meta" data-role="evt-total">0 events</span>`,
    `</div>`,
    `<div class="evt-bars" data-role="evt-bars">`,
    `<div class="evt-empty">No events received yet.</div>`,
    `</div>`,
    `</div>`,
    // Operator-only "Run synthetic load" — EXPLICIT-tier handoff. Copies the
    // exact load-runner.mjs command to clipboard for the operator to run.
    `<div class="perf-card perf-card-action glass">`,
    `<div class="perf-card-head">`,
    `<span class="perf-card-title">Run synthetic load</span>`,
    `<span class="perf-card-meta">EXPLICIT · operator-only</span>`,
    `</div>`,
    `<p class="perf-action-desc">Phase 2 harness — hammers MCP + SSE + page nav for verification. Copies the command to clipboard; you run it locally.</p>`,
    `<div class="perf-action-row">`,
    `<button type="button" class="perf-action-btn" data-role="perf-copy-load">Copy load-runner command</button>`,
    `<span class="perf-action-status" data-role="perf-copy-status"></span>`,
    `</div>`,
    `</div>`,
    `</div>`,
    `</section>`,
  ].join('');
}

/**
 * MCP session durability tile — Phase 3 of
 * proposed/mcp-session-stability-bom.md. Shows the two failure-mode
 * metrics in a compact glass card on the engine page's Traffic section.
 * When `data` is undefined, renders an "unwired" placeholder so the
 * tile structure is always visible.
 */
function renderMcpDurabilityPanel(data?: DiagnosticsData['durability']): string {
  const fmtSec = (s: number | null): string =>
    s === null ? '—' : s < 1 ? `${(s * 1000).toFixed(0)}ms` : s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}min`;
  const tiles: Array<{ l: string; v: string; cls: 'ok' | 'warn' }> = data
    ? [
        { l: 'send_error', v: String(data.send_error_total), cls: data.send_error_total > 0 ? 'warn' : 'ok' },
        { l: 'abandoned', v: String(data.abandoned_by_close_total), cls: data.abandoned_by_close_total > 0 ? 'warn' : 'ok' },
        { l: 'handler p99', v: fmtSec(data.handler_at_close_p99_seconds), cls: 'ok' },
        { l: 'samples', v: String(data.handler_at_close_count), cls: 'ok' },
      ]
    : [
        { l: 'send_error', v: '—', cls: 'ok' },
        { l: 'abandoned', v: '—', cls: 'ok' },
        { l: 'handler p99', v: '—', cls: 'ok' },
        { l: 'samples', v: '—', cls: 'ok' },
      ];
  return [
    `<section class="diag-sec">`,
    `<div class="sec-head">`,
    `<span class="sec-title">MCP session durability</span>`,
    `<span class="sec-bar"></span>`,
    `<span class="sec-meta">${escapeHtml('eventStore + keepalive · failure-mode counters')}</span>`,
    `</div>`,
    `<div class="sec-body">`,
    `<div class="jobs-banner glass" style="padding:8px 10px;">`,
    tiles.map((t) => `<div class="job-pill ${t.cls}"><span class="l">${escapeHtml(t.l)}</span><span class="v">${escapeHtml(t.v)}</span></div>`).join(''),
    `</div>`,
    `</div>`,
    `</section>`,
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
  // ---- v0.6.8 Section 0 — Build & Versions actions ----
  // [Copy version] writes the canonical one-line bug-report string to the
  // clipboard (or falls back to a transient <textarea> + execCommand on
  // older browsers that don't grant clipboard-write permission).
  document.querySelectorAll('[data-role="bv-copy"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const txt = btn.getAttribute('data-copy') || '';
      const reset = function() { setTimeout(function() { btn.textContent = 'Copy version'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function() {
          btn.textContent = 'Copied ✓';
          reset();
        }).catch(function() {
          btn.textContent = 'Copy failed';
          reset();
        });
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          btn.textContent = 'Copied ✓';
          reset();
        } catch (_) {
          btn.textContent = 'Copy failed';
          reset();
        }
      }
    });
  });
  // [Check for updates] hits the public GitHub releases endpoint and
  // compares versus the currently-displayed daemon version. No-op when
  // the operator has set STAVR_DISABLE_UPDATE_CHECK=1 (the button isn't
  // rendered in that case so this handler simply never fires).
  document.querySelectorAll('[data-role="bv-update-check"]').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      const original = btn.textContent;
      btn.textContent = 'Checking…';
      btn.disabled = true;
      try {
        const r = await fetch('https://api.github.com/repos/Kstkoda/stavr/releases/latest', {
          headers: { accept: 'application/vnd.github+json' },
        });
        if (!r.ok) throw new Error('http ' + r.status);
        const body = await r.json();
        const latest = (body && body.tag_name) ? String(body.tag_name).replace(/^v/, '') : null;
        const currentEl = document.querySelector('[data-role="build-versions"] .bv-tile .v');
        const currentText = currentEl ? currentEl.textContent || '' : '';
        const currentMatch = currentText.match(/v([0-9][0-9.\\-]*)/);
        const current = currentMatch ? currentMatch[1] : '';
        if (!latest) {
          btn.textContent = 'No release info';
        } else if (current && latest === current) {
          btn.textContent = 'Up to date ✓';
        } else if (latest) {
          btn.textContent = 'v' + latest + ' available ↗';
        } else {
          btn.textContent = original;
        }
      } catch (_) {
        btn.textContent = 'Check failed';
      }
      setTimeout(function() { btn.textContent = original; btn.disabled = false; }, 4000);
    });
  });

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
             + '<button class="heal-action" data-act="undo" data-parked="v0.7" disabled aria-disabled="true" title="Undo wiring lands in v0.7 — the heal-log read path is live, write-back is not">undo</button>'
             + '<button class="heal-action" data-act="deny" data-parked="v0.7" disabled aria-disabled="true" title="Deny wiring lands in v0.7 — see audit/09-ui-substrate-gap.md">deny</button>'
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
  // ---- v0.6.11 Phase 4 — Memory + Perf section drivers ----
  (function initPerfPanel() {
    const memHeap = document.querySelector('[data-role="mem-heap"]');
    const memRss  = document.querySelector('[data-role="mem-rss"]');
    if (!memHeap || !memRss) return;
    const memNow  = document.querySelector('[data-role="mem-now"]');
    const memMeta = document.querySelector('[data-role="mem-meta"]');
    const perfTable = document.querySelector('[data-role="perf-table"]');
    const perfEmpty = document.querySelector('[data-role="perf-empty"]');
    const perfMetaCount = document.querySelector('[data-role="perf-meta-count"]');
    const evtBars = document.querySelector('[data-role="evt-bars"]');
    const evtTotal = document.querySelector('[data-role="evt-total"]');
    const copyBtn = document.querySelector('[data-role="perf-copy-load"]');
    const copyStatus = document.querySelector('[data-role="perf-copy-status"]');

    const W = 600, H = 140, MAX_POINTS = 60;
    const heapPts = []; // {t, mb}
    const rssPts  = [];
    function pushPoint(arr, v) {
      arr.push(v);
      while (arr.length > MAX_POINTS) arr.shift();
    }
    function buildPoints(arr, maxVal) {
      if (arr.length === 0) return '';
      const denom = Math.max(1, maxVal);
      return arr.map(function(v, i) {
        const x = (i / Math.max(1, MAX_POINTS - 1)) * W;
        const y = H - 6 - (v / denom) * (H - 12);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }
    function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

    async function refreshMem() {
      try {
        const r = await fetch('/dashboard/api/diagnostics/memory');
        if (!r.ok) return;
        const body = await r.json();
        const heapMB = body.process.heap_used / 1024 / 1024;
        const rssMB  = body.process.rss / 1024 / 1024;
        pushPoint(heapPts, heapMB);
        pushPoint(rssPts, rssMB);
        const peak = Math.max.apply(null, rssPts.concat(heapPts).concat([1]));
        memHeap.setAttribute('points', buildPoints(heapPts, peak));
        memRss.setAttribute('points', buildPoints(rssPts, peak));
        if (memNow) memNow.textContent = 'heap ' + heapMB.toFixed(0) + ' MB · rss ' + rssMB.toFixed(0) + ' MB';
        if (memMeta) memMeta.textContent = heapPts.length + ' samples · peak ' + peak.toFixed(0) + ' MB';
      } catch (_) { /* ignore */ }
    }

    function renderPerfTable(snapshot) {
      const endpoints = snapshot && snapshot.endpoints || {};
      const labels = Object.keys(endpoints);
      if (labels.length === 0) {
        if (perfEmpty) perfEmpty.style.display = '';
        if (perfMetaCount) perfMetaCount.textContent = '0 endpoints';
        return;
      }
      if (perfEmpty) perfEmpty.style.display = 'none';
      if (perfMetaCount) perfMetaCount.textContent = labels.length + ' endpoint' + (labels.length === 1 ? '' : 's');
      // Sort by p95 desc; top 15.
      const rows = labels.map(function(l) { return Object.assign({ label: l }, endpoints[l]); })
        .sort(function(a, b) { return (b.p95_ms || 0) - (a.p95_ms || 0); })
        .slice(0, 15);
      // Drop any existing data rows; preserve head + empty.
      perfTable.querySelectorAll('.perf-row.perf-data').forEach(function(r) { r.remove(); });
      rows.forEach(function(r) {
        const div = document.createElement('div');
        div.className = 'perf-row perf-data';
        const errPct = (r.error_rate * 100).toFixed(1);
        const p95cls = r.p95_ms > 200 ? 'p95-crit' : r.p95_ms > 100 ? 'p95-slow' : '';
        div.innerHTML =
          '<span class="label" title="' + (r.label || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;') + '">' + (r.label || '').replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>'
          + '<span>' + (r.count != null ? r.count : '·') + '</span>'
          + '<span>' + (r.p50_ms != null ? r.p50_ms.toFixed(1) : '·') + '</span>'
          + '<span class="' + p95cls + '">' + (r.p95_ms != null ? r.p95_ms.toFixed(1) : '·') + '</span>'
          + '<span>' + (r.p99_ms != null ? r.p99_ms.toFixed(1) : '·') + '</span>'
          + '<span>' + errPct + '</span>';
        perfTable.appendChild(div);
      });
    }
    async function refreshPerf() {
      try {
        const r = await fetch('/dashboard/api/perf');
        if (!r.ok) return;
        renderPerfTable(await r.json());
      } catch (_) { /* ignore */ }
    }

    // Event throughput — count events per kind over a 60s rolling window.
    const evtCounts = new Map();
    const evtBuffer = []; // [{ at, kind }]
    function recordEvent(kind) {
      const now = Date.now();
      evtBuffer.push({ at: now, kind: kind });
      evtCounts.set(kind, (evtCounts.get(kind) || 0) + 1);
      // Trim entries older than 60s.
      while (evtBuffer.length && evtBuffer[0].at < now - 60_000) {
        const old = evtBuffer.shift();
        const c = evtCounts.get(old.kind) - 1;
        if (c <= 0) evtCounts.delete(old.kind); else evtCounts.set(old.kind, c);
      }
    }
    function renderEvtBars() {
      const entries = Array.from(evtCounts.entries()).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 12);
      if (entries.length === 0) {
        evtBars.innerHTML = '<div class="evt-empty">No events received yet.</div>';
        if (evtTotal) evtTotal.textContent = '0 events';
        return;
      }
      const peak = entries[0][1];
      evtBars.innerHTML = entries.map(function(e) {
        const pct = Math.min(100, (e[1] / Math.max(1, peak)) * 100);
        const label = String(e[0]).replace(/</g,'&lt;');
        return '<div class="evt-bar-row">'
          + '<div class="evt-bar-track">'
          + '<div class="evt-bar-fill" style="width:' + pct.toFixed(1) + '%"></div>'
          + '<span class="evt-bar-label">' + label + '</span>'
          + '</div>'
          + '<span class="evt-bar-count">' + e[1] + '</span>'
          + '</div>';
      }).join('');
      const total = entries.reduce(function(a, e) { return a + e[1]; }, 0);
      if (evtTotal) evtTotal.textContent = total + ' event' + (total === 1 ? '' : 's');
    }
    if (window.__stavrStream) {
      window.__stavrStream.on('event', function(ev) {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (data && typeof data.kind === 'string') recordEvent(data.kind);
        } catch (_) {}
      });
    }
    if (window.__stavrCleanup) {
      window.__stavrCleanup.setInterval(renderEvtBars, 2000);
      window.__stavrCleanup.setInterval(refreshMem, 10_000);
      window.__stavrCleanup.setInterval(refreshPerf, 10_000);
    } else {
      setInterval(renderEvtBars, 2000);
      setInterval(refreshMem, 10_000);
      setInterval(refreshPerf, 10_000);
    }
    refreshMem();
    refreshPerf();
    renderEvtBars();

    if (copyBtn) {
      copyBtn.addEventListener('click', async function() {
        const port = (location.port || '7777');
        const cmd = 'node tmp/perf/load-runner.mjs --port ' + port + ' --minutes 90 --modes mcp_request,sse_churn,mixed_rw,page_nav --rps-mcp 5 --sse-churn-per-sec 2 --rw-rps 3 --nav-rps 1';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(cmd);
          } else {
            const ta = document.createElement('textarea');
            ta.value = cmd; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
          }
          if (copyStatus) copyStatus.textContent = 'copied ✓ run in repo root';
        } catch (_) {
          if (copyStatus) copyStatus.textContent = 'copy failed — see console';
          console.log(cmd);
        }
        setTimeout(function() { if (copyStatus) copyStatus.textContent = ''; }, 4000);
      });
    }

    // Deep-link: /dashboard/diagnostics#perf scrolls into view.
    if (location.hash === '#perf') {
      const el = document.getElementById('perf');
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  })();

  // ---- v0.6.12 Phase 3 — Storage panel poll ----
  (function initStoragePanel() {
    const sizeEl = document.querySelector('[data-role="stor-db-size"]');
    if (!sizeEl) return;
    const metaEl = document.querySelector('[data-role="stor-db-meta"]');
    const rowEl  = document.querySelector('[data-role="stor-row-counts"]');
    const sweepEl = document.querySelector('[data-role="stor-sweeps"]');
    function fmtBytes(b) {
      if (b == null) return '—';
      if (b < 1024) return b + ' B';
      if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
      if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' MB';
      return (b/1024/1024/1024).toFixed(2) + ' GB';
    }
    async function refresh() {
      try {
        const r = await fetch('/dashboard/api/diagnostics/storage', { headers: { accept: 'application/json' } });
        if (!r.ok) return;
        const body = await r.json();
        sizeEl.textContent = fmtBytes(body.db && body.db.bytes);
        if (metaEl) metaEl.textContent = (body.db.page_count || 0) + ' pages · ' + (body.db.page_size || 0) + 'B page size';
        if (rowEl) {
          const tables = body.db.tables || {};
          const parts = Object.keys(tables).map(function(k) { return k + ' ' + tables[k]; });
          rowEl.textContent = parts.length ? 'rows: ' + parts.join(' · ') : 'no table counts available';
        }
        if (sweepEl) {
          const sweeps = (body.retention && body.retention.recent_sweeps) || [];
          if (sweeps.length === 0) {
            sweepEl.innerHTML = '<div class="stor-empty">No sweep events visible yet — retention runs every 60m.</div>';
          } else {
            sweepEl.innerHTML = sweeps.map(function(s) {
              const ts = s.at ? new Date(s.at).toISOString().slice(11, 19) : '—';
              return '<div>' + ts + ' · deleted ' + (s.deleted || 0) + (s.window_days != null ? ' · window ' + s.window_days + 'd' : '') + '</div>';
            }).join('');
          }
        }
      } catch (_) {}
    }
    refresh();
    if (window.__stavrCleanup) window.__stavrCleanup.setInterval(refresh, 30_000);
    else setInterval(refresh, 30_000);
  })();

  if (tail) {
    tail.addEventListener('mouseenter', function(){ paused = true; });
    tail.addEventListener('mouseleave', function(){ paused = false; });
    if (window.__stavrStream) {
      window.__stavrStream.on('event', function(ev) {
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
    }
  }
})();
`;

// =============================== render ================================
export function renderDiagnosticsPage(data?: DiagnosticsData): string {
  const bricks = data?.bricks ?? [];
  const workers = data?.workers ?? [];
  const peers = data?.peerCount ?? 0;
  // v0.6.8 Section 0 — fall back to a live snapshot when the caller didn't
  // pre-fetch (e.g. dashboard router without explicit deps wiring). Tests
  // pass `data.versions` for determinism.
  const versions = data?.versions ?? snapshotBuildVersions();
  const buildVersionsSection = renderBuildVersionsSection(versions);
  const perfSection = renderPerfSection();

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
  // BOM v0.6.6 P3 — Workers gauges + roster read from the single-source
  // counters so this section agrees with Helm L2 + Topology header. Per
  // BOM hard rule #5 the row meta carries lifetime AND active counts;
  // the active gauge is the live one operators key off.
  const workerNow = Date.now();
  const workerCounters = fetchWorkerCounters(workers, workerNow);
  const workerRows: RosterRow[] = workers.map((w) => {
    const lifecycle = deriveLifecycleState(w, workerNow);
    const status: 'ok' | 'crit' | 'idle' | 'warn' =
      lifecycle === 'crashed' || lifecycle === 'killed-by-system' ? 'crit'
      : lifecycle === 'running' || lifecycle === 'starting' ? 'ok'
      : lifecycle === 'stale' || lifecycle === 'completed-error' || lifecycle === 'killed-by-operator' ? 'warn'
      : 'idle';
    return {
      name: w.name || w.id,
      iconId: resolveIconId(w.type),
      status,
      cols: [
        escapeHtml(w.type),
        `<span style="color:var(--ink-3);">${w.cwd ? escapeHtml(w.cwd.slice(0, 24)) : '—'}</span>`,
        `<span style="color:var(--ink-3);">${escapeHtml(lifecycle)}</span>`,
      ],
    };
  });
  const workerActive = workerCounters.active;
  const workerCrashed = workerCounters.crashed + workerCounters.killed_by_system;
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
    meta: `${workerActive} active · ${workerCounters.total} lifetime`,
    gauges: [
      renderGauge('active',  String(workerActive), 'workers', 'ok', Math.min(100, workerActive * 12)),
      renderGauge('crashed', String(workerCrashed), 'workers', workerCrashed > 0 ? 'crit' : 'ok', workerCrashed > 0 ? 100 : 0),
      renderGauge('scopes',  '—', 'active',  'ok', 0),
    ].join(''),
    trend: workerTrend,
    roster: renderRoster('Workers · roster', ['Type', 'cwd', 'eta'], workerRows),
  });

  // ----- v0.5 P6: Steward subprocess panel (additive) -----
  const stewardPanel = renderStewardPanel(data?.steward);
  const hostCeilingPanel = renderHostCeilingPanel(data?.hostCeiling);

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

  // v0.6.12 Phase 3 — breadcrumb + jump-bar so the engine detail page
  // navigates as a real drill page, not a landing. Anchors map to the
  // four Health / Storage / Steward / Traffic substrate groupings.
  const breadcrumb = [
    `<div class="diag-bread">`,
    `<a href="/dashboard/diagnostics">Diagnostics</a>`,
    `<span class="sep">/</span>`,
    `<span>engine</span>`,
    `</div>`,
  ].join('');
  const jumpBar = [
    `<nav class="diag-jump" aria-label="Engine sub-sections">`,
    `<a href="#health">Health</a>`,
    `<a href="#storage">Storage</a>`,
    `<a href="#steward">Steward</a>`,
    `<a href="#traffic">Traffic</a>`,
    `</nav>`,
  ].join('');
  const storagePanel = renderStoragePanel();

  const body = [
    `<div class="diag-page">`,
    breadcrumb,
    `<div class="page-head">`,
    `<div>`,
    `<h1 class="page-title">Engine — health · storage · steward · traffic</h1>`,
    `<div class="page-sub">Proxmox-dense sectioned trends · self-heal · live trace</div>`,
    `</div>`,
    windowBar,
    `</div>`,
    jumpBar,
    `<div class="diag-top">${jobsBanner}</div>`,
    `<section id="health" class="diag-anchor">`,
    `<h2 class="diag-anchor-title">Health</h2>`,
    buildVersionsSection,
    hostCeilingPanel,
    perfSection,
    `</section>`,
    `<section id="storage" class="diag-anchor">`,
    `<h2 class="diag-anchor-title">Storage</h2>`,
    storagePanel,
    `</section>`,
    `<section id="steward" class="diag-anchor">`,
    `<h2 class="diag-anchor-title">Steward</h2>`,
    stewardPanel,
    `</section>`,
    `<section id="traffic" class="diag-anchor">`,
    `<h2 class="diag-anchor-title">Traffic</h2>`,
    mcpSection,
    renderMcpDurabilityPanel(data?.durability),
    fleetSection,
    workerSection,
    `<div class="bottom-row">${healPanel}${tailPanel}</div>`,
    `</section>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Diagnostics',
    activePage: 'diagnostics',
    body,
    head: `<style>${DIAGNOSTICS_CSS}${STEWARD_PANEL_CSS}${BUILD_VERSIONS_CSS}${HOST_CEILING_CSS}</style>`,
    script: DIAGNOSTICS_JS,
  });
}

// ============== v0.6.12 Phase 3 — Storage panel (engine detail) ==============
/**
 * Storage panel — sqlite file size + retention sweep history.
 *
 * The size + sweep history are populated by page JS hitting
 * /dashboard/api/diagnostics/storage. Server-render is the empty/stub
 * state so the engine page is never blank.
 */
function renderStoragePanel(): string {
  return [
    `<div class="diag-storage glass">`,
    `<div class="stor-card">`,
    `<div class="stor-title">runestone.db</div>`,
    `<div class="stor-big" data-role="stor-db-size">—</div>`,
    `<div class="stor-sub" data-role="stor-db-meta">size pending — JS polls /dashboard/api/diagnostics/storage</div>`,
    `<div class="stor-sub" data-role="stor-row-counts" style="margin-top:6px;">row counts: pending</div>`,
    `</div>`,
    `<div class="stor-card">`,
    `<div class="stor-title">Retention sweeps · last 10</div>`,
    `<div class="stor-list" data-role="stor-sweeps">`,
    `<div class="stor-empty">No sweep events visible yet — retention runs every 60m.</div>`,
    `</div>`,
    `</div>`,
    `</div>`,
  ].join('');
}

// =================== v0.6.8 Section 0 — Build & Versions ===================

const BUILD_VERSIONS_CSS = `
.bv-panel {
  display: grid;
  grid-template-columns: 220px 1fr auto;
  gap: 14px;
  padding: 12px 16px;
  font-family: var(--mono);
  font-size: 11px;
}
.bv-head { display:flex; align-items:center; gap:10px; }
.bv-title { color: var(--ink-1); font-size: 12px; letter-spacing: 0.3px; }
.bv-meta { color: var(--ink-3); font-size: 11px; }
.bv-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.bv-tile {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px 10px;
}
.bv-tile .l { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
.bv-tile .v { color: var(--ink-1); font-size: 12px; margin-top: 2px; }
.bv-tile .v.muted { color: var(--ink-3); }
.bv-actions { display:flex; flex-direction:column; gap:6px; justify-content:center; }
.bv-actions button, .bv-actions a {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink-2);
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
  text-align: left;
}
.bv-actions button:hover, .bv-actions a:hover { color: var(--ink-1); border-color: var(--ink-3); }
.bv-status-pill {
  display:inline-block; padding:0 6px; border-radius: 10px;
  font-size: 11px; letter-spacing: 0.3px; text-transform: uppercase;
  border: 1px solid var(--line);
}
.bv-status-pill.ok   { color: var(--ok);   border-color: var(--ok); }
.bv-status-pill.warn { color: var(--warn); border-color: var(--warn); }
.bv-status-pill.crit { color: var(--crit); border-color: var(--crit); }
.bv-status-pill.idle { color: var(--ink-3); }
`;

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

function renderBuildVersionsSection(versions: BuildVersions): string {
  const v = versions;
  const stewardPill =
    v.stewardStatus === 'up' ? 'ok'
    : v.stewardStatus === 'unhealthy' ? 'warn'
    : v.stewardStatus === 'down' ? 'crit'
    : 'idle';
  const govPill =
    v.governorStatus === 'cosign-signed' ? 'ok'
    : v.governorStatus === 'dev-signed' || v.governorStatus === 'unsigned' ? 'warn'
    : 'idle';
  const updateCheckDisabled = process.env.STAVR_DISABLE_UPDATE_CHECK === '1';
  const gitShaUrl = v.daemonGitSha
    ? `https://github.com/Kstkoda/stavr/commit/${encodeURIComponent(v.daemonGitSha)}`
    : null;
  const tiles: string[] = [];
  tiles.push(tile('stavR daemon', `v${escapeHtml(v.daemonVersion)}${v.daemonGitSha ? ` · ${escapeHtml(v.daemonGitSha)}` : ''}`));
  tiles.push(tile('Uptime', escapeHtml(formatUptime(v.daemonUptimeSeconds))));
  tiles.push(tile('Node.js', escapeHtml(v.nodeVersion)));
  tiles.push(tile(
    'Steward',
    `<span class="bv-status-pill ${stewardPill}">${escapeHtml(v.stewardStatus)}</span>${v.stewardModelRuntime ? ` · ${escapeHtml(v.stewardModelRuntime)}` : ''}`,
  ));
  tiles.push(tile(
    'Governor',
    v.governorVersion
      ? `v${escapeHtml(v.governorVersion)} · <span class="bv-status-pill ${govPill}">${escapeHtml(v.governorStatus)}</span>`
      : '<span class="muted">not-built</span>',
    !v.governorVersion,
  ));
  tiles.push(tile('MCP SDK', v.mcpSdkVersion ? escapeHtml(v.mcpSdkVersion) : '<span class="muted">unknown</span>', !v.mcpSdkVersion));
  if (v.buildTimestamp) {
    tiles.push(tile(
      'Build',
      `${escapeHtml(v.buildTimestamp)}${v.buildRunNumber ? ` · run #${escapeHtml(v.buildRunNumber)}` : ''}`,
    ));
  }

  const actions: string[] = [];
  actions.push(
    `<button type="button" data-role="bv-copy" data-copy="${escapeAttr(v.copyString)}" title="Copy version string for bug reports">Copy version</button>`,
  );
  if (gitShaUrl) {
    actions.push(`<a href="${escapeAttr(gitShaUrl)}" target="_blank" rel="noopener">View on GitHub</a>`);
  }
  if (!updateCheckDisabled) {
    actions.push(
      `<button type="button" data-role="bv-update-check" title="Check GitHub for newer releases">Check for updates</button>`,
    );
  }

  return [
    `<section class="bv-panel glass" data-role="build-versions">`,
    `<div class="bv-head">`,
    `<div>`,
    `<div class="bv-title">Build & Versions</div>`,
    `<div class="bv-meta">section 0 · the engine room</div>`,
    `</div>`,
    `</div>`,
    `<div class="bv-grid">${tiles.join('')}</div>`,
    `<div class="bv-actions">${actions.join('')}</div>`,
    `</section>`,
  ].join('');

  function tile(label: string, valueHtml: string, mutedValue = false): string {
    return [
      `<div class="bv-tile">`,
      `<div class="l">${escapeHtml(label)}</div>`,
      `<div class="v${mutedValue ? ' muted' : ''}">${valueHtml}</div>`,
      `</div>`,
    ].join('');
  }
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
.steward-meta { color: var(--ink-3); font-size: 11px; }
.steward-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.steward-tile {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
}
.steward-tile .l { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
.steward-tile .v { color: var(--ink-1); font-size: 14px; margin-top: 2px; }
.steward-tile .v.mono { font-family: var(--mono); }
.steward-mode-chip {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase;
}
.steward-mode-chip.reactive  { background: rgba(199,108,73,.16);  color: #d68a6a; border:1px solid rgba(199,108,73,.30); }
.steward-mode-chip.scheduled { background: rgba(76,140,196,.16);  color: #7ebbdf; border:1px solid rgba(76,140,196,.30); }
.steward-mode-chip.proactive { background: rgba(226,169,66,.16);  color: var(--warn); border:1px solid rgba(226,169,66,.30); }
`;

// ===================== Host-resource ceiling panel =====================
// Additive panel for Phase 6 of host-resource-ceiling BOM. Surfaces the
// configured ceiling, the most-recent headroom snapshot, the OS-cap install
// result, and refusal/shed counts in the last hour.
function renderHostCeilingPanel(d?: HostCeilingDashboardData): string {
  const headline = d ? formatHostCeilingHeadline(d) : 'host ceiling: not wired';
  const cls = d ? hostCeilingStatusClass(d) : 'idle';
  const tiles: Array<{ l: string; v: string }> = [];
  if (d?.ceiling) {
    tiles.push({ l: 'Enabled', v: d.ceiling.enabled ? 'yes' : 'no' });
    tiles.push({
      l: 'Max RAM %',
      v: `${(d.ceiling.max_host_ram_pct * 100).toFixed(0)}%`,
    });
    tiles.push({ l: 'Min free RAM', v: `${d.ceiling.min_free_ram_gb} GB` });
    tiles.push({
      l: 'Max sustained CPU',
      v: `${(d.ceiling.max_sustained_cpu_pct * 100).toFixed(0)}%`,
    });
    tiles.push({
      l: 'Max workers',
      v: d.ceiling.max_concurrent_workers === 0 ? '∞' : String(d.ceiling.max_concurrent_workers),
    });
  }
  if (d?.snapshot) {
    tiles.push({
      l: 'RAM in use (ewma)',
      v: `${(d.snapshot.ram_used_pct_ewma * 100).toFixed(1)}%`,
    });
    tiles.push({ l: 'RAM free', v: `${d.snapshot.ram_free_gb.toFixed(2)} GB` });
    tiles.push({
      l: 'CPU sustained',
      v:
        d.snapshot.cpu_busy_pct_ewma === null
          ? '—'
          : `${(d.snapshot.cpu_busy_pct_ewma * 100).toFixed(1)}%`,
    });
  }
  if (d?.os_cap) {
    tiles.push({
      l: 'OS cap',
      v: d.os_cap.installed ? `${d.os_cap.kind} (installed)` : `${d.os_cap.kind} (not installed)`,
    });
  }
  if (d) {
    tiles.push({ l: 'Refused (1h)', v: String(d.refused_recent) });
    tiles.push({ l: 'Shed (1h)', v: String(d.shed_recent) });
  }
  const tilesHtml = tiles
    .map(
      (t) =>
        `<div class="hc-tile"><div class="l">${escapeHtml(t.l)}</div><div class="v mono">${escapeHtml(t.v)}</div></div>`,
    )
    .join('');

  return [
    `<div class="glass hc-panel" data-status="${cls}">`,
    `<div class="hc-head"><span class="hc-dot"></span><strong>${escapeHtml(headline)}</strong></div>`,
    `<div class="hc-grid">${tilesHtml}</div>`,
    `</div>`,
  ].join('');
}

const HOST_CEILING_CSS = `
.hc-panel { padding: 12px 14px; margin: 10px 0; }
.hc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.hc-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--ink-3); }
.hc-panel[data-status="ok"]   .hc-dot { background: var(--green); }
.hc-panel[data-status="warn"] .hc-dot { background: var(--amber); }
.hc-panel[data-status="crit"] .hc-dot { background: var(--red); }
.hc-grid {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}
.hc-tile {
  background: rgba(20,22,31,.55); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 9px;
}
.hc-tile .l { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
.hc-tile .v { color: var(--ink-1); font-size: 13px; margin-top: 2px; }
.hc-tile .v.mono { font-family: var(--mono); }
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
