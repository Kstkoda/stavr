/**
 * Topology page — SVG ops control center.
 *
 * Layout: steward in centre (red circle), bricks above the bus
 * (external — purple/blue/orange), workers below (green/yellow/red by
 * status). No connecting lines.
 *
 * Click any node → inspector slides in with its live status + actions.
 * Bottom: time scrubber rolls the scene back through history.
 * Right: in-flight BOM list grouped by trust scope.
 */
import type { WorkerRecord } from '../../persistence.js';
import type { Bom } from '../../types/stavr-bom.js';
import { renderShell } from '../shell.js';
import { renderBrick } from '../components/brick.js';
import { renderScrubber } from '../components/scrubber.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import { renderFoodLabel } from '../components/food-label.js';
import { bomToFoodLabel } from '../adapters/bom.js';
import {
  computeTopology,
  type InstalledBrickLite,
  type TopologyNode,
} from '../adapters/topology.js';

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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WORKER_STATUS_PILL: Record<string, PillVariant> = {
  idle:     'success',
  running:  'info',
  starting: 'info',
  crashed:  'danger',
  terminated: 'neutral',
};

function renderNode(node: TopologyNode): string {
  const brickSvg = renderBrick({
    id: node.id,
    kind: node.brickKind,
    displayName: node.displayName.length > 14 ? node.displayName.slice(0, 13) + '…' : node.displayName,
    position: node.position,
    status: node.status,
  });
  return [
    `<g class="topo-node" data-id="${escapeHtml(node.id)}"`,
    ` data-layer="${node.layer}" data-position="${node.position}"`,
    ` transform="translate(${node.x}, ${node.y})">`,
    brickSvg,
    `</g>`,
  ].join('');
}

function renderStewardNode(steward: { x: number; y: number; r: number }): string {
  // v8: rust disc with rune at the centre + concentric pulse rings, dashed
  // inner ring for the Steward + Watchdog (Watchdog is an external supervisor
  // and gets a dashed border to signal "lives outside the daemon").
  const r = steward.r;
  return [
    `<g class="topo-steward" transform="translate(${steward.x}, ${steward.y})"`,
    ` data-layer="steward" data-id="steward" role="button" tabindex="0"`,
    ` aria-label="stavR daemon">`,
    `<circle class="topo-daemon-pulse" r="${r + 14}" />`,
    `<circle class="topo-daemon-pulse-2" r="${r + 8}" />`,
    `<circle class="topo-daemon-ring-inner" r="${r + 4}" />`,
    `<circle r="${r}" class="topo-daemon-disc" />`,
    `<text class="topo-daemon-rune" text-anchor="middle" dy="6" font-size="18" font-weight="800">ᛋ</text>`,
    `<text class="topo-daemon-label" text-anchor="middle" dy="${r + 18}" font-size="10" letter-spacing="0.12em">STAVR DAEMON</text>`,
    `</g>`,
  ].join('');
}

function renderModeChips(): string {
  // Bottom-of-canvas mode switcher per v8. RADIAL is the only mode in v0.4;
  // HEAT + HISTORY are placeholders for v0.5+ that visually preview what's
  // coming but are inert.
  return [
    `<div class="topo-mode-chips" role="tablist" aria-label="Topology mode">`,
    `<button type="button" class="tm-chip" data-mode="radial" aria-pressed="true">RADIAL</button>`,
    `<button type="button" class="tm-chip" data-mode="heat"    aria-pressed="false" disabled title="v0.5">HEAT</button>`,
    `<button type="button" class="tm-chip" data-mode="history" aria-pressed="false" disabled title="v0.5">HISTORY</button>`,
    `</div>`,
  ].join('');
}

