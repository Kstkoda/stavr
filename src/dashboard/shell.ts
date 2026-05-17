/**
 * Dashboard shell — top rail + page slot. Server-rendered HTML; the per-
 * page module supplies the body string.
 *
 * Architecture: each `/dashboard/<page>` route renders the same shell with
 * a different body and `activePage` highlighted. Hash-routing is
 * intentionally NOT used — server-side routing keeps the dashboard
 * deep-linkable, copyable, and crawl-friendly without a build step.
 *
 * v0.4.1 polish: top rail is the canonical v2 mockup — rune badge + stav+ᚱ
 * wordmark, glass nav, status pills (daemon uptime / steward model / GST
 * clock), and the WATCH OK chip (renderWatchdogPip — same component, new
 * label). The legacy `class="topnav"` is preserved because tests + the
 * watchdog-pip mount contract depend on it.
 */

import { TOKENS_CSS } from './tokens.js';
import { FOOD_LABEL_CSS } from './components/food-label.js';
import { BRICK_CSS } from './components/brick.js';
import { INSPECTOR_CSS, INSPECTOR_JS, renderInspectorPanel } from './components/inspector.js';
import { PILL_CSS } from './components/pill.js';
import { SCRUBBER_CSS } from './components/scrubber.js';
import {
  FLOATING_INSPECTOR_CSS,
  FLOATING_INSPECTOR_JS,
  renderFloatingInspectorShell,
} from './components/floating-inspector.js';
import { TIMELINE_CSS, TIMELINE_JS, renderTimeline } from './components/timeline.js';
import {
  WATCHDOG_PIP_CSS,
  WATCHDOG_PIP_JS,
  renderWatchdogPip,
} from './components/watchdog-pip.js';
import {
  CAPTURE_BUTTON_CSS,
  CAPTURE_BUTTON_JS,
  renderCaptureButton,
} from './components/capture-button.js';
import { ICON_SPRITE_SVG } from './components/icon-sprite.js';

export type DashboardPageId =
  | 'helm'
  | 'home'
  | 'topology'
  | 'streams'
  | 'plans'
  | 'decide'
  | 'toolkit'
  | 'mcps'
  | 'tools'
  | 'permissions'
  | 'capabilities'
  | 'diagnostics'
  | 'settings';

export interface NavEntry {
  id: DashboardPageId;
  label: string;
  href: string;
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'helm',         label: 'Helm',         href: '/dashboard/helm' },
  { id: 'topology',     label: 'Topology',     href: '/dashboard/topology' },
  { id: 'streams',      label: 'Streams',      href: '/dashboard/streams' },
  { id: 'plans',        label: 'Plans',        href: '/dashboard/plans' },
  { id: 'decide',       label: 'Decide',       href: '/dashboard/decide' },
  { id: 'toolkit',      label: 'Toolkit',      href: '/dashboard/toolkit' },
  { id: 'mcps',         label: 'MCPs',         href: '/dashboard/mcps' },
  { id: 'tools',        label: 'Tools',        href: '/dashboard/tools' },
  { id: 'permissions',  label: 'Permissions',  href: '/dashboard/permissions' },
  { id: 'capabilities', label: 'Capabilities', href: '/dashboard/capabilities' },
  { id: 'diagnostics',  label: 'Diagnostics',  href: '/dashboard/diagnostics' },
  { id: 'settings',     label: 'Settings',     href: '/dashboard/settings' },
];

/**
 * Pages that still have a route but are no longer surfaced in the primary
 * top nav. `home` is the v0.3 predecessor of `helm`; it stays alive as a
 * deep-linkable URL so existing bookmarks + integration tests keep working.
 */
export const LEGACY_NAV_ENTRIES: NavEntry[] = [
  { id: 'home', label: 'Home (legacy)', href: '/dashboard/home' },
];

export interface RenderShellInput {
  title: string;
  activePage: DashboardPageId;
  body: string;
  /** Extra <head> markup (page-specific styles). */
  head?: string;
  /** Inline page script, executed after DOM ready. */
  script?: string;
}

