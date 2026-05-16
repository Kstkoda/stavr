/**
 * Dashboard shell — top nav + content slot. Server-rendered HTML; the
 * per-page module supplies the body string.
 *
 * Architecture: each `/dashboard/<page>` route renders the same shell
 * with a different body and `activePage` highlighted. Hash-routing is
 * intentionally NOT used — server-side routing keeps the dashboard
 * deep-linkable, copyable, and crawl-friendly without a build step.
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

export type DashboardPageId =
  | 'helm'
  | 'home'
  | 'topology'
  | 'streams'
  | 'plans'
  | 'decide'
  | 'toolkit'
  | 'mcps'
  | 'capabilities'
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
  { id: 'capabilities', label: 'Capabilities', href: '/dashboard/capabilities' },
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
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
}
body {
  display: grid;
  grid-template-rows: 56px 1fr;
  min-height: 100vh;
}
a { color: inherit; text-decoration: none; }
button { font: inherit; }

.topnav {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 20px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.06em;
}
.brand-mark {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, var(--accent-steward), var(--accent-ai-external));
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-weight: 800;
  color: #fff;
  font-size: 13px;
}
.nav-tabs {
  display: flex;
  gap: 2px;
  flex: 1;
}
.topnav-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-tab {
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  transition: background 0.12s ease, color 0.12s ease;
}
.nav-tab:hover { background: var(--bg-elevated); color: var(--text-primary); }
.nav-tab[aria-current="page"] {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.page {
  padding: 24px 28px;
  /* Allow space for the fixed-bottom smooth timeline (44px). */
  padding-bottom: 60px;
  overflow: auto;
}
.page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 18px;
}
.page-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
}
.page-sub { color: var(--text-secondary); font-size: 13px; }

.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.card-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}

.placeholder {
  background: var(--bg-surface);
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
}
.placeholder strong {
  display: block;
  margin-bottom: 6px;
  color: var(--text-primary);
  font-size: 16px;
}

/* Skeleton loaders — pages drop these in while data is in flight. */
.skeleton {
  background: linear-gradient(90deg,
    var(--bg-elevated) 0%,
    var(--bg-hover)    50%,
    var(--bg-elevated) 100%);
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

/* Connection banner — surfaces SSE drops. Hidden by default; pages or
 * the shell JS flip the data-state attribute. */
.conn-banner {
  position: fixed;
  bottom: 18px;
  right: 18px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--risk-medium);
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-primary);
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  z-index: 70;
  display: none;
  align-items: center;
  gap: 10px;
}
.conn-banner[data-state="dropped"] {
  display: flex;
  border-left-color: var(--risk-high);
}
.conn-banner[data-state="reconnecting"] {
  display: flex;
  border-left-color: var(--risk-medium);
}
.conn-banner[data-state="ok"] {
  display: flex;
  border-left-color: var(--risk-low);
  animation: conn-fadeout 2s 1s forwards;
}
@keyframes conn-fadeout {
  to { opacity: 0; display: none; }
}
.conn-banner-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--risk-medium);
}
.conn-banner[data-state="dropped"] .conn-banner-dot { background: var(--risk-high); }
.conn-banner[data-state="ok"] .conn-banner-dot { background: var(--risk-low); }
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
    `<header class="topnav" role="navigation" aria-label="Primary">`,
    `<div class="brand"><span class="brand-mark">S</span>STAVR</div>`,
    `<nav class="nav-tabs">${renderNav(input.activePage)}</nav>`,
    `<div class="topnav-right">${renderWatchdogPip()}</div>`,
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
    `<script>${FLOATING_INSPECTOR_JS}</script>`,
    `<script>${TIMELINE_JS}</script>`,
    `<script>${WATCHDOG_PIP_JS}</script>`,
    `<script>${CAPTURE_BUTTON_JS}</script>`,
    script,
    `</body>`,
    `</html>`,
  ].join('\n');
}