function renderBomSidebar(data: TopologyData): string {
  if (data.inFlightBoms.length === 0) {
    return [
      `<aside class="topo-side">`,
      `<h2 class="card-title">In-flight BOMs</h2>`,
      `<div class="placeholder">Nothing running.</div>`,
      `</aside>`,
    ].join('');
  }
  // Group BOMs by scope_id (or "_unscoped" if none).
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
    `<aside class="topo-side">`,
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

const TOPOLOGY_CSS = `
.topo-frame {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 18px;
  align-items: stretch;
}
@media (max-width: 1100px) {
  .topo-frame { grid-template-columns: 1fr; }
}
.topo-canvas {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  position: relative;
}
.topo-svg {
  width: 100%;
  height: auto;
  display: block;
  user-select: none;
}
.topo-node { cursor: pointer; transition: transform 0.2s ease; }
.topo-node:hover { transform: translate(var(--x), var(--y)) scale(1.04); }
.topo-node.dimmed { opacity: 0.25; }
.topo-bus {
  stroke: var(--accent-steward);
  stroke-width: 4;
  stroke-linecap: round;
  opacity: 0.6;
}
.topo-bus-label {
  fill: var(--accent-steward);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.topo-side {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  overflow-y: auto;
  max-height: 70vh;
}
.scope-group + .scope-group { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.scope-h {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
}
.scope-id { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--text-dim); }
.scope-boms { display: flex; flex-direction: column; gap: 6px; }
.scope-boms .food-label { font-size: 11px; }

.topo-roster {
  margin-top: 14px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.topo-roster h2 { margin-bottom: 6px; }
.roster-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.roster-name { color: var(--text-primary); }
.roster-type { color: var(--text-dim); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }

.scrubber-time {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}

.placeholder { color: var(--text-dim); font-style: italic; font-size: 12px; padding: 8px 0; }

/* v8 — daemon disc */
.topo-daemon-disc {
  fill: var(--rust);
  stroke: #3a0a0a;
  stroke-width: 2;
  filter: drop-shadow(0 0 8px var(--rust-glow));
}
.topo-daemon-rune  { fill: #fff8f0; }
.topo-daemon-label { fill: var(--rust-soft); font-family: ui-monospace, Menlo, Consolas, monospace; }
.topo-daemon-ring-inner {
  fill: none;
  stroke: var(--rust);
  stroke-width: 1;
  stroke-dasharray: 4 6;
  opacity: 0.5;
}
.topo-daemon-pulse,
.topo-daemon-pulse-2 {
  fill: none;
  stroke: var(--rust);
  stroke-width: 1;
  opacity: 0.0;
  transform-origin: center;
  animation: topo-pulse 2.4s ease-out infinite;
}
.topo-daemon-pulse-2 { animation-delay: 1.2s; }
@keyframes topo-pulse {
  0%   { opacity: 0.45; transform: scale(0.8); }
  100% { opacity: 0;    transform: scale(1.6); }
}

/* v8 — mode chips */
.topo-mode-chips {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
}
.tm-chip {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 10px;
  letter-spacing: 0.12em;
  cursor: pointer;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.tm-chip[aria-pressed="true"] {
  border-color: var(--rust);
  color: var(--rust-soft);
  background: var(--bg-surface);
}
.tm-chip:disabled { opacity: 0.4; cursor: not-allowed; }
`;

const TOPOLOGY_JS = `
(function() {
  const canvas = document.querySelector('[data-role="topo-canvas"]');
  if (!canvas) return;
  const events = parseEvents();

  function parseEvents() {
    const node = document.getElementById('topo-events');
    if (!node) return [];
    try { return JSON.parse(node.textContent || '[]'); }
    catch (_) { return []; }
  }

  // ---------- node click → inspector ----------
  canvas.addEventListener('click', function(ev) {
    const node = ev.target.closest('[data-id]');
    if (!node) return;
    const id = node.getAttribute('data-id');
    const layer = node.getAttribute('data-layer') || 'brick';
    openInspectorFor(id, layer);
  });

  async function openInspectorFor(id, layer) {
    if (typeof window.openInspector !== 'function') return;
    if (layer === 'steward') {
      window.openInspector('Steward', '<p>Stavr daemon — the bus.</p>'
        + '<p style="color:var(--text-dim);font-size:12px;">Coordinates BOMs, owns trust scopes, runs the no-go list.</p>', '');
      return;
    }
    if (layer === 'worker') {
      window.openInspector('Worker · ' + id, '<div class="placeholder">Loading…</div>', '');
      try {
        const r = await fetch('/dashboard/workers/' + encodeURIComponent(id));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const w = data.worker;
        const recent = (data.events || []).slice(0, 8).map(function(e) {
          return '<li><span style="color:var(--accent-mcp);font-family:monospace;">' + e.kind + '</span></li>';
        }).join('');
        const body = '<dl class="kv">'
          + '<div class="kv-row"><dt>Name</dt><dd>' + esc(w.name) + '</dd></div>'
          + '<div class="kv-row"><dt>Type</dt><dd>' + esc(w.type) + '</dd></div>'
          + '<div class="kv-row"><dt>Status</dt><dd>' + esc(w.status) + '</dd></div>'
          + '<div class="kv-row"><dt>Started</dt><dd>' + esc(w.started_at) + '</dd></div>'
          + (w.cwd ? '<div class="kv-row"><dt>cwd</dt><dd style="word-break:break-all;">' + esc(w.cwd) + '</dd></div>' : '')
          + '</dl>'
          + (recent ? '<h3 class="card-title" style="margin-top:14px;">Recent events</h3><ul style="list-style:none;padding:0;margin:0;">' + recent + '</ul>' : '');
        window.openInspector('Worker · ' + esc(w.name), body, '');
      } catch (err) {
        window.openInspector('Worker · ' + id, '<p>Failed to load: ' + esc(String(err)) + '</p>', '');
      }
      return;
    }
    // Brick
    window.openInspector('Brick · ' + id, '<div class="placeholder">Brick inspector (full editor in C7).</div>'
      + '<p style="color:var(--text-dim);font-size:12px;">Click through to Toolkit to configure.</p>',
      '<a href="/dashboard/toolkit#' + encodeURIComponent(id) + '" class="btn">Open in Toolkit</a>');
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
      // Snap back to live on release.
      scrubber.value = events.length;
      if (scrubVal) scrubVal.textContent = 'live';
      if (scrubTime) scrubTime.textContent = '';
      applySnapshot(events.length);
    });
  }
  function applySnapshot(idx) {
    if (idx >= events.length) {
      document.querySelectorAll('.topo-node').forEach(function(n) { n.classList.remove('dimmed'); });
      return;
    }
    const at = events[idx] ? Date.parse(events[idx].at) : NaN;
    if (!Number.isFinite(at)) return;
    document.querySelectorAll('.topo-node[data-layer="worker"]').forEach(function(n) {
      const start = Number(n.getAttribute('data-started-at')) || 0;
      const end = Number(n.getAttribute('data-ended-at')) || Infinity;
      const present = at >= start && at <= end;
      n.classList.toggle('dimmed', !present);
    });
  }

  // ---------- live updates ----------
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
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* fall through */ }

  // ---------- jump-to-bom from URL hash ----------
  if (location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = canvas.querySelector('[data-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('topo-highlight');
      setTimeout(function() { if (typeof window.openInspector === 'function') openInspectorFor(id, el.getAttribute('data-layer') || 'brick'); }, 200);
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
  const layout = computeTopology({ workers: snapshot.workers, bricks: snapshot.bricks });
  const nodes = layout.nodes.map(renderNode).join('');
  const stewardNode = renderStewardNode(layout.steward);

  // Annotate worker nodes with started/ended-at epochs so the scrubber
  // can dim workers that weren't present at the scrubbed-to moment.
  const workerMetaById = new Map<string, { start: number; end: number }>();
  for (const w of snapshot.workers) {
    const start = Date.parse(w.started_at) || 0;
    const end = w.ended_at ? Date.parse(w.ended_at) : Number.POSITIVE_INFINITY;
    workerMetaById.set(w.id, { start, end });
  }
  const enriched = nodes.replace(
    /<g class="topo-node" data-id="([^"]+)" data-layer="worker"/g,
    (_full, id: string) => {
      const meta = workerMetaById.get(id);
      if (!meta) return _full;
      return `<g class="topo-node" data-layer="worker" data-id="${id}" data-started-at="${meta.start}" data-ended-at="${Number.isFinite(meta.end) ? meta.end : ''}"`;
    },
  );

  // Tick markers for the scrubber. Defaults to ~30 one-minute steps so
  // users get something to drag even on a fresh daemon. Real event
  // markers can be threaded in by the caller via scrubberSteps + a
  // future events list (C10 polish).
  const steps = Math.max(1, snapshot.scrubberSteps ?? 30);
  const tickMarkers = Array.from({ length: steps }, (_, i) => ({
    at: new Date(Date.now() - (steps - i) * 60_000).toISOString(),
    kind: 'tick',
  }));

  const svg = [
    `<svg class="topo-svg" viewBox="0 0 ${layout.width} ${layout.height}"`,
    ` preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"`,
    ` role="img" aria-label="Topology of bricks and workers">`,
    `<line class="topo-bus" x1="20" y1="${layout.steward.y}" x2="${layout.width - 20}" y2="${layout.steward.y}" />`,
    `<text class="topo-bus-label" x="${layout.width - 20}" y="${layout.steward.y - 6}" text-anchor="end">enterprise bus</text>`,
    enriched,
    stewardNode,
    `</svg>`,
  ].join('');

  const scrubberHtml = renderScrubber({ steps: tickMarkers.length });
  // The renderScrubber above sets value=max (live). Append a small time tag.
  const scrubberWithTime = scrubberHtml.replace(
    '<span class="scrubber-value" data-role="value">live</span>',
    '<span class="scrubber-value" data-role="value">live</span><span class="scrubber-time" data-role="scrub-time"></span>',
  );

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Topology</h1>`,
    `<span class="page-sub">${snapshot.workers.length} worker${snapshot.workers.length === 1 ? '' : 's'} · ${snapshot.bricks.length} brick${snapshot.bricks.length === 1 ? '' : 's'} · ${snapshot.inFlightBoms.length} in-flight</span>`,
    `</div>`,
    `<div class="topo-frame">`,
    `<div class="topo-canvas" data-role="topo-canvas">`,
    svg,
    renderModeChips(),
    scrubberWithTime,
    `</div>`,
    renderBomSidebar(snapshot),
    `</div>`,
    `<section class="topo-roster">`,
    `<h2 class="card-title">Worker roster</h2>`,
    `<ul style="list-style:none;padding:0;margin:0;">`,
    renderWorkerRoster(snapshot.workers),
    `</ul>`,
    `</section>`,
    // Hidden JSON for the scrubber.
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