const BASE_CSS = `
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background:
    radial-gradient(1400px 900px at 18% -8%, #1a1326 0%, transparent 55%),
    radial-gradient(1100px 800px at 110% 110%, #0f1d22 0%, transparent 55%),
    var(--bg-0, var(--bg-base));
  color: var(--ink-0, var(--text-primary));
  font-family: var(--sans, ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: 13px;
  line-height: 1.5;
}
body {
  display: grid;
  grid-template-rows: 52px 1fr;
  min-height: 100vh;
}
a { color: inherit; text-decoration: none; }
button { font: inherit; }

/* === TOP RAIL === */
.topnav {
  display: grid;
  grid-template-columns: 250px 1fr auto;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  background: linear-gradient(180deg, rgba(15,16,24,.92), rgba(15,16,24,.65));
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  position: sticky; top: 0; z-index: 80;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.brand-mark {
  width: 22px; height: 22px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--rust), #6e2e15);
  border-radius: 6px;
  color: #ffe9dc;
  font-family: var(--mono);
  font-size: 13px; line-height: 1;
  box-shadow: 0 0 0 1px rgba(255,255,255,.06), 0 4px 14px var(--rust-glow);
  filter: drop-shadow(0 0 4px var(--rust-glow));
}
.brand .stav { color: var(--ink-0); font-weight: 700; }
.brand .rune-i {
  color: var(--rust);
  font-family: var(--mono);
  font-style: normal;
  filter: drop-shadow(0 0 6px var(--rust-glow));
  animation: rune-pulse 4s ease-in-out infinite;
}
.brand-sr { position: absolute; left: -9999px; }
@keyframes rune-pulse {
  0%,100% { filter: drop-shadow(0 0 4px var(--rust-glow)); }
  50%     { filter: drop-shadow(0 0 12px var(--rust-glow)); }
}

.nav-tabs {
  display: flex;
  gap: 4px;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
}
.nav-tab {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--ink-1);
  border: 1px solid transparent;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.nav-tab:hover {
  background: rgba(255,255,255,.04);
  color: var(--ink-0);
}
.nav-tab[aria-current="page"] {
  background: var(--rust-soft);
  color: #ffd9c4;
  border-color: rgba(184, 84, 42, 0.3);
}

.topnav-right {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-1);
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--line-2);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-1);
  letter-spacing: 0.04em;
}
.status-pill .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ink-3);
}
.status-pill .dot.ok   { background: var(--ok);   box-shadow: 0 0 6px var(--ok); }
.status-pill .dot.warn { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.status-pill .dot.crit { background: var(--crit); box-shadow: 0 0 6px var(--crit); }
.status-pill .dot.info { background: var(--info); }
.status-pill .clk { color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* Brand icon glyphs (from icon-sprite.ts) */
svg.icon {
  width: 16px; height: 16px;
  color: currentColor; fill: currentColor;
  display: inline-block; vertical-align: middle;
}
svg.icon-lg { width: 22px; height: 22px; }

/* === PAGE === */
.page {
  padding: 18px 22px 60px;
  overflow: auto;
}
.page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 16px;
}
.page-title {
  font-size: 22px;
  font-weight: 450;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--ink-0);
}
.page-sub { color: var(--ink-2); font-size: 12px; }

.card {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
  backdrop-filter: blur(var(--glass-blur)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(140%);
}
.card-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: 0 0 12px 0;
  font-family: var(--mono);
}

.placeholder {
  background: var(--bg-glass);
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  padding: 40px;
  text-align: center;
  color: var(--ink-2);
  backdrop-filter: blur(var(--glass-blur)) saturate(140%);
}
.placeholder strong {
  display: block;
  margin-bottom: 6px;
  color: var(--ink-0);
  font-size: 16px;
}

/* Skeleton loaders */
.skeleton {
  background: linear-gradient(90deg,
    var(--bg-glass) 0%,
    var(--bg-glass-2) 50%,
    var(--bg-glass) 100%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s linear infinite;
  border-radius: 4px;
  min-height: 14px;
}
.skeleton-line { height: 14px; margin: 6px 0; }
.skeleton-card { height: 80px; }
@keyframes skeleton-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Connection banner — surfaces SSE drops */
.conn-banner {
  position: fixed;
  bottom: 18px;
  right: 18px;
  background: var(--bg-popover);
  border: 1px solid var(--line-2);
  border-left: 3px solid var(--warn);
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--ink-0);
  box-shadow: 0 4px 16px rgba(0,0,0,0.55);
  z-index: 70;
  display: none;
  align-items: center;
  gap: 10px;
  backdrop-filter: blur(20px);
}
.conn-banner[data-state="dropped"]      { display: flex; border-left-color: var(--crit); }
.conn-banner[data-state="reconnecting"] { display: flex; border-left-color: var(--warn); }
.conn-banner[data-state="ok"]           {
  display: flex; border-left-color: var(--ok);
  animation: conn-fadeout 2s 1s forwards;
}
@keyframes conn-fadeout { to { opacity: 0; display: none; } }
.conn-banner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.conn-banner[data-state="dropped"] .conn-banner-dot { background: var(--crit); }
.conn-banner[data-state="ok"]      .conn-banner-dot { background: var(--ok); }
`;

/**
 * Shell-level connection banner that any page can drive without re-
 * implementing the SSE plumbing. Pages set:
 *   window.__stavrConn.set('dropped' | 'reconnecting' | 'ok', detail?)
 * The banner shows in the bottom-right, colour-coded by state.
 */
