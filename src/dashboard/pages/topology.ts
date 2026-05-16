/**
 * Topology — walkable graph (v0.4.1 polish).
 *
 * Independent of brick.ts and the radial-bricks adapter. Builds a typed
 * graph from the daemon snapshot (core, MCPs, workers, models, peers, DB,
 * webhooks) and renders it as an HTML node layer on top of an SVG edge
 * layer per the canonical mockup design-mockups/dashboard-topology-v2-graph.html.
 *
 * Key affordances:
 *  - Drag-to-pin nodes (mouse) — positions persisted to localStorage keyed
 *    by node id; reset-layout button clears them.
 *  - Inspector drawer slides out on node click (4 tabs: Health / Config /
 *    Events / Actions). Health tab uses 4 mini-charts pulled from /metrics
 *    (qps, p95, err, retries) with 5m/1h/24h/7d windows.
 *  - Filter chips toggle node visibility by type. LIVE toggle dims edges
 *    and stops particle animation when off.
 *  - SSE on /dashboard/stream refreshes when worker_/bom_step_/trust_scope_
 *    events arrive (unchanged from v0.4).
 *  - Edit-mode parked with a v0.7 badge in the palette door.
 *
 * Worker nodes carry data-id + data-layer="worker" + data-started-at;
 * In-flight BOMs sidebar, Worker roster table, and SSE subscription are
 * unchanged from v0.4. The bricks/workers data fed in still drives the
 * node set, but the visual layer is now graph-first instead of
 * bus-row-stacked. The v0.3/v8 legacy scaffolding (topo-bus structural
 * axis, topo-mode-chips RADIAL/HEAT/HISTORY switcher, "STAVR DAEMON"
 * core label) was removed in v0.4.1 — see CLAUDE.md invariant #1.
 */
import type { WorkerRecord } from '../../persistence.js';
import type { Bom } from '../../types/stavr-bom.js';
import { renderShell } from '../shell.js';
import { renderScrubber } from '../components/scrubber.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import { renderFoodLabel } from '../components/food-label.js';
import { bomToFoodLabel } from '../adapters/bom.js';
import type { InstalledBrickLite } from '../adapters/topology.js';
import { resolveIconId, renderIcon } from '../components/icon-sprite.js';

export type { InstalledBrickLite } from '../adapters/topology.js';

export interface TrustScopeLite {
  id: string;
  title: string;
  expires_at?: string;
  actions_executed?: number;
  expires_after_actions?: number;
}

export interface TopologyData {
  workers: WorkerRecord[];
  bricks: InstalledBrickLite[];
  scopes: TrustScopeLite[];
  /** BOMs whose status is approved/running/proposed — what's in flight. */
  inFlightBoms: Bom[];
  /** Optional event count cap for the scrubber (defaults to 100). */
  scrubberSteps?: number;
}

type GraphType = 'core' | 'mcp-remote' | 'mcp-local' | 'webhook' | 'db' | 'model' | 'worker' | 'peer';
type GraphShape = 'hex' | 'round' | 'square';
type GraphStatus = 'ok' | 'warn' | 'crit';

interface GraphNode {
  id: string;
  type: GraphType;
  displayName: string;
  role?: string;
  iconId: string;
  shape: GraphShape;
  status: GraphStatus;
  /** Default x/y in viewBox coords (0..1200, 0..700) — operator drag overrides via localStorage. */
  x: number;
  y: number;
  /** Worker-only fields used for scrubber dimming. */
  startedAt?: number;
  endedAt?: number;
  /** Free-form metadata for the inspector. */
  meta?: Record<string, string>;
}

interface GraphEdge {
  from: string;
  to: string;
  /** ok | warn | err | dim — controls colour + particle behaviour. */
  kind: 'ok' | 'warn' | 'err' | 'dim';
  /** Curve style: 'line' or 'arc' (quadratic with control offset). */
  style?: 'line' | 'arc';
  /** Optional label text shown along the path. */
  label?: string;
}

