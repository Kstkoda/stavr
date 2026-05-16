/**
 * Diagnostics — Proxmox-dense ops + trends page.
 *
 * Phase 1 ships a stub so the new top-rail Diagnostics nav entry resolves;
 * Phase 4 replaces this with the full sectioned view (MCPs / fleet / workers
 * trend charts, self-heal panel, live trace tail) per
 * design-mockups/dashboard-diagnostics-v2-b-proxmox.html.
 */
import { renderShell } from '../shell.js';

export interface DiagnosticsData {
  /** Reserved for the Phase 4 sectioned view (mcp + fleet + worker rosters). */
  _placeholder?: true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderDiagnosticsPage(_data?: DiagnosticsData): string {
  const body = [
    `<div class="page-head">`,
    `<div>`,
    `<h1 class="page-title">Diagnostics</h1>`,
    `<div class="page-sub">MCPs · fleet · workers · self-heal — Proxmox-dense trends</div>`,
    `</div>`,
    `</div>`,
    `<div class="placeholder">`,
    `<strong>Coming in v0.4.1 Phase 4</strong>`,
    escapeHtml('Sectioned MCPs + stavR fleet + workers trends, self-heal log, live trace tail. Window selector controls all charts.'),
    `</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Diagnostics',
    activePage: 'diagnostics',
    body,
  });
}
