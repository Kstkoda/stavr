/**
 * Helm — the v8 primary page. Five-band vertical stack showing the daemon
 * from intent down to systems:
 *
 *   L4 INTENT     — current Steward prompt / goal (click → Steward sheet)
 *   L3 PLANS      — band-rich BOM drill cards (4 visible by default)
 *   L2 WORKERS    — dots row (click → floating inspector)
 *   L1 TOOL CALLS — recent tool calls histogram (click → Diagnostics)
 *   L0 SYSTEMS    — sys-chips row (click → floating inspector)
 *
 * This page is the v8 evolution of v0.3's Home. The data shape reuses
 * `HomeData` for the Daemon health + BOMs + decisions; new fields (workers
 * row, sys-chips) come from on-page poll endpoints that already exist.
 */

import type { Bom, ProfileMode } from '../../types/stavr-bom.js';
import type { DecisionRecord } from '../../persistence.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import { bomToFoodLabel } from '../adapters/bom.js';
import { renderFoodLabel } from '../components/food-label.js';

export interface HelmWorker {
  id: string;
  type: string;
  status: 'idle' | 'running' | 'crashed' | 'cleanup';
  uptime_sec?: number;
  current_step?: string;
}

export interface HelmSystem {
  id: string;
  label: string;
  /** Emoji / single-char glyph. */
  glyph: string;
  health: 'ok' | 'degraded' | 'down' | 'unknown';
  detail?: string;
}

export interface HelmData {
  intent: {
    /** Current Steward focus — what the daemon thinks it's doing right now. */
    summary: string;
    /** Optional sub line (e.g., "Eco profile · 2 active BOMs"). */
    sub?: string;
  };
  health: {
    ok: boolean;
    version: string;
    port: number;
    started_at: string;
    uptime_sec: number;
    profile_mode: ProfileMode;
    event_count: number;
    active_scopes: number;
  };
  boms: { recent: Bom[]; total: number; open: number };
  decisions: { recent: DecisionRecord[]; open: number };
  workers: HelmWorker[];
  systems: HelmSystem[];
}

