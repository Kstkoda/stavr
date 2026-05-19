/**
 * Permissions page — `/dashboard/permissions`. v0.6.9 PR #2.
 *
 * The operator-visible half of the 5-layer governance model:
 *   1. Lex Insculpta (source code, off-screen)
 *   2. No-Go list (source code, off-screen)
 *   3. Layer 0 capability disables  ← editable on this page
 *   4. Per-actor permission tiers   ← editable on this page
 *   5. Trust scopes (Settings page, unchanged)
 *
 * Layout:
 *   - Top — Layer 0 panel listing every tool with an Enable/Disable
 *     toggle, current state pill, and reason field
 *   - Bottom — Per-actor matrix grid. Rows = actors, columns = tools,
 *     each cell is a tier dropdown (AUTO / CONFIRM / EXPLICIT / NO-GO),
 *     "default" rows show the registered default tier in lighter text
 *
 * Topology overlay (BOM P5 original scope) is deferred to PR #3 to
 * keep this PR shippable tonight; the existing topology page is too
 * dense to retrofit a clean side-drawer in one sitting. The standalone
 * permissions page delivers the same operator-controllable surface.
 *
 * All mutations go through the typed dashboard API endpoints
 * (`/dashboard/permissions/capability`, `/dashboard/permissions/actor`)
 * — never direct DB writes from the page (BOM hard rule #7).
 */
import { renderShell } from '../shell.js';
import type {
  PermissionsData,
  PermissionsMatrixCell,
  PermissionsToolSummary,
} from '../data/permissions-data.js';
import { emptyPermissionsData } from '../data/permissions-data.js';
import type { Tier } from '../../tools/categories.js';

const TIER_OPTIONS: Tier[] = ['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO'];

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLayer0Row(t: PermissionsToolSummary): string {
  const state = t.layer0?.state ?? 'enabled';
  const reason = t.layer0?.reason ?? '';
  const until = t.layer0?.disabled_until
    ? new Date(t.layer0.disabled_until).toISOString()
    : '';
  const pillClass = t.disabledNow ? 'perm-pill-off' : 'perm-pill-on';
  const pillText = t.disabledNow ? 'DISABLED' : 'ENABLED';
  return [
    `<tr data-tool="${escapeHtml(t.id)}">`,
    `<td><code>${escapeHtml(t.id)}</code></td>`,
    `<td><span class="perm-pill ${pillClass}">${pillText}</span></td>`,
    `<td><span class="perm-state">${escapeHtml(state)}</span>${until ? ` <span class="perm-state-dim">until ${escapeHtml(until)}</span>` : ''}</td>`,
    `<td class="perm-reason">${escapeHtml(reason)}</td>`,
    `<td>`,
    t.disabledNow
      ? `<button type="button" data-action="enable" data-tool="${escapeHtml(t.id)}" class="perm-btn perm-btn-enable">Re-enable</button>`
      : `<button type="button" data-action="disable" data-tool="${escapeHtml(t.id)}" class="perm-btn perm-btn-disable">Disable</button>`,
    `</td>`,
    `</tr>`,
  ].join('');
}

function renderMatrixHeaderRow(tools: PermissionsToolSummary[]): string {
  const cols = tools
    .map((t) => `<th title="${escapeHtml(t.description)}"><code>${escapeHtml(t.id)}</code></th>`)
    .join('');
  return `<tr><th>actor \\ tool</th>${cols}</tr>`;
}

function renderMatrixRow(actor: string, cells: PermissionsMatrixCell[]): string {
  const cols = cells
    .map((c) => {
      const optionMarkup = TIER_OPTIONS.map(
        (t) =>
          `<option value="${escapeHtml(t)}"${t === c.tier ? ' selected' : ''}>${escapeHtml(t === 'NO_GO' ? 'NO-GO' : t)}</option>`,
      ).join('');
      return [
        `<td class="perm-cell perm-cell-${escapeHtml(c.source)}" data-actor="${escapeHtml(c.actor)}" data-tool="${escapeHtml(c.tool)}">`,
        `<select data-role="perm-tier" data-actor="${escapeHtml(c.actor)}" data-tool="${escapeHtml(c.tool)}">`,
        optionMarkup,
        `</select>`,
        c.source === 'default' ? '<span class="perm-default-flag" title="default tier; click to override">·</span>' : '',
        `</td>`,
      ].join('');
    })
    .join('');
  return `<tr><th class="perm-actor-name">${escapeHtml(actor)}</th>${cols}</tr>`;
}