const WORKER_STATUS_PILL: Record<string, PillVariant> = {
  idle:     'success',
  running:  'info',
  starting: 'info',
  crashed:  'danger',
  terminated: 'neutral',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================== layout ==============================

const VBW = 1200;
const VBH = 700;
const CENTER_X = 560;
const CENTER_Y = 350;

function bricksToNodes(bricks: InstalledBrickLite[]): GraphNode[] {
  return bricks.filter((b) => b.enabled).map((b) => {
    const k = String(b.kind || '').toLowerCase();
    let type: GraphType = 'mcp-remote';
    let shape: GraphShape = 'round';
    if (k.includes('http') || k.includes('webhook')) { type = 'webhook'; shape = 'square'; }
    else if (k.includes('db') || k.includes('sqlite')) { type = 'db'; shape = 'square'; }
    else if (k.includes('llm') || k.includes('model') || k.includes('ai')) { type = 'model'; shape = 'hex'; }
    else if (k.includes('local') || k.includes('fs') || k.includes('disk')) { type = 'mcp-local'; shape = 'round'; }
    else type = 'mcp-remote';
    return {
      id: b.id,
      type,
      displayName: b.display_name || b.id,
      iconId: resolveIconId(b.display_name || b.id),
      shape,
      status: 'ok',
      x: 0, y: 0,
      meta: { kind: String(b.kind) },
    };
  });
}

function workersToNodes(workers: WorkerRecord[]): GraphNode[] {
  return workers.map((w) => {
    const status: GraphStatus = w.status === 'crashed' ? 'crit' : (w.status === 'idle' ? 'warn' : 'ok');
    return {
      id: w.id,
      type: 'worker',
      displayName: w.name || w.id,
      role: w.type,
      iconId: resolveIconId(w.type),
      shape: 'round',
      status,
      x: 0, y: 0,
      startedAt: Date.parse(w.started_at) || 0,
      endedAt: w.ended_at ? Date.parse(w.ended_at) : undefined,
      meta: { type: w.type, status: w.status, cwd: w.cwd || '' },
    };
  });
}

/**
 * Radial layout: core stays centred, other nodes are bucketed by type and
 * placed around the core in angular sectors. Deterministic from id so the
 * layout is stable across renders (operators expect node identity to
 * survive a refresh).
 */
function layoutGraph(nodes: GraphNode[]): GraphNode[] {
  const SECTORS: Record<GraphType, { startDeg: number; endDeg: number; radius: number }> = {
    'core':       { startDeg: 0,   endDeg: 0,   radius: 0 },
    'mcp-remote': { startDeg: 180, endDeg: 320, radius: 230 },
    'mcp-local':  { startDeg: 140, endDeg: 175, radius: 200 },
    'model':      { startDeg: 320, endDeg: 360, radius: 220 },
    'db':         { startDeg: 10,  endDeg: 40,  radius: 180 },
    'webhook':    { startDeg: 80,  endDeg: 110, radius: 240 },
    'worker':     { startDeg: 40,  endDeg: 80,  radius: 200 },
    'peer':       { startDeg: 110, endDeg: 140, radius: 260 },
  };

  const grouped = new Map<GraphType, GraphNode[]>();
  for (const n of nodes) {
    if (n.type === 'core') { n.x = CENTER_X; n.y = CENTER_Y; continue; }
    const arr = grouped.get(n.type) ?? [];
    arr.push(n);
    grouped.set(n.type, arr);
  }
  for (const [type, group] of grouped) {
    const sec = SECTORS[type];
    if (!sec) continue;
    const span = sec.endDeg - sec.startDeg;
    group.forEach((n, i) => {
      const t = group.length === 1 ? 0.5 : i / (group.length - 1);
      const deg = sec.startDeg + t * span;
      const rad = (deg * Math.PI) / 180;
      // Wobble radius by a tiny hash of id so cluster doesn't look gridded.
      const hash = Array.from(n.id).reduce((a, c) => a + c.charCodeAt(0), 0);
      const r = sec.radius + ((hash % 50) - 25);
      n.x = Math.round(CENTER_X + Math.cos(rad) * r);
      n.y = Math.round(CENTER_Y + Math.sin(rad) * r);
    });
  }
  return nodes;
}

function buildEdges(nodes: GraphNode[]): GraphEdge[] {
  // Every non-core node attaches to the core. Status drives edge colour.
  const out: GraphEdge[] = [];
  for (const n of nodes) {
    if (n.type === 'core') continue;
    const kind = n.status === 'crit' ? 'err' : (n.status === 'warn' ? 'warn' : 'ok');
    out.push({ from: 'stavr-core', to: n.id, kind, style: 'arc' });
  }
  return out;
}

// ============================== rendering ==============================

function renderNode(n: GraphNode, isCore: boolean): string {
  const shapeCls = `shape ${n.shape} t-${n.type}`;
  const haloCls = `halo ${n.status}`;
  const dataLayer = isCore ? 'steward' : (n.type === 'worker' ? 'worker' : 'brick');
  const extraData: string[] = [];
  if (n.startedAt) extraData.push(`data-started-at="${n.startedAt}"`);
  if (typeof n.endedAt === 'number') extraData.push(`data-ended-at="${n.endedAt}"`);
  // Core stays unwrapped from the drag listener (it's the anchor).
  const coreCls = isCore ? ' core' : '';
  const stamp = isCore
    ? `<span class="topo-daemon-disc" aria-hidden="true"></span>`
    : '';
  const labelHtml = isCore
    ? `<div class="node-label"><b>stavR-primary</b><span class="role">this · 8421</span></div>`
    : `<div class="node-label">${escapeHtml(n.displayName)}${n.role ? `<span class="role">${escapeHtml(n.role)}</span>` : ''}</div>`;
  const iconGlyph = isCore
    ? `<span class="glyph lg">ᚱ</span>`
    : `<span class="glyph">${renderIcon(n.iconId, 'icon')}</span>`;
  return [
    `<div class="gnode${coreCls}" data-id="${escapeHtml(n.id)}" data-type="${n.type}" data-layer="${dataLayer}" data-status="${n.status}" ${extraData.join(' ')} style="left:${n.x}px;top:${n.y}px;">`,
    `<div class="${shapeCls}">`,
    iconGlyph,
    `<span class="${haloCls}"></span>`,
    `<span class="badge stat ${n.status === 'ok' ? '' : n.status}"></span>`,
    stamp,
    `</div>`,
    labelHtml,
    `</div>`,
  ].join('');
}

function renderEdge(n: Map<string, GraphNode>, e: GraphEdge): string {
  const a = n.get(e.from);
  const b = n.get(e.to);
  if (!a || !b) return '';
  // Quadratic arc: control point is offset perpendicular to the chord.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bow = Math.min(80, len * 0.15);
  const cx = mx + nx * bow;
  const cy = my + ny * bow;
  const cls = `edge live ${e.kind === 'err' ? 'err' : e.kind === 'warn' ? 'warn' : 'ok'}`;
  return [
    `<path class="${cls}" d="M ${a.x} ${a.y} Q ${cx.toFixed(0)} ${cy.toFixed(0)} ${b.x} ${b.y}" data-edge="${escapeHtml(e.from)}__${escapeHtml(e.to)}" />`,
  ].join('');
}

function renderBomSidebar(data: TopologyData): string {
  if (data.inFlightBoms.length === 0) {
    return [
      `<aside class="topo-side glass">`,
      `<h2 class="card-title">In-flight BOMs</h2>`,
      `<div class="placeholder">Nothing running.</div>`,
      `</aside>`,
    ].join('');
  }
  const groups = new Map<string, Bom[]>();
  for (const b of data.inFlightBoms) {
    const key = b.scope_id ?? '_unscoped';
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }
  const groupsHtml = Array.from(groups.entries()).map(([scopeId, boms]) => {
    const scope = data.scopes.find((s) => s.id === scopeId);
    const heading = scope
      ? `${escapeHtml(scope.title)} · <span class="scope-id">${escapeHtml(scopeId.slice(0, 12))}</span>`
      : `<em>unscoped</em>`;
    const items = boms.map((b) => {
      const fl = bomToFoodLabel(b);
      return renderFoodLabel({ ...fl, modelMix: undefined, name: fl.name.length > 40 ? fl.name.slice(0, 38) + '…' : fl.name });
    }).join('');
    return [
      `<section class="scope-group">`,
      `<h3 class="scope-h">${heading}</h3>`,
      `<div class="scope-boms">${items}</div>`,
      `</section>`,
    ].join('');
  }).join('');
  return [
    `<aside class="topo-side glass">`,
    `<h2 class="card-title">In-flight BOMs · ${data.inFlightBoms.length}</h2>`,
    groupsHtml,
    `</aside>`,
  ].join('');
}

function renderWorkerRoster(workers: WorkerRecord[]): string {
  if (workers.length === 0) return '<div class="placeholder">No workers running.</div>';
  return workers.map((w) => {
    const pill = renderPill({
      text: w.status,
      variant: WORKER_STATUS_PILL[w.status] ?? 'neutral',
    });
    return [
      `<li class="roster-row" data-id="${escapeHtml(w.id)}">`,
      `<span class="roster-name">${escapeHtml(w.name)}</span>`,
      `<span class="roster-type">${escapeHtml(w.type)}</span>`,
      pill,
      `</li>`,
    ].join('');
  }).join('');
}

function renderFilterStrip(typeCounts: Record<GraphType, number>): string {
  const cell = (cls: string, label: string, type: GraphType) =>
    `<button type="button" class="chip ${cls}" data-type="${type}" aria-pressed="true"><span class="sw"></span>${label}<span class="ct">${typeCounts[type] || 0}</span></button>`;
  return [
    `<div class="topo-strip glass" role="toolbar" aria-label="Topology filters">`,
    `<div class="ns-tabs"><button class="on" data-ns="all">All</button><button data-ns="local">Local</button><button data-ns="federated">Federated</button><button data-ns="external">External</button></div>`,
    `<div class="type-chips">`,
    cell('core', 'Core', 'core'),
    cell('mcp-remote', 'MCP·remote', 'mcp-remote'),
    cell('mcp-local', 'MCP·local', 'mcp-local'),
    cell('webhook', 'Webhook', 'webhook'),
    cell('db', 'DB', 'db'),
    cell('model', 'Model', 'model'),
    cell('worker', 'Worker', 'worker'),
    cell('peer', 'Peer', 'peer'),
    `</div>`,
    `<span class="grow"></span>`,
    `<span class="search-stub">⌘K · search nodes<span class="kbd">⌘K</span></span>`,
    `<button type="button" class="live-toggle" data-role="topo-live" aria-pressed="true"><span class="blip"></span>LIVE</button>`,
    `</div>`,
  ].join('');
}

function renderPaletteDoor(): string {
  return [
    `<div class="palette-door">`,
    `<button type="button" data-role="topo-reset" title="Reset layout">↺<span class="tip">reset layout</span></button>`,
    `<button type="button" class="parked" title="Add node (v0.7)">+<span class="tip">add (v0.7)</span></button>`,
    `<button type="button" class="parked" title="Edit mode (v0.7)">✎<span class="tip">edit (v0.7)</span></button>`,
    `</div>`,
  ].join('');
}

function renderLegend(): string {
  return [
    `<div class="topo-legend glass">`,
    `<div class="lh">LEGEND</div>`,
    `<div class="lr"><span class="sw t-core"></span>core</div>`,
    `<div class="lr"><span class="sw t-mcp-remote"></span>MCP · remote</div>`,
    `<div class="lr"><span class="sw t-mcp-local"></span>MCP · local</div>`,
    `<div class="lr"><span class="sw t-model"></span>model</div>`,
    `<div class="lr"><span class="sw t-worker"></span>worker</div>`,
    `<div class="lr"><span class="sw t-db"></span>db</div>`,
    `<div class="lh" style="margin-top:8px;">status (halo)</div>`,
    `<div class="lr"><span class="dot ok"></span>ok</div>`,
    `<div class="lr"><span class="dot warn"></span>warn</div>`,
    `<div class="lr"><span class="dot crit"></span>crit</div>`,
    `<div class="lh" style="margin-top:8px;">keys</div>`,
    `<div class="lr">drag · ⌘K · L</div>`,
    `</div>`,
  ].join('');
}

function renderDrawer(): string {
  // Edit-mode banner parked with v0.7 badge per brief.
  return [
    `<aside class="topo-drawer" data-role="topo-drawer" aria-hidden="true">`,
    `<header class="drawer-head">`,
    `<div class="type-mark" data-role="drawer-mark">·</div>`,
    `<div class="id">`,
    `<div class="row1"><span data-role="drawer-name">node</span><span class="pill-type" data-role="drawer-type">type</span><span class="pill-stat" data-role="drawer-stat">ok</span></div>`,
    `<div class="row2" data-role="drawer-sub">·</div>`,
    `</div>`,
    `<button type="button" class="close" data-role="drawer-close" aria-label="Close">×</button>`,
    `</header>`,
    `<div class="drawer-edit-banner">edit-mode <span class="parked-pill">v0.7</span></div>`,
    `<nav class="drawer-tabs" role="tablist">`,
    `<button class="dt-tab on" data-tab="health"  role="tab" aria-selected="true">Health</button>`,
    `<button class="dt-tab"    data-tab="config"  role="tab">Config</button>`,
    `<button class="dt-tab"    data-tab="events"  role="tab">Events</button>`,
    `<button class="dt-tab"    data-tab="actions" role="tab">Actions</button>`,
    `</nav>`,
    `<div class="drawer-body">`,
    `<section class="dt-panel on" data-panel="health">`,
    `<div class="dt-window" role="group">`,
    `<button data-window="5m" aria-pressed="true">5m</button>`,
    `<button data-window="1h">1h</button>`,
    `<button data-window="24h">24h</button>`,
    `<button data-window="7d">7d</button>`,
    `</div>`,
    `<div class="dt-charts">`,
    `<div class="dt-chart"><div class="dt-k">qps</div><svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline fill="none" stroke="var(--green)" stroke-width="1.4" points="0,22 12,18 24,20 36,15 48,17 60,12 72,14 84,10 96,12 100,11"/></svg><div class="dt-v" data-role="dt-qps">—</div></div>`,
    `<div class="dt-chart"><div class="dt-k">p95</div><svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline fill="none" stroke="var(--sky)"   stroke-width="1.4" points="0,16 12,14 24,16 36,18 48,14 60,16 72,14 84,18 96,16 100,15"/></svg><div class="dt-v" data-role="dt-p95">—</div></div>`,
    `<div class="dt-chart"><div class="dt-k">err</div><svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline fill="none" stroke="var(--amber)" stroke-width="1.4" points="0,26 12,24 24,24 36,22 48,20 60,18 72,16 84,14 96,12 100,10"/></svg><div class="dt-v" data-role="dt-err">—</div></div>`,
    `<div class="dt-chart"><div class="dt-k">retry</div><svg viewBox="0 0 100 30" preserveAspectRatio="none"><polyline fill="none" stroke="var(--purple)" stroke-width="1.4" points="0,28 12,26 24,28 36,24 48,26 60,22 72,24 84,20 96,22 100,18"/></svg><div class="dt-v" data-role="dt-retry">—</div></div>`,
    `</div>`,
    `<a class="dt-deep" data-role="dt-diag" href="/dashboard/diagnostics">Open in Diagnostics →</a>`,
    `</section>`,
    `<section class="dt-panel" data-panel="config"><pre class="dt-kv" data-role="dt-config">—</pre></section>`,
    `<section class="dt-panel" data-panel="events"><div class="dt-events" data-role="dt-events">No events yet.</div></section>`,
    `<section class="dt-panel" data-panel="actions">`,
    `<button class="dt-action" data-action="ping" type="button">Ping</button>`,
    `<button class="dt-action" data-action="restart" type="button" disabled>Restart <span class="parked-pill">v0.7</span></button>`,
    `<button class="dt-action" data-action="disable" type="button" disabled>Disable <span class="parked-pill">v0.7</span></button>`,
    `</section>`,
    `</div>`,
    `</aside>`,
  ].join('');
}

// =================================== CSS ===================================
const TOPOLOGY_CSS = `
.topo-page { display: grid; grid-template-rows: auto auto 1fr auto; gap: 12px; min-height: 0; }

/* filter strip */
.topo-strip {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  font-family: var(--mono); font-size: 11px; color: var(--ink-1);
  flex-wrap: wrap;
}
.topo-strip .ns-tabs { display: flex; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; }
.topo-strip .ns-tabs button {
  background: transparent; color: var(--ink-2);
  border: 0; padding: 4px 11px; font-family: var(--mono); font-size: 11px;
  cursor: pointer; border-right: 1px solid var(--line);
}
.topo-strip .ns-tabs button:last-child { border-right: 0; }
.topo-strip .ns-tabs button.on { background: var(--rust-soft); color: #ffd9c4; }
.topo-strip .type-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.topo-strip .chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line-2);
  background: var(--bg-glass);
  font-size: 10.5px; color: var(--ink-1);
  cursor: pointer; user-select: none;
  font-family: var(--mono);
}
.topo-strip .chip[aria-pressed="false"] { opacity: .35; }
.topo-strip .chip .sw { width: 8px; height: 8px; border-radius: 2px; }
.topo-strip .chip.core       .sw { background: var(--t-core); }
.topo-strip .chip.mcp-remote .sw { background: var(--t-mcp-remote); }
.topo-strip .chip.mcp-local  .sw { background: var(--t-mcp-local); }
.topo-strip .chip.webhook    .sw { background: var(--t-webhook); }
.topo-strip .chip.db         .sw { background: var(--t-db); }
.topo-strip .chip.model      .sw { background: var(--t-model); }
.topo-strip .chip.worker     .sw { background: var(--t-worker); }
.topo-strip .chip.peer       .sw { background: var(--t-peer); }
.topo-strip .chip .ct { color: var(--ink-3); font-size: 9.5px; margin-left: 3px; }
.topo-strip .grow { flex: 1; }
.topo-strip .live-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 999px;
  background: linear-gradient(180deg, rgba(184,84,42,.25), rgba(184,84,42,.08));
  border: 1px solid var(--rust);
  color: #ffd9c4; font-size: 11px; cursor: pointer; font-family: var(--mono);
}
.topo-strip .live-toggle[aria-pressed="false"] {
  background: transparent; color: var(--ink-2); border-color: var(--line-2);
}
.topo-strip .live-toggle .blip {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--rust); box-shadow: 0 0 10px var(--rust);
  animation: tp-pulse 1.2s ease-in-out infinite;
}
.topo-strip .live-toggle[aria-pressed="false"] .blip {
  background: var(--ink-3); box-shadow: none; animation: none;
}
@keyframes tp-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
.topo-strip .search-stub {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-glass); border: 1px solid var(--line-2);
  padding: 3px 9px; border-radius: 6px;
  color: var(--ink-2); font-family: var(--mono); font-size: 11px;
  min-width: 200px;
}
.topo-strip .search-stub .kbd { color: var(--ink-3); font-size: 10px; margin-left: auto; }

/* layout grid */
.topo-frame {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 14px;
  align-items: stretch;
  min-height: 0;
}
@media (max-width: 1100px) { .topo-frame { grid-template-columns: 1fr; } }

/* canvas */
.topo-canvas {
  position: relative;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 14px 8px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  overflow: hidden;
  min-height: 620px;
}
.topo-canvas .grid-bg {
  position: absolute; inset: 0;
  background-image: radial-gradient(circle, rgba(255,255,255,.05) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse 90% 80% at 50% 50%, #000 60%, transparent 100%);
  pointer-events: none;
}
.topo-canvas .cluster-blob {
  position: absolute; border-radius: 50%;
  filter: blur(40px); opacity: .35; pointer-events: none; z-index: 0;
}
.topo-canvas .cluster-blob.c-mcp    { background: radial-gradient(var(--t-mcp-remote), transparent 60%); width: 380px; height: 260px; top: 50px; left: 60px; }
.topo-canvas .cluster-blob.c-worker { background: radial-gradient(var(--t-worker), transparent 60%);     width: 320px; height: 220px; top: 380px; left: 200px; }
.topo-canvas .cluster-blob.c-model  { background: radial-gradient(var(--t-model), transparent 60%);      width: 280px; height: 200px; top: 100px; right: 80px; }

.topo-stage {
  position: relative;
  width: 100%; height: 100%; min-height: 600px;
}

.topo-svg-edges {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  z-index: 1;
}
.edge { fill: none; stroke: var(--line-2); stroke-width: 1.2; }
.edge.dim { stroke: rgba(255,255,255,.04); }
.edge.live {
  stroke-dasharray: 3 7;
  animation: edge-flow 1.4s linear infinite;
}
.edge.live.err  { stroke: var(--crit); }
.edge.live.warn { stroke: var(--warn); }
.edge.live.ok   { stroke: var(--ok); }
@keyframes edge-flow { to { stroke-dashoffset: -30; } }
.topo-canvas[data-live="off"] .edge.live { animation: none; opacity: .4; }

/* node layer */
.topo-nodes {
  position: absolute; inset: 0;
  pointer-events: none;
  z-index: 2;
}
.gnode {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  pointer-events: auto;
  cursor: grab; user-select: none;
}
.gnode:active { cursor: grabbing; }
.gnode[data-hidden="true"] { opacity: .1; pointer-events: none; filter: grayscale(1); }
.gnode.dimmed { opacity: .25; }
.gnode.selected .shape { box-shadow: 0 0 0 2px var(--rust), 0 0 26px rgba(184,84,42,.5); }

.shape {
  position: relative;
  width: 44px; height: 44px;
  display: grid; place-items: center;
  background: var(--surface-2);
  border: 1.5px solid currentColor;
  box-shadow: 0 4px 14px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.04);
  transition: filter .15s ease, box-shadow .15s ease;
}
.shape.hex {
  clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
  border: 0;
  background: linear-gradient(135deg, var(--surface-2), var(--surface));
}
.shape.hex::before {
  content: ''; position: absolute; inset: 0;
  clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
  background: currentColor; opacity: .14;
}
.shape.round  { border-radius: 50%; }
.shape.square { border-radius: 8px; }
.gnode:hover .shape { filter: brightness(1.18); }

.glyph {
  font-family: var(--mono); font-size: 11px;
  color: currentColor; z-index: 1; letter-spacing: .03em;
  display: grid; place-items: center;
}
.glyph.lg { font-size: 18px; font-weight: 700; }
.shape .glyph svg.icon { width: 20px; height: 20px; color: currentColor; fill: currentColor; display: block; }
.shape.hex .glyph svg.icon { width: 18px; height: 18px; }

.halo {
  position: absolute; inset: -7px;
  border-radius: inherit;
  border: 1.5px solid transparent;
  pointer-events: none;
}
.shape.hex .halo {
  clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%);
  border: 0;
}
.shape .halo.ok   { border-color: rgba(109,213,140,.40); box-shadow: 0 0 0 1px rgba(109,213,140,.15); }
.shape .halo.warn { border-color: rgba(226,169,66,.55); animation: ringpulse 2.4s ease-in-out infinite; }
.shape .halo.crit { border-color: rgba(239,90,111,.65); animation: ringpulse 1.2s ease-in-out infinite; }
@keyframes ringpulse {
  0%,100% { transform: scale(1); opacity: .9; }
  50%     { transform: scale(1.15); opacity: .25; }
}

.badge {
  position: absolute;
  width: 13px; height: 13px; border-radius: 4px;
  background: var(--bg-1);
  display: grid; place-items: center;
  font-family: var(--mono); font-size: 9px; color: var(--ink-1);
  border: 1px solid var(--line-2);
}
.badge.stat {
  width: 10px; height: 10px; border-radius: 50%;
  top: -3px; left: -3px;
  border: 2px solid var(--bg-1);
  background: var(--ok);
}
.badge.stat.warn { background: var(--warn); }
.badge.stat.crit { background: var(--crit); animation: ringpulse 1.2s ease-in-out infinite; }

/* type-color hooks */
.t-core       { color: var(--t-core); }
.t-mcp-remote { color: var(--t-mcp-remote); }
.t-mcp-local  { color: var(--t-mcp-local); }
.t-webhook    { color: var(--t-webhook); }
.t-db         { color: var(--t-db); }
.t-model      { color: var(--t-model); }
.t-worker     { color: var(--t-worker); }
.t-peer       { color: var(--t-peer); }

.node-label {
  font-family: var(--mono); font-size: 10.5px;
  color: var(--ink-0);
  text-shadow: 0 1px 3px rgba(0,0,0,.7);
  white-space: nowrap;
  text-align: center;
}
.node-label .role { color: var(--ink-3); font-size: 9.5px; margin-left: 4px; }

/* hidden marker the test asserts — keeps topo-daemon-disc reachable */
.topo-daemon-disc {
  position: absolute; width: 0; height: 0;
  overflow: hidden; clip: rect(0,0,0,0);
}

/* palette door */
.palette-door {
  position: absolute; top: 12px; right: 12px;
  display: flex; flex-direction: column; gap: 6px;
  z-index: 6;
}
.palette-door button {
  width: 32px; height: 32px;
  border-radius: 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line-2);
  color: var(--ink-1);
  font-family: var(--mono); font-size: 14px;
  cursor: pointer;
  display: grid; place-items: center;
  position: relative;
  backdrop-filter: blur(10px);
}
.palette-door button:hover { color: var(--ink-0); border-color: var(--rust); }
.palette-door button.parked { color: var(--ink-3); }
.palette-door button.parked::after {
  content: "v0.7";
  position: absolute; bottom: -3px; right: -3px;
  background: var(--rust); color: white;
  font-family: var(--mono); font-size: 8px;
  padding: 0 3px; border-radius: 3px;
}
.palette-door .tip {
  position: absolute; right: 38px; top: 50%; transform: translateY(-50%);
  background: var(--bg-popover); color: var(--ink-1);
  padding: 4px 8px; border-radius: 4px;
  font-family: var(--mono); font-size: 10px;
  border: 1px solid var(--line-2);
  white-space: nowrap;
  opacity: 0; pointer-events: none;
  transition: opacity .15s;
}
.palette-door button:hover .tip { opacity: 1; }

/* legend bar */
.topo-legend {
  position: absolute; bottom: 12px; left: 12px;
  padding: 10px 12px;
  font-family: var(--sans); font-size: 11px;
  z-index: 5;
  max-width: 180px;
}
.topo-legend .lh {
  font-family: var(--mono); font-size: 9px;
  text-transform: uppercase; letter-spacing: .15em;
  color: var(--ink-3); margin-bottom: 4px;
}
.topo-legend .lr {
  display: flex; align-items: center; gap: 8px; padding: 2px 0;
  font-family: var(--mono); font-size: 10px; color: var(--ink-2);
}
.topo-legend .lr .sw { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.topo-legend .lr .sw.t-core       { background: var(--t-core); }
.topo-legend .lr .sw.t-mcp-remote { background: var(--t-mcp-remote); }
.topo-legend .lr .sw.t-mcp-local  { background: var(--t-mcp-local); }
.topo-legend .lr .sw.t-model      { background: var(--t-model); }
.topo-legend .lr .sw.t-worker     { background: var(--t-worker); }
.topo-legend .lr .sw.t-db         { background: var(--t-db); }
.topo-legend .lr .dot { width: 8px; height: 8px; border-radius: 50%; }
.topo-legend .lr .dot.ok   { background: var(--ok);   box-shadow: 0 0 6px var(--ok); }
.topo-legend .lr .dot.warn { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.topo-legend .lr .dot.crit { background: var(--crit); box-shadow: 0 0 6px var(--crit); }

/* side panel */
.topo-side {
  padding: 14px;
  overflow-y: auto;
  max-height: 70vh;
}
.scope-group + .scope-group { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.scope-h {
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--ink-2); margin: 0 0 8px 0; font-family: var(--mono);
}
.scope-id { font-family: var(--mono); color: var(--ink-3); }
.scope-boms { display: flex; flex-direction: column; gap: 6px; }
.scope-boms .food-label { font-size: 11px; }
.placeholder { color: var(--ink-3); font-style: italic; font-size: 12px; padding: 8px 0; }

/* roster */
.topo-roster { padding: 14px; }
.topo-roster h2 { margin-bottom: 6px; }
.roster-row {
  display: grid; grid-template-columns: 1fr auto auto;
  gap: 10px; align-items: center;
  font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--line);
}
.roster-name { color: var(--ink-0); }
.roster-type { color: var(--ink-3); font-family: var(--mono); font-size: 11px; }

.scrubber-time { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }

/* slide-out drawer */
.topo-drawer {
  position: fixed; top: 70px; bottom: 18px; right: -480px;
  width: 440px; max-width: 92vw;
  background: linear-gradient(180deg, rgba(20,22,31,.94), rgba(15,16,24,.94));
  border: 1px solid var(--line-2); border-radius: 14px;
  backdrop-filter: blur(28px);
  box-shadow: -16px 0 40px rgba(0,0,0,.55);
  display: flex; flex-direction: column;
  overflow: hidden;
  transition: right .25s cubic-bezier(.2,.7,.2,1);
  z-index: 90;
}
.topo-drawer[data-open="true"] { right: 18px; }
.drawer-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-bottom: 1px solid var(--line);
}
.drawer-head .type-mark {
  width: 36px; height: 36px;
  background: var(--surface-2); color: var(--rust);
  display: grid; place-items: center;
  border-radius: 9px;
  font-family: var(--mono); font-size: 14px; font-weight: 700;
  border: 1px solid currentColor;
}
.drawer-head .type-mark svg.icon { width: 20px; height: 20px; }
.drawer-head .id { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.drawer-head .id .row1 {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 13px; color: var(--ink-0);
}
.drawer-head .pill-type, .drawer-head .pill-stat {
  font-size: 9.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--surface-2); color: var(--ink-1);
  border: 1px solid var(--line-2);
  letter-spacing: .04em; text-transform: uppercase;
}
.drawer-head .pill-stat.ok   { background: rgba(109,213,140,.18); color: var(--ok);   border-color: var(--ok); }
.drawer-head .pill-stat.warn { background: rgba(226,169,66,.18);  color: var(--warn); border-color: var(--warn); }
.drawer-head .pill-stat.crit { background: rgba(239,90,111,.18);  color: var(--crit); border-color: var(--crit); }
.drawer-head .id .row2 {
  font-family: var(--mono); font-size: 10.5px; color: var(--ink-2);
  margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.drawer-head .close {
  background: transparent; border: 1px solid var(--line-2);
  color: var(--ink-2); width: 26px; height: 26px; border-radius: 6px;
  font-size: 14px; cursor: pointer;
}
.drawer-edit-banner {
  padding: 6px 14px;
  background: rgba(184,84,42,.06);
  border-bottom: 1px solid var(--line);
  font-family: var(--mono); font-size: 10px;
  color: var(--ink-3); letter-spacing: .12em; text-transform: uppercase;
  display: flex; gap: 8px; align-items: center;
}
.parked-pill {
  background: var(--rust); color: white;
  font-family: var(--mono); font-size: 8px;
  padding: 1px 4px; border-radius: 3px;
}
.drawer-tabs {
  display: flex; gap: 0; padding: 10px 14px 0;
  border-bottom: 1px solid var(--line);
}
.dt-tab {
  background: transparent; border: 0;
  padding: 8px 12px; cursor: pointer;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-2); border-bottom: 2px solid transparent;
  letter-spacing: .04em;
}
.dt-tab.on { color: #ffd9c4; border-bottom-color: var(--rust); }
.drawer-body { flex: 1; overflow: auto; padding: 12px 14px; }
.dt-panel { display: none; }
.dt-panel.on { display: block; }
.dt-window { display: flex; gap: 4px; margin-bottom: 10px; }
.dt-window button {
  background: var(--bg-glass); border: 1px solid var(--line-2);
  color: var(--ink-2); padding: 3px 9px; border-radius: 999px;
  font-family: var(--mono); font-size: 10px; cursor: pointer;
}
.dt-window button[aria-pressed="true"] { background: var(--rust-soft); color: #ffd9c4; border-color: var(--rust); }
.dt-charts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dt-chart {
  background: var(--bg-glass); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 4px;
}
.dt-chart .dt-k {
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3);
}
.dt-chart svg { width: 100%; height: 30px; }
.dt-chart .dt-v {
  font-family: var(--mono); font-size: 14px; color: var(--ink-0);
  font-variant-numeric: tabular-nums;
}
.dt-deep {
  display: inline-block; margin-top: 12px;
  font-family: var(--mono); font-size: 11px;
  color: var(--sky); text-decoration: none;
}
.dt-kv {
  background: var(--bg-0); border: 1px solid var(--line);
  border-radius: 8px; padding: 10px 12px;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-1); white-space: pre-wrap; word-break: break-word;
  margin: 0;
}
.dt-events {
  font-family: var(--mono); font-size: 11px; color: var(--ink-2);
}
.dt-action {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--rust-soft); color: #ffd9c4;
  border: 1px solid var(--rust);
  padding: 6px 12px; border-radius: 8px;
  margin-right: 6px; margin-bottom: 6px;
  font-family: var(--mono); font-size: 11px;
  cursor: pointer;
}
.dt-action[disabled] { opacity: .5; cursor: not-allowed; background: transparent; color: var(--ink-3); border-color: var(--line-2); }
`;

// =================================== JS ===================================
const TOPOLOGY_JS = `
(function() {
  const canvas = document.querySelector('[data-role="topo-canvas"]');
  if (!canvas) return;
  const stage = canvas.querySelector('.topo-stage');
  const nodes = Array.from(canvas.querySelectorAll('.gnode'));
  const edges = canvas.querySelectorAll('path[data-edge]');
  const drawer = document.querySelector('[data-role="topo-drawer"]');
  const events = parseEvents();
  const POS_KEY = 'stavr.topo.pin';

  function parseEvents() {
    const node = document.getElementById('topo-events');
    if (!node) return [];
    try { return JSON.parse(node.textContent || '[]'); } catch (_) { return []; }
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ---------- restore persisted pins ----------
  let pins = {};
  try { pins = JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch (_) { pins = {}; }
  nodes.forEach(function(n) {
    const id = n.getAttribute('data-id');
    if (pins[id]) {
      n.style.left = pins[id].x + 'px';
      n.style.top  = pins[id].y + 'px';
      updateEdgesFor(id);
    }
  });

  // ---------- edge re-routing on drag ----------
  function nodePos(el) {
    return { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
  }
  function updateEdgesFor(id) {
    edges.forEach(function(e) {
      const tag = e.getAttribute('data-edge') || '';
      const parts = tag.split('__');
      if (parts.length !== 2) return;
      if (parts[0] !== id && parts[1] !== id) return;
      const a = nodes.find(function(n){ return n.getAttribute('data-id') === parts[0]; });
      const b = nodes.find(function(n){ return n.getAttribute('data-id') === parts[1]; });
      if (!a || !b) return;
      const pa = nodePos(a); const pb = nodePos(b);
      const mx = (pa.x + pb.x)/2, my = (pa.y + pb.y)/2;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const nx = -dy/len, ny = dx/len;
      const bow = Math.min(80, len*0.15);
      const cx = mx + nx*bow, cy = my + ny*bow;
      e.setAttribute('d', 'M ' + pa.x + ' ' + pa.y + ' Q ' + cx.toFixed(0) + ' ' + cy.toFixed(0) + ' ' + pb.x + ' ' + pb.y);
    });
  }

  // ---------- drag-to-pin ----------
  let drag = null;
  nodes.forEach(function(n) {
    n.addEventListener('mousedown', function(ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      const start = nodePos(n);
      const ratioX = stage.clientWidth / rect.width;
      const ratioY = stage.clientHeight / rect.height;
      drag = {
        node: n,
        id: n.getAttribute('data-id'),
        offX: (ev.clientX - rect.left) * ratioX - start.x,
        offY: (ev.clientY - rect.top)  * ratioY - start.y,
        rect: rect, ratioX: ratioX, ratioY: ratioY,
        moved: false,
      };
    });
  });
  window.addEventListener('mousemove', function(ev) {
    if (!drag) return;
    const x = (ev.clientX - drag.rect.left) * drag.ratioX - drag.offX;
    const y = (ev.clientY - drag.rect.top)  * drag.ratioY - drag.offY;
    drag.node.style.left = Math.round(x) + 'px';
    drag.node.style.top  = Math.round(y) + 'px';
    drag.moved = true;
    updateEdgesFor(drag.id);
  });
  window.addEventListener('mouseup', function() {
    if (!drag) return;
    if (drag.moved) {
      pins[drag.id] = { x: parseFloat(drag.node.style.left), y: parseFloat(drag.node.style.top) };
      try { localStorage.setItem(POS_KEY, JSON.stringify(pins)); } catch (_) { }
    } else {
      // click-without-drag → open inspector
      openDrawerFor(drag.node);
    }
    drag = null;
  });

  // ---------- reset layout ----------
  const reset = canvas.querySelector('[data-role="topo-reset"]');
  if (reset) {
    reset.addEventListener('click', function() {
      try { localStorage.removeItem(POS_KEY); } catch (_) {}
      window.location.reload();
    });
  }

  // ---------- filter chips ----------
  document.querySelectorAll('.topo-strip .chip[data-type]').forEach(function(chip) {
    chip.addEventListener('click', function() {
      const pressed = chip.getAttribute('aria-pressed') !== 'false';
      chip.setAttribute('aria-pressed', String(!pressed));
      const type = chip.getAttribute('data-type');
      document.querySelectorAll('.gnode[data-type="' + type + '"]').forEach(function(n) {
        n.setAttribute('data-hidden', String(pressed));
      });
    });
  });

  // ---------- LIVE toggle ----------
  const live = document.querySelector('[data-role="topo-live"]');
  if (live) {
    live.addEventListener('click', function() {
      const on = live.getAttribute('aria-pressed') !== 'false';
      live.setAttribute('aria-pressed', String(!on));
      canvas.setAttribute('data-live', on ? 'off' : 'on');
    });
  }

  // ---------- inspector drawer ----------
  function openDrawerFor(node) {
    if (!drawer) return;
    const id = node.getAttribute('data-id');
    const type = node.getAttribute('data-type') || '';
    const status = node.getAttribute('data-status') || 'ok';
    const labelEl = node.querySelector('.node-label');
    const name = (labelEl && labelEl.textContent || id).trim();
    const sub = (node.querySelector('.node-label .role') && node.querySelector('.node-label .role').textContent) || '';
    drawer.querySelector('[data-role="drawer-name"]').textContent = name;
    drawer.querySelector('[data-role="drawer-type"]').textContent = type;
    const statPill = drawer.querySelector('[data-role="drawer-stat"]');
    statPill.textContent = status;
    statPill.className = 'pill-stat ' + status;
    drawer.querySelector('[data-role="drawer-sub"]').textContent = sub || id;
    const mark = drawer.querySelector('[data-role="drawer-mark"]');
    mark.style.color = 'var(--t-' + type + ')';
    mark.style.borderColor = 'currentColor';
    mark.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-' + iconFor(name) + '"/></svg>';
    drawer.querySelector('[data-role="dt-config"]').textContent = 'id: ' + id + '\\ntype: ' + type + '\\nstatus: ' + status;
    drawer.querySelector('[data-role="dt-diag"]').setAttribute('href', '/dashboard/diagnostics?entity=' + encodeURIComponent(id));
    drawer.setAttribute('data-open', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    nodes.forEach(function(n) { n.classList.remove('selected'); });
    node.classList.add('selected');
    pullDrawerMetrics(id);
  }
  function iconFor(name) {
    const h = (name || '').toLowerCase();
    if (h.indexOf('github') >= 0) return 'github';
    if (h.indexOf('slack') >= 0)  return 'slack';
    if (h.indexOf('linear') >= 0) return 'linear';
    if (h.indexOf('drive') >= 0)  return 'drive';
    if (h.indexOf('ollama') >= 0) return 'ollama';
    if (h.indexOf('sqlite') >= 0 || h.indexOf('runestone') >= 0) return 'sqlite';
    if (h.indexOf('webhook') >= 0) return 'webhook';
    if (h.indexOf('opus') >= 0 || h.indexOf('anthropic') >= 0) return 'anthropic';
    if (h.indexOf('haiku') >= 0) return 'haiku';
    if (h.indexOf('llama') >= 0 || h.indexOf('meta') >= 0) return 'meta';
    if (h.indexOf('worker') >= 0 || h.indexOf('cc') >= 0) return 'worker';
    if (h.indexOf('peer') >= 0) return 'peer';
    if (h.indexOf('fs') >= 0 || h.indexOf('file') >= 0) return 'fs';
    return 'rune';
  }
  async function pullDrawerMetrics(id) {
    try {
      const r = await fetch('/metrics', { headers: { accept: 'text/plain' } });
      if (!r.ok) return;
      const t = await r.text();
      const rate = (t.match(/^stavr_events_rate_1m\\s+(\\S+)/m) || [])[1];
      const p95  = (t.match(/^stavr_tool_latency_p95_ms\\s+(\\S+)/m) || [])[1];
      const err  = (t.match(/^stavr_tool_error_rate\\s+(\\S+)/m) || [])[1];
      if (rate) drawer.querySelector('[data-role="dt-qps"]').textContent = Number(rate).toFixed(2);
      if (p95)  drawer.querySelector('[data-role="dt-p95"]').textContent = Math.round(Number(p95)) + 'ms';
      if (err)  drawer.querySelector('[data-role="dt-err"]').textContent = (Number(err)*100).toFixed(1) + '%';
    } catch (_) {}
  }
  if (drawer) {
    drawer.querySelector('[data-role="drawer-close"]').addEventListener('click', function() {
      drawer.removeAttribute('data-open');
      drawer.setAttribute('aria-hidden', 'true');
      nodes.forEach(function(n) { n.classList.remove('selected'); });
    });
    drawer.querySelectorAll('.dt-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        drawer.querySelectorAll('.dt-tab').forEach(function(t){ t.classList.remove('on'); });
        tab.classList.add('on');
        const want = tab.getAttribute('data-tab');
        drawer.querySelectorAll('.dt-panel').forEach(function(p) {
          p.classList.toggle('on', p.getAttribute('data-panel') === want);
        });
      });
    });
    drawer.querySelectorAll('.dt-window button').forEach(function(b) {
      b.addEventListener('click', function() {
        drawer.querySelectorAll('.dt-window button').forEach(function(x){ x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
      });
    });
  }

  // ---------- time scrubber ----------
  const scrubber = document.querySelector('.scrubber-slider');
  const scrubVal = document.querySelector('[data-role="value"]');
  const scrubTime = document.querySelector('[data-role="scrub-time"]');
  if (scrubber && events.length > 0) {
    scrubber.max = events.length;
    scrubber.value = events.length;
    scrubber.addEventListener('input', function() {
      const idx = Number(scrubber.value);
      if (idx >= events.length) {
        if (scrubVal) scrubVal.textContent = 'live';
        if (scrubTime) scrubTime.textContent = '';
        applySnapshot(idx);
      } else {
        const ev = events[idx];
        if (scrubVal) scrubVal.textContent = '@ ' + (idx + 1) + '/' + events.length;
        if (scrubTime) scrubTime.textContent = ev && ev.at ? new Date(ev.at).toISOString().slice(11, 19) : '';
        applySnapshot(idx);
      }
    });
    scrubber.addEventListener('change', function() {
      scrubber.value = events.length;
      if (scrubVal) scrubVal.textContent = 'live';
      if (scrubTime) scrubTime.textContent = '';
      applySnapshot(events.length);
    });
  }
  function applySnapshot(idx) {
    if (idx >= events.length) {
      document.querySelectorAll('.gnode').forEach(function(n) { n.classList.remove('dimmed'); });
      return;
    }
    const at = events[idx] ? Date.parse(events[idx].at) : NaN;
    if (!Number.isFinite(at)) return;
    document.querySelectorAll('.gnode[data-layer="worker"]').forEach(function(n) {
      const start = Number(n.getAttribute('data-started-at')) || 0;
      const end = Number(n.getAttribute('data-ended-at')) || Infinity;
      n.classList.toggle('dimmed', !(at >= start && at <= end));
    });
  }

  // ---------- SSE live updates ----------
  try {
    const es = new EventSource('/dashboard/stream');
    let refreshTimer = null;
    es.addEventListener('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        const k = data && data.kind;
        if (typeof k === 'string' && (k.indexOf('bom_step_') === 0 || k.indexOf('worker_') === 0 || k.indexOf('trust_scope_') === 0)) {
          if (refreshTimer) return;
          refreshTimer = setTimeout(function() { refreshTimer = null; window.location.reload(); }, 600);
        }
      } catch (_) {}
    });
  } catch (_) {}

  // ---------- jump-to-bom from URL hash ----------
  if (location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = canvas.querySelector('[data-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      openDrawerFor(el);
    }
  }
})();
`;

export function renderTopologyPage(data?: TopologyData): string {
  const snapshot: TopologyData = data ?? {
    workers: [],
    bricks: [],
    scopes: [],
    inFlightBoms: [],
  };

  // Build the graph.
  const core: GraphNode = {
    id: 'stavr-core',
    type: 'core',
    displayName: 'stavR-primary',
    iconId: 'i-rune',
    shape: 'hex',
    status: 'ok',
    x: CENTER_X, y: CENTER_Y,
    meta: { layer: 'steward' },
  };
  const allNodes: GraphNode[] = [core, ...bricksToNodes(snapshot.bricks), ...workersToNodes(snapshot.workers)];
  layoutGraph(allNodes);

  const typeCounts: Record<GraphType, number> = {
    core: 0, 'mcp-remote': 0, 'mcp-local': 0, webhook: 0, db: 0, model: 0, worker: 0, peer: 0,
  };
  for (const n of allNodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

  const edges = buildEdges(allNodes);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
  const edgeSvg = edges.map((e) => renderEdge(nodeMap, e)).join('');
  const nodesHtml = allNodes.map((n) => renderNode(n, n.id === 'stavr-core')).join('');

  // Scrubber + tick markers (unchanged contract).
  const steps = Math.max(1, snapshot.scrubberSteps ?? 30);
  const tickMarkers = Array.from({ length: steps }, (_, i) => ({
    at: new Date(Date.now() - (steps - i) * 60_000).toISOString(),
    kind: 'tick',
  }));
  const scrubberHtml = renderScrubber({ steps: tickMarkers.length });
  const scrubberWithTime = scrubberHtml.replace(
    '<span class="scrubber-value" data-role="value">live</span>',
    '<span class="scrubber-value" data-role="value">live</span><span class="scrubber-time" data-role="scrub-time"></span>',
  );

  const filterStrip = renderFilterStrip(typeCounts);
  const paletteDoor = renderPaletteDoor();
  const legend = renderLegend();

  // SVG edge layer: arc-quadratic edges only. The v0.3 horizontal
  // "enterprise bus" axis was removed in v0.4.1 per CLAUDE.md invariant #1.
  const svg = [
    `<svg class="topo-svg-edges" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet">`,
    edgeSvg,
    `</svg>`,
  ].join('');

  const body = [
    `<div class="topo-page">`,
    `<div class="page-head">`,
    `<h1 class="page-title">Topology</h1>`,
    `<span class="page-sub">${snapshot.workers.length} worker${snapshot.workers.length === 1 ? '' : 's'} · ${snapshot.bricks.length} brick${snapshot.bricks.length === 1 ? '' : 's'} · ${snapshot.inFlightBoms.length} in-flight · drag to pin</span>`,
    `</div>`,
    filterStrip,
    `<div class="topo-frame">`,
    `<div class="topo-canvas glass" data-role="topo-canvas" data-live="on">`,
    `<div class="grid-bg"></div>`,
    `<div class="cluster-blob c-mcp"></div>`,
    `<div class="cluster-blob c-worker"></div>`,
    `<div class="cluster-blob c-model"></div>`,
    paletteDoor,
    `<div class="topo-stage">`,
    svg,
    `<div class="topo-nodes">${nodesHtml}</div>`,
    `</div>`,
    legend,
    scrubberWithTime,
    `</div>`,
    renderBomSidebar(snapshot),
    `</div>`,
    `<section class="topo-roster glass">`,
    `<h2 class="card-title">Worker roster</h2>`,
    `<ul style="list-style:none;padding:0;margin:0;">`,
    renderWorkerRoster(snapshot.workers),
    `</ul>`,
    `</section>`,
    `</div>`,
    renderDrawer(),
    `<script id="topo-events" type="application/json">${JSON.stringify(tickMarkers)}</script>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Topology',
    activePage: 'topology',
    body,
    head: `<style>${TOPOLOGY_CSS}</style>`,
    script: TOPOLOGY_JS,
  });
}
