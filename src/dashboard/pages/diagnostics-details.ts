/**
 * Diagnostics drill pages — Connections / Workers / Federation / Alerts.
 *
 * Phase 2 (v0.6.12): these are honesty stubs declaring their drill route
 * and a "page coming in v0.6.12 Phase 4" note. They render the same shell
 * + nav as the rest of the dashboard so the no-orphan-components audit
 * mechanically passes — every tile on the 5-tile overview points at a real
 * URL that returns 200 with shell + breadcrumb back to the overview.
 *
 * Phase 4 (v0.6.12): same renderers get filled in with real content
 * (roster + per-row latency + traffic chart + recent events). The
 * `renderDiagnosticsDetailStub` is exported so tests can detect the
 * stub-vs-real state.
 *
 * Engine detail (`/dashboard/diagnostics/engine`) uses the existing
 * renderDiagnosticsPage in pages/diagnostics.ts — that page is already
 * the dense Proxmox-style Health/Storage/Steward/Traffic layout. The
 * Phase 3 commit refines it with the four collapsible sub-sections.
 */
import { renderShell } from '../shell.js';

export type DiagnosticsDetailId = 'connections' | 'workers' | 'federation' | 'alerts';

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DETAIL_STUB_CSS = `
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
.diag-stub-card {
  padding: 28px 32px;
  display: flex; flex-direction: column; gap: 14px;
}
.diag-stub-title {
  font-size: 18px; font-weight: 500;
  color: var(--ink-0);
  margin: 0;
}
.diag-stub-body {
  font-family: var(--mono); font-size: 12px;
  color: var(--ink-1); line-height: 1.55;
  max-width: 760px;
}
.diag-stub-body code {
  background: rgba(255,255,255,0.06);
  padding: 1px 6px; border-radius: 6px; color: var(--ink-0);
}
.diag-stub-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.diag-stub-actions a {
  font-family: var(--mono); font-size: 11px;
  padding: 6px 12px; border-radius: 6px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--line-2);
  color: var(--ink-1);
}
.diag-stub-actions a.primary {
  background: var(--rust-soft); border-color: var(--rust); color: #ffd9c4;
}
`;

interface StubInput {
  id: DiagnosticsDetailId;
  title: string;
  summary: string;
  willInclude: string[];
  liveSourceHref?: string;
  liveSourceLabel?: string;
}

const STUBS: Record<DiagnosticsDetailId, StubInput> = {
  connections: {
    id: 'connections',
    title: 'Connections — drill',
    summary: 'Per-MCP roster, latency p50/p95/p99, request volume, error rate by class. Read-only — connector management lives on the MCPs page.',
    willInclude: [
      'MCP roster with per-row latency + error rate',
      'Time-window selector (5m / 1h / 24h / 7d)',
      'Recent events filtered to mcp_request kinds',
      'Drill-down per row → inspector panel with full server card',
    ],
    liveSourceHref: '/dashboard/mcps',
    liveSourceLabel: 'manage MCPs →',
  },
  workers: {
    id: 'workers',
    title: 'Workers — drill',
    summary: 'Active + last-4h workers (per Phase 5 retention), per-worker output stream, spawner-protocol metrics (start time, heartbeat cadence, crash signatures).',
    willInclude: [
      'Active worker roster with per-row stdout/stderr tail',
      'Last-4h archived workers (toggle to show older)',
      'Spawner-protocol metrics: avg start ms, heartbeat lag, crash class counts',
      'Recent events filtered to worker_* kinds',
    ],
    liveSourceHref: '/dashboard/streams',
    liveSourceLabel: 'live streams →',
  },
  federation: {
    id: 'federation',
    title: 'Federation — drill',
    summary: 'Peer roster (mDNS-discovered + peers.yaml-configured), recent handshakes, per-peer latency, ACL status. Real post v0.7 — peers are no longer placeholder rows.',
    willInclude: [
      'Peer roster with per-peer reachability + last handshake',
      'mDNS discovery log (recent service announcements)',
      'Per-peer latency p50/p95/p99 + handshake retry count',
      'Recent cross-peer decision events (Tier 3 gate fires)',
    ],
    liveSourceHref: '/dashboard/family-mode',
    liveSourceLabel: 'family-mode setup →',
  },
  alerts: {
    id: 'alerts',
    title: 'Alerts — drill',
    summary: 'Active warnings and history, per-alert acknowledge actions, mute scopes. Alerts fire from the same observability layer as Diagnostics charts (no separate substrate).',
    willInclude: [
      'Active alerts grouped by severity (crit / warn)',
      'History (24h default; toggle to 7d / 30d)',
      'Per-alert ack action (records to event store; rendered in self-heal log)',
      'Mute scopes (silence by alert id, source, or tag)',
    ],
  },
};

export function renderDiagnosticsDetailStub(id: DiagnosticsDetailId): string {
  const s = STUBS[id];
  const willList = s.willInclude.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  const liveLink = s.liveSourceHref
    ? `<a href="${s.liveSourceHref}">${escapeHtml(s.liveSourceLabel ?? 'related →')}</a>`
    : '';

  const body = [
    `<div class="diag-detail">`,
    `<div class="diag-bread">`,
    `<a href="/dashboard/diagnostics">Diagnostics</a>`,
    `<span class="sep">/</span>`,
    `<span>${escapeHtml(s.id)}</span>`,
    `</div>`,
    `<div class="diag-stub-card card">`,
    `<h1 class="diag-stub-title">${escapeHtml(s.title)}</h1>`,
    `<div class="diag-stub-body">`,
    `<p>${escapeHtml(s.summary)}</p>`,
    `<p style="color: var(--ink-2); margin-top: 14px;">This drill page lands real in <code>v0.6.12 Phase 4</code>. Today it returns 200 + shell so the no-orphan-components audit passes — the 5-tile overview always points somewhere real.</p>`,
    `<p style="color: var(--ink-2); margin-top: 4px;">Phase 4 will include:</p>`,
    `<ul>${willList}</ul>`,
    `</div>`,
    `<div class="diag-stub-actions">`,
    `<a class="primary" href="/dashboard/diagnostics">← back to overview</a>`,
    liveLink,
    `</div>`,
    `</div>`,
    `</div>`,
  ].join('');

  return renderShell({
    title: `Stavr — Diagnostics · ${s.id}`,
    activePage: 'diagnostics',
    body,
    head: `<style>${DETAIL_STUB_CSS}</style>`,
  });
}
