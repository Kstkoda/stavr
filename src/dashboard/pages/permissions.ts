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
import { listPolicyPresets } from '../../security/policies.js';

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
  // v0.6.12 Phase 7 — tier-color badge per row + data attributes for filtering.
  const tierLabel = t.defaultTier === 'NO_GO' ? 'NO-GO' : t.defaultTier;
  const tierCls = `perm-tier-${t.defaultTier.toLowerCase().replace('_', '-')}`;
  const stateAttr = t.disabledNow ? 'disabled' : 'enabled';
  return [
    `<tr data-tool="${escapeHtml(t.id)}" data-category="${escapeHtml(t.category)}" data-tier="${escapeHtml(t.defaultTier)}" data-state="${stateAttr}">`,
    `<td><code title="${escapeHtml(t.description)}">${escapeHtml(t.id)}</code></td>`,
    `<td><span class="perm-tier-badge ${tierCls}" title="Default tier · ${escapeHtml(tierLabel)}">${escapeHtml(tierLabel)}</span></td>`,
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

// v0.6.12 Phase 7 — Layer 0 tools grouped by category with collapsible
// headers. Categories sort lexically; each group's header row shows the
// count and acts as a divider. Tools inside each group keep the same row
// shape as before — just a `<tr class="perm-cat-head">` ahead of them.
function renderLayer0GroupedRows(tools: PermissionsToolSummary[]): string {
  const groups = new Map<string, PermissionsToolSummary[]>();
  for (const t of tools) {
    const arr = groups.get(t.category) ?? [];
    arr.push(t);
    groups.set(t.category, arr);
  }
  const out: string[] = [];
  const orderedCats = Array.from(groups.keys()).sort();
  for (const cat of orderedCats) {
    const items = groups.get(cat) ?? [];
    out.push(
      `<tr class="perm-cat-head" data-category="${escapeHtml(cat)}">`,
      `<td colspan="6"><span class="perm-cat-label">${escapeHtml(cat)}</span> <span class="perm-cat-count">${items.length}</span></td>`,
      `</tr>`,
    );
    for (const t of items) out.push(renderLayer0Row(t));
  }
  return out.join('');
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
.perm-table th { color: var(--ink-dim); font-weight: 500; }
.perm-pill {
  padding: 2px 6px;
  border-radius: 6px;
  font-weight: 500;
  font-size: 11px;
  display: inline-block;
}
.perm-pill-on { background: rgba(126, 211, 102, 0.18); color: #7ed366; }
.perm-pill-off { background: rgba(216, 78, 78, 0.18); color: #d84e4e; }
.perm-state { color: var(--ink); font-family: var(--font-mono); font-size: 11px; }
.perm-state-dim { color: var(--ink-dim); font-size: 11px; }
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
  border-radius: 6px;
  padding: 2px 4px;
  font-size: 11px;
}
.perm-cell-default select { color: var(--ink-dim); }
.perm-default-flag {
  color: var(--ink-dim);
  font-size: 11px;
  margin-left: 4px;
}
.perm-actor-name { font-family: var(--font-mono); }
.perm-matrix-wrap {
  overflow-x: auto;
}
.perm-deferred {
  background: rgba(78, 162, 216, 0.08);
  border: 1px solid rgba(78, 162, 216, 0.30);
  border-radius: 10px;
  padding: 8px 12px;
  color: var(--ink-dim);
  font-size: 12px;
  margin-top: 12px;
}
/* v0.6.9 P6 — named-policy apply affordance. */
.perm-policy-bar {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.perm-policy-bar label { color: var(--ink-dim); font-size: 11px; }
.perm-policy-bar select {
  background: rgba(0, 0, 0, 0.3);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
}
.perm-policy-bar input[type=text] {
  background: rgba(0, 0, 0, 0.3);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
  width: 140px;
}
.perm-policy-bar .perm-policy-desc {
  color: var(--ink-dim);
  font-size: 11px;
  font-style: italic;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* v0.6.12 Phase 7 — tier-color badges + category groupers + filter chips. */
.perm-tier-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.perm-tier-badge.perm-tier-auto     { background: rgba(109,213,140,0.14); color: var(--ok); }
.perm-tier-badge.perm-tier-confirm  { background: rgba(106,169,255,0.14); color: var(--sky); }
.perm-tier-badge.perm-tier-explicit { background: rgba(226,169,66,0.14);  color: var(--warn); }
.perm-tier-badge.perm-tier-no-go    { background: rgba(239,90,111,0.14);  color: var(--crit); }
.perm-cat-head td {
  background: rgba(255,255,255,0.03);
  padding: 6px 8px;
  border-top: 1px solid var(--line-2);
}
.perm-cat-label {
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ink-1);
  font-weight: 500;
}
.perm-cat-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  margin-left: 6px;
}
.perm-filters {
  display: flex; gap: 14px; flex-wrap: wrap;
  align-items: center;
  font-family: var(--mono); font-size: 11px;
  color: var(--ink-2);
  padding: 8px 0 12px;
}
.perm-filter-group { display: flex; gap: 6px; align-items: center; }
.perm-filter-group .l { color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; }
.perm-filter-chip {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-2);
  background: rgba(255,255,255,0.02);
  color: var(--ink-1);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}
.perm-filter-chip[aria-pressed="true"] {
  background: var(--rust-soft);
  color: #ffd9c4;
  border-color: var(--rust);
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
  // v0.6.12 Phase 7 — filter chips for tier / state / category.
  const filterState = { tier: 'all', state: 'all', category: 'all' };
  function applyFilters() {
    document.querySelectorAll('tr[data-tool]').forEach(function (tr) {
      const tier = tr.getAttribute('data-tier') || '';
      const state = tr.getAttribute('data-state') || '';
      const cat = tr.getAttribute('data-category') || '';
      const matchTier = filterState.tier === 'all' || tier === filterState.tier;
      const matchState = filterState.state === 'all' || state === filterState.state;
      const matchCat = filterState.category === 'all' || cat === filterState.category;
      tr.style.display = (matchTier && matchState && matchCat) ? '' : 'none';
    });
    // Hide category headers when their group is empty after filter.
    document.querySelectorAll('tr.perm-cat-head').forEach(function (head) {
      const cat = head.getAttribute('data-category') || '';
      const matchCat = filterState.category === 'all' || cat === filterState.category;
      let anyVisible = false;
      let sib = head.nextElementSibling;
      while (sib && !sib.classList.contains('perm-cat-head')) {
        if (sib.style.display !== 'none') { anyVisible = true; break; }
        sib = sib.nextElementSibling;
      }
      head.style.display = (matchCat && anyVisible) ? '' : 'none';
    });
  }
  document.querySelectorAll('.perm-filter-chip').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const filter = btn.getAttribute('data-filter');
      const value = btn.getAttribute('data-value');
      if (!filter || !value) return;
      filterState[filter] = value;
      // Toggle aria-pressed within the same group.
      const group = btn.closest('.perm-filter-group');
      if (group) group.querySelectorAll('.perm-filter-chip').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      applyFilters();
    });
  });

  // v0.6.9 P6 — named-policy apply.
  const policySel = document.querySelector('[data-role="perm-policy-select"]');
  const actorSel  = document.querySelector('[data-role="perm-policy-actor"]');
  const applyBtn  = document.querySelector('[data-role="perm-policy-apply"]');
  const descEl    = document.querySelector('[data-role="perm-policy-desc"]');
  function updatePolicyDesc() {
    if (!policySel || !descEl) return;
    const opt = policySel.options[policySel.selectedIndex];
    descEl.textContent = opt ? (opt.getAttribute('data-desc') || '') : '';
  }
  if (policySel) {
    policySel.addEventListener('change', updatePolicyDesc);
    updatePolicyDesc();
  }
  if (applyBtn) {
    applyBtn.addEventListener('click', async function () {
      const policyId = policySel ? policySel.value : '';
      const actorId  = actorSel ? actorSel.value : '';
      if (!policyId || !actorId) { alert('Pick a policy and an actor first.'); return; }
      const opt = policySel.options[policySel.selectedIndex];
      const label = opt ? opt.textContent : policyId;
      if (!confirm('Apply policy "' + label + '" to actor "' + actorId + '"? This overwrites every per-tool tier the policy names.')) return;
      try {
        const r = await fetch('/dashboard/permissions/policy/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ policy_id: policyId, actor_id: actorId }),
        });
        if (!r.ok) throw new Error(await r.text());
        const body = await r.json();
        alert('Applied "' + policyId + '" to ' + actorId + ' · ' + body.cells_written + ' cells written. Reloading…');
        window.location.reload();
      } catch (e) {
        alert('Apply failed: ' + e.message);
      }
    });
  }
})();
`;

export function renderPermissionsPage(data?: PermissionsData): string {
  const d = data ?? emptyPermissionsData();

  // v0.6.12 Phase 7 — grouped Layer 0 table with category headers + filter bar.
  const layer0Rows = renderLayer0GroupedRows(d.tools);
  const categories = Array.from(new Set(d.tools.map((t) => t.category))).sort();
  const filterBar = d.tools.length > 0 ? [
    `<div class="perm-filters" data-role="perm-filters">`,
    `<div class="perm-filter-group">`,
    `<span class="l">tier</span>`,
    `<button type="button" class="perm-filter-chip" data-filter="tier" data-value="all" aria-pressed="true">all</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="tier" data-value="AUTO">AUTO</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="tier" data-value="CONFIRM">CONFIRM</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="tier" data-value="EXPLICIT">EXPLICIT</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="tier" data-value="NO_GO">NO-GO</button>`,
    `</div>`,
    `<div class="perm-filter-group">`,
    `<span class="l">state</span>`,
    `<button type="button" class="perm-filter-chip" data-filter="state" data-value="all" aria-pressed="true">all</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="state" data-value="enabled">enabled</button>`,
    `<button type="button" class="perm-filter-chip" data-filter="state" data-value="disabled">disabled</button>`,
    `</div>`,
    `<div class="perm-filter-group">`,
    `<span class="l">category</span>`,
    `<button type="button" class="perm-filter-chip" data-filter="category" data-value="all" aria-pressed="true">all</button>`,
    ...categories.map((c) => `<button type="button" class="perm-filter-chip" data-filter="category" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`),
    `</div>`,
    `</div>`,
  ].join('') : '';
  const layer0Section = d.tools.length === 0
    ? `<div class="placeholder">No tools registered. Layer 0 has nothing to gate yet.</div>`
    : [
        filterBar,
        `<div class="perm-matrix-wrap">`,
        `<table class="perm-table">`,
        `<thead><tr><th>tool</th><th>default tier</th><th>state</th><th>detail</th><th>reason</th><th>action</th></tr></thead>`,
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
    // v0.6.9 P6 — Apply-policy affordance.
    const policyOptions = listPolicyPresets()
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" data-desc="${escapeHtml(p.description)}">${escapeHtml(p.label)}</option>`,
      )
      .join('');
    const actorOptions = d.actors
      .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
      .join('');
    const policyBar = [
      `<div class="perm-policy-bar">`,
      `<label>Apply policy</label>`,
      `<select data-role="perm-policy-select">${policyOptions}</select>`,
      `<label>to actor</label>`,
      `<select data-role="perm-policy-actor">${actorOptions}</select>`,
      `<button type="button" class="perm-btn" data-role="perm-policy-apply">Apply</button>`,
      `<span class="perm-policy-desc" data-role="perm-policy-desc"></span>`,
      `</div>`,
    ].join('');
    matrixSection = [
      policyBar,
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
    `<div class="perm-deferred">📋 Pending follow-up: Topology side-drawer integration (the standalone page above is the authoritative surface today). Save-as-custom-policy + YAML scripting land alongside.</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Permissions',
    activePage: 'permissions',
    body,
    head: `<style>${PERMISSIONS_CSS}</style>`,
    script: PERMISSIONS_JS,
  });
}