const PERMISSIONS_CSS = `
.page-head { margin-bottom: 12px; }
.perm-section {
  background: rgba(20, 22, 31, 0.55);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  backdrop-filter: blur(14px);
  margin-bottom: 16px;
}
.perm-section h2 {
  font-size: 14px;
  margin: 0 0 8px 0;
  color: var(--ink);
}
.perm-section .perm-sub {
  color: var(--ink-dim);
  font-size: 12px;
  margin-bottom: 12px;
}
.perm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.perm-table th, .perm-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  vertical-align: middle;
}
.perm-table th { color: var(--ink-dim); font-weight: 600; }
.perm-pill {
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
  display: inline-block;
}
.perm-pill-on { background: rgba(126, 211, 102, 0.18); color: #7ed366; }
.perm-pill-off { background: rgba(216, 78, 78, 0.18); color: #d84e4e; }
.perm-state { color: var(--ink); font-family: var(--font-mono); font-size: 11px; }
.perm-state-dim { color: var(--ink-dim); font-size: 10px; }
.perm-reason {
  color: var(--ink-dim);
  font-style: italic;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.perm-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--ink);
  font-size: 11px;
  cursor: pointer;
}
.perm-btn-disable { background: rgba(216, 78, 78, 0.10); border-color: rgba(216, 78, 78, 0.30); color: #d84e4e; }
.perm-btn-enable  { background: rgba(126, 211, 102, 0.10); border-color: rgba(126, 211, 102, 0.30); color: #7ed366; }
.perm-cell select {
  background: rgba(0, 0, 0, 0.3);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 11px;
}
.perm-cell-default select { color: var(--ink-dim); }
.perm-default-flag {
  color: var(--ink-dim);
  font-size: 10px;
  margin-left: 4px;
}
.perm-actor-name { font-family: var(--font-mono); }
.perm-matrix-wrap {
  overflow-x: auto;
}
.perm-deferred {
  background: rgba(78, 162, 216, 0.08);
  border: 1px solid rgba(78, 162, 216, 0.30);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--ink-dim);
  font-size: 12px;
  margin-top: 12px;
}
`;

const PERMISSIONS_JS = `
(function () {
  // Layer 0 toggle handlers
  document.querySelectorAll('[data-action="disable"]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const tool = btn.getAttribute('data-tool');
      const reason = prompt('Reason for disabling ' + tool + '? (optional)') || '';
      try {
        const r = await fetch('/dashboard/permissions/capability', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool_id: tool, mode: 'permanent', reason: reason }),
        });
        if (!r.ok) throw new Error(await r.text());
        window.location.reload();
      } catch (e) {
        alert('Disable failed: ' + e.message);
      }
    });
  });
  document.querySelectorAll('[data-action="enable"]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const tool = btn.getAttribute('data-tool');
      try {
        const r = await fetch('/dashboard/permissions/capability/' + encodeURIComponent(tool), {
          method: 'DELETE',
        });
        if (!r.ok) throw new Error(await r.text());
        window.location.reload();
      } catch (e) {
        alert('Re-enable failed: ' + e.message);
      }
    });
  });
  // Matrix tier dropdowns
  document.querySelectorAll('[data-role="perm-tier"]').forEach(function (sel) {
    sel.addEventListener('change', async function () {
      const actor = sel.getAttribute('data-actor');
      const tool = sel.getAttribute('data-tool');
      const tier = sel.value;
      try {
        const r = await fetch('/dashboard/permissions/actor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor_id: actor, tool_id: tool, tier: tier }),
        });
        if (!r.ok) throw new Error(await r.text());
        const cell = sel.closest('.perm-cell');
        if (cell) cell.classList.remove('perm-cell-default');
        if (cell) cell.classList.add('perm-cell-matrix');
      } catch (e) {
        alert('Update failed: ' + e.message);
      }
    });
  });
})();
`;

export function renderPermissionsPage(data?: PermissionsData): string {
  const d = data ?? emptyPermissionsData();

  const layer0Rows = d.tools.map(renderLayer0Row).join('');
  const layer0Section = d.tools.length === 0
    ? `<div class="placeholder">No tools registered. Layer 0 has nothing to gate yet.</div>`
    : [
        `<div class="perm-matrix-wrap">`,
        `<table class="perm-table">`,
        `<thead><tr><th>tool</th><th>state</th><th>detail</th><th>reason</th><th>action</th></tr></thead>`,
        `<tbody>${layer0Rows}</tbody>`,
        `</table>`,
        `</div>`,
      ].join('');

  let matrixSection = '';
  if (d.tools.length > 0) {
    const headerRow = renderMatrixHeaderRow(d.tools);
    const actorRows = d.actors
      .map((actor) => {
        const cells = d.matrix.filter((c) => c.actor === actor);
        return renderMatrixRow(actor, cells);
      })
      .join('');
    matrixSection = [
      `<div class="perm-matrix-wrap">`,
      `<table class="perm-table">`,
      `<thead>${headerRow}</thead>`,
      `<tbody>${actorRows}</tbody>`,
      `</table>`,
      `</div>`,
    ].join('');
  } else {
    matrixSection = `<div class="placeholder">No tools registered. Per-actor matrix is empty.</div>`;
  }

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Permissions</h1>`,
    `<span class="page-sub">5-layer governance — Layer 0 disables + per-actor matrix · ${d.toolCount} tools · ${d.disabledCount} disabled</span>`,
    `</div>`,
    `<section class="perm-section">`,
    `<h2>Layer 0 — capability master switch</h2>`,
    `<div class="perm-sub">Disabling here overrides every per-actor tier and every active trust scope. Only Lex Insculpta + No-Go (source code) sit above this.</div>`,
    layer0Section,
    `</section>`,
    `<section class="perm-section">`,
    `<h2>Per-actor permissions matrix (Layer 3)</h2>`,
    `<div class="perm-sub">Tier per (actor, tool). Defaults shown in dim text — click any cell to override. Save is per-cell + immediate.</div>`,
    matrixSection,
    `</section>`,
    `<div class="perm-deferred">📋 PR #3 adds: named policies (save/apply/preview-diff), YAML export/import (operator scripting), audit-event emission, Topology side-drawer integration.</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Permissions',
    activePage: 'permissions',
    body,
    head: `<style>${PERMISSIONS_CSS}</style>`,
    script: PERMISSIONS_JS,
  });
}