const SHELL_CONN_JS = `
(function() {
  const banner = document.querySelector('[data-role="conn-banner"]');
  if (!banner) return;
  const msg = banner.querySelector('[data-role="conn-banner-msg"]');
  window.__stavrConn = {
    set: function(state, detail) {
      banner.setAttribute('data-state', state);
      if (msg) {
        if (state === 'dropped') msg.textContent = 'Live updates disconnected — retrying…';
        else if (state === 'reconnecting') msg.textContent = 'Reconnecting…';
        else if (state === 'ok') msg.textContent = detail || 'Live updates restored.';
      }
    },
    clear: function() { banner.removeAttribute('data-state'); },
  };
})();
`;

/**
 * Top-rail clock — updates the GST time pill once per second. The clock
 * needs no daemon round-trip; it just renders the operator's wall time.
 */
const SHELL_CLOCK_JS = `
(function() {
  const el = document.querySelector('[data-role="topnav-clock"]');
  if (!el) return;
  function pad(n) { return String(n).padStart(2, '0'); }
  function tick() {
    const d = new Date();
    el.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' GST';
  }
  tick();
  setInterval(tick, 1000);
})();
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNav(active: DashboardPageId): string {
  return NAV_ENTRIES.map((e) => {
    const cur = e.id === active ? ' aria-current="page"' : '';
    return `<a class="nav-tab" href="${e.href}" data-page="${e.id}"${cur}>${escapeHtml(e.label)}</a>`;
  }).join('');
}

function renderBrand(): string {
  // Visible: rust rune badge + `stav` + Raido rune `ᚱ`.
  // SR-only `STAVR` keeps screen-readers + the long-standing shell test happy.
  return [
    `<div class="brand">`,
    `<span class="brand-mark" aria-hidden="true">ᚱ</span>`,
    `<span class="word"><span class="stav">stav</span><i class="rune-i">ᚱ</i></span>`,
    `<span class="brand-sr">STAVR</span>`,
    `</div>`,
  ].join('');
}

function renderTopRailRight(): string {
  // Status pills are visual stubs — real uptime/steward/etc come from the
  // watchdog-pip and a follow-up panel (ADR-033). Keep the markup so the
  // shell matches the v2 mockup; pages can update text via DOM later.
  return [
    `<div class="topnav-right">`,
    `<span class="status-pill" data-role="pill-daemon"><span class="dot ok"></span> daemon</span>`,
    `<span class="status-pill" data-role="pill-steward"><span class="dot info"></span> steward · opus-4.7</span>`,
    `<span class="status-pill"><span class="clk" data-role="topnav-clock">…</span></span>`,
    renderWatchdogPip(),
    `</div>`,
  ].join('');
}

export function renderShell(input: RenderShellInput): string {
  const css = [
    TOKENS_CSS,
    BASE_CSS,
    FOOD_LABEL_CSS,
    BRICK_CSS,
    INSPECTOR_CSS,
    PILL_CSS,
    SCRUBBER_CSS,
    FLOATING_INSPECTOR_CSS,
    TIMELINE_CSS,
    WATCHDOG_PIP_CSS,
    CAPTURE_BUTTON_CSS,
  ].join('\n');

  const script = input.script ? `<script>${input.script}</script>` : '';

  return [
    `<!doctype html>`,
    `<html lang="en" class="dark">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<style>${css}</style>`,
    input.head ?? '',
    `</head>`,
    `<body data-active-page="${input.activePage}">`,
    ICON_SPRITE_SVG,
    `<header class="topnav" role="navigation" aria-label="Primary">`,
    renderBrand(),
    `<nav class="nav-tabs">${renderNav(input.activePage)}</nav>`,
    renderTopRailRight(),
    `</header>`,
    `<main class="page" role="main">${input.body}</main>`,
    renderInspectorPanel(),
    renderFloatingInspectorShell(),
    renderCaptureButton(),
    renderTimeline(),
    `<div class="conn-banner" data-role="conn-banner" role="status" aria-live="polite">`,
    `<span class="conn-banner-dot" aria-hidden="true"></span>`,
    `<span data-role="conn-banner-msg">Live updates connected.</span>`,
    `</div>`,
    `<script>${INSPECTOR_JS}</script>`,
    `<script>${SHELL_CONN_JS}</script>`,
    `<script>${SHELL_CLOCK_JS}</script>`,
    `<script>${FLOATING_INSPECTOR_JS}</script>`,
    `<script>${TIMELINE_JS}</script>`,
    `<script>${WATCHDOG_PIP_JS}</script>`,
    `<script>${CAPTURE_BUTTON_JS}</script>`,
    script,
    `</body>`,
    `</html>`,
  ].join('\n');
}