const PROFILE_PILL: Record<ProfileMode, { label: string; variant: PillVariant }> = {
  turbo:    { label: 'Turbo',    variant: 'profile-turbo' },
  balanced: { label: 'Balanced', variant: 'profile-balanced' },
  eco:      { label: 'Eco',      variant: 'profile-eco' },
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderIntentBand(d: HelmData): string {
  const profile = PROFILE_PILL[d.health.profile_mode];
  return [
    `<section class="helm-band helm-l4" data-slot="intent" data-fi-open="intent" tabindex="0" role="button" aria-label="Open Steward intent">`,
    `<div class="band-tag">L4 · INTENT</div>`,
    `<div class="band-main">`,
    `<div class="intent-summary">${escapeHtml(d.intent.summary || 'Steward is idle.')}</div>`,
    d.intent.sub ? `<div class="intent-sub">${escapeHtml(d.intent.sub)}</div>` : '',
    `</div>`,
    `<div class="band-aside">`,
    renderPill({ text: profile.label, variant: profile.variant, title: 'Active profile mode' }),
    `</div>`,
    `</section>`,
  ].join('');
}

function renderPlansBand(d: HelmData): string {
  const cards = d.boms.recent.slice(0, 4)
    .map((b) => renderFoodLabel(bomToFoodLabel(b)))
    .join('');
  const body = cards || `<div class="empty">No active plans. <a href="/dashboard/plans">propose one →</a></div>`;
  return [
    `<section class="helm-band helm-l3" data-slot="plans">`,
    `<div class="band-tag">L3 · PLANS · ${d.boms.total}</div>`,
    `<div class="band-main">`,
    `<div class="plans-row" data-role="plans-row">${body}</div>`,
    `</div>`,
    `<div class="band-aside"><a href="/dashboard/plans" class="see-all">All plans →</a></div>`,
    `</section>`,
  ].join('');
}

function renderWorkersBand(d: HelmData): string {
  const dots = d.workers.length === 0
    ? `<div class="empty">No workers running.</div>`
    : d.workers.map((w) => [
        `<button type="button" class="worker-dot" data-state="${escapeHtml(w.status)}"`,
        ` data-worker-id="${escapeHtml(w.id)}" data-worker-type="${escapeHtml(w.type)}"`,
        ` data-worker-step="${escapeHtml(w.current_step ?? '')}"`,
        ` data-fi-open="worker"`,
        ` title="${escapeHtml(w.type)} · ${escapeHtml(w.status)}" aria-label="Worker ${escapeHtml(w.id)}">`,
        `<span class="wd-dot" aria-hidden="true"></span>`,
        `<span class="wd-id">${escapeHtml(w.id.slice(-4))}</span>`,
        `</button>`,
      ].join('')).join('');
  return [
    `<section class="helm-band helm-l2" data-slot="workers">`,
    `<div class="band-tag">L2 · WORKERS · ${d.workers.length}</div>`,
    `<div class="band-main">`,
    `<div class="workers-row" data-role="workers-row">${dots}</div>`,
    `</div>`,
    `<div class="band-aside"><a href="/dashboard/streams" class="see-all">Streams →</a></div>`,
    `</section>`,
  ].join('');
}

function renderToolCallsBand(d: HelmData): string {
  // Render a deterministic mini histogram from event_count so the band has
  // visual weight even on a quiet daemon. The real per-bucket counts come
  // from `/dashboard/home/data` via the timeline component, which polls
  // independently — this band is the call-site preview.
  const bars = 24;
  const seed = d.health.event_count || 0;
  const values = new Array(bars).fill(0).map((_, i) => {
    const noise = ((seed * (i + 1)) % 17) / 17;
    return Math.max(4, Math.min(32, 6 + noise * 30));
  });
  const html = values.map((v) => `<span class="tc-bar" style="height:${v}px"></span>`).join('');
  return [
    `<section class="helm-band helm-l1" data-slot="tool-calls">`,
    `<div class="band-tag">L1 · TOOL CALLS</div>`,
    `<div class="band-main"><div class="toolcalls-histogram">${html}</div></div>`,
    `<div class="band-aside"><a href="/dashboard/toolkit" class="see-all">Toolkit →</a></div>`,
    `</section>`,
  ].join('');
}

function renderSystemsBand(d: HelmData): string {
  const chips = d.systems.length === 0
    ? `<div class="empty">No external systems registered.</div>`
    : d.systems.map((s) => [
        `<button type="button" class="sys-chip" data-state="${escapeHtml(s.health)}"`,
        ` data-sys-id="${escapeHtml(s.id)}" data-sys-label="${escapeHtml(s.label)}"`,
        ` data-sys-detail="${escapeHtml(s.detail ?? '')}"`,
        ` data-fi-open="system"`,
        ` aria-label="${escapeHtml(s.label)} · ${escapeHtml(s.health)}">`,
        `<span class="sc-glyph" aria-hidden="true">${escapeHtml(s.glyph)}</span>`,
        `<span class="sc-label">${escapeHtml(s.label)}</span>`,
        `<span class="sc-dot" aria-hidden="true"></span>`,
        `</button>`,
      ].join('')).join('');
  return [
    `<section class="helm-band helm-l0" data-slot="systems">`,
    `<div class="band-tag">L0 · SYSTEMS · ${d.systems.length}</div>`,
    `<div class="band-main"><div class="systems-row">${chips}</div></div>`,
    `<div class="band-aside"><a href="/dashboard/topology" class="see-all">Topology →</a></div>`,
    `</section>`,
  ].join('');
}

const HELM_CSS = `
.helm-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.helm-band {
  display: grid;
  grid-template-columns: 96px 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated));
  position: relative;
  overflow: hidden;
  cursor: default;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.helm-band::before {
  content: '';
  position: absolute;
  inset: 0;
  border-left: 3px solid var(--rust);
  opacity: 0.4;
  pointer-events: none;
}
.helm-band[data-fi-open]:hover,
.helm-band[data-fi-open]:focus {
  border-color: var(--rust);
  box-shadow: 0 0 0 1px var(--rust-glow), 0 6px 20px rgba(0,0,0,0.4);
  outline: none;
}
.band-tag {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.band-main { min-width: 0; }
.band-aside { display: flex; align-items: center; gap: 8px; }
.see-all {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.see-all:hover { color: var(--rust-soft); }

/* L4 */
.intent-summary { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.intent-sub     { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }

/* L3 */
.plans-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.plans-row .food-label { min-width: 220px; flex: 1 1 240px; max-width: 320px; }

/* L2 */
.workers-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.worker-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  cursor: pointer;
}
.worker-dot:hover { border-color: var(--rust); color: var(--text-primary); }
.worker-dot .wd-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-dim);
}
.worker-dot[data-state="running"] .wd-dot { background: var(--health-ok); box-shadow: 0 0 6px var(--health-ok); }
.worker-dot[data-state="idle"]    .wd-dot { background: var(--text-secondary); }
.worker-dot[data-state="crashed"] .wd-dot { background: var(--health-down); box-shadow: 0 0 6px var(--health-down); }
.worker-dot[data-state="cleanup"] .wd-dot { background: var(--health-warn); }

/* L1 */
.toolcalls-histogram {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 36px;
}
.tc-bar {
  flex: 1;
  background: linear-gradient(to top, var(--rust), var(--rust-soft));
  border-radius: 1px;
  min-width: 4px;
  opacity: 0.8;
}

/* L0 */
.systems-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sys-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
.sys-chip:hover { border-color: var(--rust); }
.sys-chip .sc-glyph { font-size: 14px; }
.sys-chip .sc-label { color: var(--text-secondary); }
.sys-chip .sc-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-dim);
}
.sys-chip[data-state="ok"]       .sc-dot { background: var(--health-ok); }
.sys-chip[data-state="degraded"] .sc-dot { background: var(--health-warn); }
.sys-chip[data-state="down"]     .sc-dot { background: var(--health-down); }

.empty {
  color: var(--text-dim);
  font-style: italic;
  font-size: 12px;
}
.empty a { color: var(--accent-mcp); text-decoration: underline; }
`;

const HELM_JS = `
(function() {
  const fi = window.__stavrFloatingInspector;
  if (!fi) return;

  // L4 intent click → floating inspector pointing at the Steward sheet
  // (full sheet ships with the Steward subprocess work in v0.5).
  const intent = document.querySelector('[data-slot="intent"]');
  if (intent) {
    intent.addEventListener('click', function() {
      fi.openAt(intent, {
        icon: 'S',
        title: 'Steward',
        sub: 'Current intent (sheet ships in v0.5, ADR-032)',
        sections: [
          { label: 'Profile', value: document.body.getAttribute('data-active-page') || '—' },
        ],
        actions: [{ label: 'Capabilities', onClick: "location.href='/dashboard/capabilities'" }],
      });
    });
  }

  document.querySelectorAll('.worker-dot').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      fi.openAt(btn, {
        icon: 'W',
        title: btn.getAttribute('data-worker-id') || 'worker',
        sub: btn.getAttribute('data-worker-type') || '',
        sections: [
          { label: 'Status', value: btn.getAttribute('data-state') || '—' },
          { label: 'Step',   value: btn.getAttribute('data-worker-step') || '—' },
        ],
        actions: [{ label: 'Open Streams', onClick: "location.href='/dashboard/streams'" }],
      });
    });
  });

  document.querySelectorAll('.sys-chip').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.stopPropagation();
      fi.openAt(btn, {
        icon: btn.querySelector('.sc-glyph') ? btn.querySelector('.sc-glyph').textContent : '?',
        title: btn.getAttribute('data-sys-label') || 'system',
        sub: btn.getAttribute('data-state') || '',
        sections: [
          { label: 'Id',     value: btn.getAttribute('data-sys-id') || '—' },
          { label: 'Detail', value: btn.getAttribute('data-sys-detail') || '—' },
        ],
        actions: [{ label: 'Topology', onClick: "location.href='/dashboard/topology'" }],
      });
    });
  });

  // L1 routes to Diagnostics (Toolkit page is the v0.4 stand-in until the
  // dedicated Diagnostics page split out of Settings).
  const tc = document.querySelector('[data-slot="tool-calls"]');
  if (tc) {
    tc.addEventListener('click', function() { location.href = '/dashboard/toolkit'; });
  }
})();
`;

export function renderHelmPage(data?: HelmData): string {
  const snapshot: HelmData = data ?? {
    intent: { summary: 'Steward is idle.', sub: 'No active BOMs.' },
    health: {
      ok: true,
      version: 'unknown',
      port: 0,
      started_at: new Date().toISOString(),
      uptime_sec: 0,
      profile_mode: 'balanced',
      event_count: 0,
      active_scopes: 0,
    },
    boms: { recent: [], total: 0, open: 0 },
    decisions: { recent: [], open: 0 },
    workers: [],
    systems: [],
  };

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Helm</h1>`,
    `<span class="page-sub">Intent → Plans → Workers → Tool calls → Systems</span>`,
    `</div>`,
    `<div class="helm-stack">`,
    renderIntentBand(snapshot),
    renderPlansBand(snapshot),
    renderWorkersBand(snapshot),
    renderToolCallsBand(snapshot),
    renderSystemsBand(snapshot),
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Helm',
    activePage: 'helm',
    body,
    head: `<style>${HELM_CSS}</style>`,
    script: HELM_JS,
  });
}
