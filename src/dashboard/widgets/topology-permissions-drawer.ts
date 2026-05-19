/**
 * src/dashboard/widgets/topology-permissions-drawer.ts
 *
 * v0.6.10 Task 5 — v0.6.9 P8 permissions side-drawer, finally landed.
 *
 * Click any actor-node OR worker-node on the topology canvas → a side
 * drawer slides in from the LEFT (opposite the existing topo-drawer +
 * particle-inspector which slide from the right) showing the per-actor
 * permissions matrix row for that actor or worker type.
 *
 * Affordances per dispatch:
 *   - Per-tool tier dropdown (AUTO / CONFIRM / EXPLICIT / NO_GO) for
 *     the matched (actor, tool) pair — wired to the existing
 *     /dashboard/permissions/actor POST endpoint.
 *   - Layer 0 capability toggle (Enable / Disable) for each tool —
 *     wired to /dashboard/permissions/capability POST + DELETE.
 *   - Deep-link via ?inspect=<actor-id> in the URL so an operator can
 *     share a link to a specific actor's permission state.
 *
 * Data plumbing:
 *   - The full PermissionsData snapshot is embedded once as a
 *     `<script id="topo-permissions-data" type="application/json">`
 *     blob (built server-side, pulled into TopologyData.permissions).
 *     Drawer JS slices the relevant rows client-side on open.
 *   - Backdrop dims only the LEFT portion (overlay) so the constellation
 *     stays visible and unmoved — the canvas doesn't reflow.
 *
 * Why a separate drawer rather than overlaying the existing topo-drawer:
 *   - The existing drawer is the node inspector (Health/Config/Events/
 *     Actions). Reusing it for permissions would muddy two distinct
 *     operator intents. The dispatch was explicit: "side drawer slides
 *     in from the left".
 */

import type { PermissionsData } from '../data/permissions-data.js';

/**
 * Inline a permissions data blob on the topology page. The drawer's JS
 * picks it up by id. Done as a script tag so the JSON stays in the
 * static page payload (no extra round-trip on open).
 */
export function renderPermissionsDataBlob(data: PermissionsData): string {
  // Reduce surface area to the fields the drawer actually consumes —
  // tier dropdowns + Layer 0 state. Avoids leaking the full description
  // strings into the page on every render.
  const compact = {
    actors: data.actors,
    tools: data.tools.map((t) => ({
      id: t.id,
      category: t.category,
      defaultTier: t.defaultTier,
      disabledNow: t.disabledNow,
      layer0State: t.layer0?.state ?? 'enabled',
      layer0Reason: t.layer0?.reason ?? '',
    })),
    matrix: data.matrix.map((c) => ({
      actor: c.actor,
      tool: c.tool,
      tier: c.tier,
      source: c.source,
    })),
  };
  return `<script id="topo-permissions-data" type="application/json">${JSON.stringify(compact)}</script>`;
}

export function renderPermissionsDrawer(): string {
  return [
    `<aside class="topo-perm-drawer" data-role="topo-perm-drawer" aria-hidden="true">`,
    `<header class="tpd-head">`,
    `<div class="tpd-id">`,
    `<span class="tpd-actor-label" data-role="tpd-actor-label">—</span>`,
    `<span class="tpd-actor-meta" data-role="tpd-actor-meta">click an actor or worker to view permissions</span>`,
    `</div>`,
    `<button type="button" class="tpd-close" data-role="tpd-close" aria-label="Close permissions drawer">×</button>`,
    `</header>`,
    `<div class="tpd-body">`,
    `<section class="tpd-rows" data-role="tpd-rows">`,
    `<div class="tpd-empty">Select an actor or worker node to inspect its permissions matrix row.</div>`,
    `</section>`,
    `<footer class="tpd-foot">`,
    `<a class="tpd-deeplink" href="/dashboard/permissions">Open full permissions matrix →</a>`,
    `</footer>`,
    `</div>`,
    `</aside>`,
    `<div class="topo-perm-backdrop" data-role="topo-perm-backdrop" aria-hidden="true"></div>`,
  ].join('');
}

export const TOPOLOGY_PERMISSIONS_DRAWER_CSS = `
.topo-perm-drawer {
  position: fixed;
  top: 70px; bottom: 18px; left: -440px;
  width: 400px; max-width: 92vw;
  background: linear-gradient(180deg, rgba(20,22,31,.96), rgba(15,16,24,.96));
  border: 1px solid var(--line-2);
  border-radius: 14px;
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  box-shadow: 18px 0 44px rgba(0,0,0,.55);
  display: flex; flex-direction: column;
  overflow: hidden;
  transition: left .25s cubic-bezier(.2,.7,.2,1);
  z-index: 95;
  font-family: var(--mono);
}
.topo-perm-drawer[data-open="true"] { left: 18px; }

.topo-perm-backdrop {
  position: fixed;
  top: 70px; bottom: 0; left: 0;
  width: 36vw; max-width: 460px;
  background: linear-gradient(90deg, rgba(0,0,0,0.45) 60%, transparent);
  pointer-events: none;
  opacity: 0;
  transition: opacity .2s ease-out;
  z-index: 94;
}
.topo-perm-backdrop[data-open="true"] {
  opacity: 1;
  pointer-events: auto;
}

.tpd-head {
  display: flex; gap: 10px; align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.tpd-id { flex: 1; min-width: 0; }
.tpd-actor-label {
  display: block;
  font-size: 13px; color: var(--ink-0); font-weight: 600;
}
.tpd-actor-meta {
  display: block;
  font-size: 10.5px; color: var(--ink-3); margin-top: 2px;
}
.tpd-close {
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line-2);
  width: 26px; height: 26px; border-radius: 6px;
  font-size: 14px; cursor: pointer;
}
.tpd-body {
  flex: 1; display: flex; flex-direction: column;
  overflow: hidden;
}
.tpd-rows {
  flex: 1; overflow: auto;
  padding: 8px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.tpd-empty {
  color: var(--ink-3);
  font-style: italic;
  font-size: 11.5px;
  padding: 16px 4px;
}
.tpd-row {
  display: grid;
  grid-template-columns: 1fr 110px 84px;
  gap: 8px; align-items: center;
  padding: 6px 8px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 11px;
}
.tpd-tool-id {
  font-family: var(--mono);
  color: var(--ink-1);
  overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
.tpd-row select.tpd-tier {
  background: var(--bg-0, rgba(0,0,0,0.2));
  color: var(--ink-1);
  border: 1px solid var(--line-2);
  border-radius: 5px;
  padding: 3px 6px;
  font-family: var(--mono);
  font-size: 10.5px;
}
.tpd-row .tpd-l0 {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid var(--line-2);
}
.tpd-row .tpd-l0[data-state="enabled"]  { color: var(--ok); border-color: rgba(109,213,140,0.5); }
.tpd-row .tpd-l0[data-state="disabled"] { color: var(--crit); border-color: rgba(239,90,111,0.5); }
.tpd-row[data-disabled-now="true"] { opacity: .55; }

.tpd-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
.tpd-deeplink { color: var(--sky); text-decoration: none; }
.tpd-deeplink:hover { text-decoration: underline; }
`;

export const TOPOLOGY_PERMISSIONS_DRAWER_JS = `
(function() {
  const drawer = document.querySelector('[data-role="topo-perm-drawer"]');
  const backdrop = document.querySelector('[data-role="topo-perm-backdrop"]');
  const rowsEl = drawer && drawer.querySelector('[data-role="tpd-rows"]');
  const labelEl = drawer && drawer.querySelector('[data-role="tpd-actor-label"]');
  const metaEl = drawer && drawer.querySelector('[data-role="tpd-actor-meta"]');
  const closeEl = drawer && drawer.querySelector('[data-role="tpd-close"]');
  if (!drawer || !rowsEl || !labelEl) return;

  // Load the embedded permissions snapshot. Empty fallback so the
  // drawer still opens cleanly when the page renders before the
  // daemon has any registered tools.
  function loadData() {
    const blob = document.getElementById('topo-permissions-data');
    if (!blob) return { actors: [], tools: [], matrix: [] };
    try {
      return JSON.parse(blob.textContent || '{}') || { actors: [], tools: [], matrix: [] };
    } catch (_) { return { actors: [], tools: [], matrix: [] }; }
  }
  const DATA = loadData();

  const TIER_OPTIONS = ['AUTO', 'CONFIRM', 'EXPLICIT', 'NO_GO'];

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function resolveActorIdForNode(node) {
    // Actor-nodes carry the actor id directly as data-id.
    if (node.getAttribute('data-type') === 'actor') {
      return node.getAttribute('data-id') || null;
    }
    // Worker nodes use the worker type as the matrix actor key. Falls
    // through to the unknown-actor handler if no matrix row exists.
    if (node.getAttribute('data-type') === 'worker') {
      const labelRole = node.querySelector('.node-label .role');
      const type = labelRole ? labelRole.textContent : null;
      return type ? ('worker:' + type) : node.getAttribute('data-id');
    }
    return null;
  }

  function rowsForActor(actor) {
    // Try the actor key as supplied first; for actor-nodes the topology
    // ids look like 'actor-operator-op' but the PermissionsData matrix
    // keys on 'operator'/'cc'/'cowork'/'cc-feat-1' depending on what
    // was registered. We do a best-effort match on the class tag
    // suffix.
    const direct = DATA.matrix.filter(function(r) { return r.actor === actor; });
    if (direct.length > 0) return direct;
    // For 'actor-cc-cc-feat-1' strip 'actor-cc-' and try 'cc-feat-1'.
    const m = actor && actor.match(/^actor-[a-z]+-(.+)$/);
    if (m) {
      const candidate = DATA.matrix.filter(function(r) { return r.actor === m[1]; });
      if (candidate.length > 0) return candidate;
    }
    // For 'actor-operator-...' fall back to the canonical 'operator' actor.
    const cls = actor && actor.match(/^actor-([a-z]+)-/);
    if (cls) {
      const canonical = DATA.matrix.filter(function(r) { return r.actor === cls[1]; });
      if (canonical.length > 0) return canonical;
    }
    return [];
  }

  function toolMeta(toolId) {
    return DATA.tools.find(function(t) { return t.id === toolId; }) || null;
  }

  function renderRows(actor, rows) {
    if (rows.length === 0) {
      rowsEl.innerHTML = '<div class="tpd-empty">No matrix entries for <code>' + esc(actor) + '</code>. The /dashboard/permissions page can seed defaults for new actors.</div>';
      return;
    }
    rowsEl.innerHTML = rows.map(function(r) {
      const meta = toolMeta(r.tool);
      const disabledNow = meta && meta.disabledNow;
      const l0state = disabledNow ? 'disabled' : 'enabled';
      const tierOpts = TIER_OPTIONS.map(function(t) {
        return '<option value="' + t + '"' + (t === r.tier ? ' selected' : '') + '>' + t + '</option>';
      }).join('');
      return ''
        + '<div class="tpd-row" data-tool="' + esc(r.tool) + '" data-actor="' + esc(actor) + '" data-disabled-now="' + (disabledNow ? 'true' : 'false') + '">'
        +   '<span class="tpd-tool-id" title="' + esc(r.tool) + '">' + esc(r.tool) + '</span>'
        +   '<select class="tpd-tier" data-role="tpd-tier">' + tierOpts + '</select>'
        +   '<button type="button" class="tpd-l0" data-role="tpd-l0" data-state="' + l0state + '">' + (disabledNow ? 'OFF' : 'ON') + '</button>'
        + '</div>';
    }).join('');
  }

  function open(actor, labelText, metaText) {
    labelEl.textContent = labelText || actor;
    metaEl.textContent = metaText || (actor + ' — permissions');
    const rows = rowsForActor(actor);
    renderRows(actor, rows);
    drawer.setAttribute('data-open', 'true');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.setAttribute('data-open', 'true');
    // Persist to URL for deep-link.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('inspect', actor);
      window.history.replaceState({}, '', url.toString());
    } catch (_) {}
  }

  function close() {
    drawer.removeAttribute('data-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.removeAttribute('data-open');
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('inspect');
      window.history.replaceState({}, '', url.toString());
    } catch (_) {}
  }

  // ---------- node clicks: actor + worker ----------
  // Hook clicks at the canvas level so we don't fight the existing
  // drag-vs-click distinction in the topology JS.
  const canvas = document.querySelector('[data-role="topo-canvas"]');
  if (canvas) {
    canvas.addEventListener('click', function(ev) {
      const node = ev.target.closest && ev.target.closest('.gnode[data-type="actor"], .gnode[data-type="worker"]');
      if (!node) return;
      // Suppress the default node-inspector for these clicks by not
      // bubbling further to the canvas-level drag handler — but the
      // existing topo-drawer handler runs on mouseup not click, so
      // these don't interfere.
      const actorId = resolveActorIdForNode(node);
      if (!actorId) return;
      const labelEl2 = node.querySelector('.node-label');
      const labelText = (labelEl2 ? (labelEl2.firstChild ? labelEl2.firstChild.textContent : labelEl2.textContent) : '') || actorId;
      const subText = node.getAttribute('data-actor-class')
        ? 'actor · ' + node.getAttribute('data-actor-class')
        : 'worker · ' + (node.getAttribute('data-id') || '');
      open(actorId, labelText.trim(), subText);
    }, true);
  }
  if (closeEl) closeEl.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  // ---------- tier dropdown + Layer 0 toggle wiring ----------
  rowsEl.addEventListener('change', function(ev) {
    const sel = ev.target.closest && ev.target.closest('[data-role="tpd-tier"]');
    if (!sel) return;
    const row = sel.closest('.tpd-row');
    if (!row) return;
    const tier = sel.value;
    const actor = row.getAttribute('data-actor');
    const tool = row.getAttribute('data-tool');
    fetch('/dashboard/permissions/actor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: actor, tool: tool, tier: tier }),
    }).catch(function() { /* leave UI optimistic */ });
  });
  rowsEl.addEventListener('click', function(ev) {
    const btn = ev.target.closest && ev.target.closest('[data-role="tpd-l0"]');
    if (!btn) return;
    const row = btn.closest('.tpd-row');
    if (!row) return;
    const tool = row.getAttribute('data-tool');
    const current = btn.getAttribute('data-state');
    const nextState = current === 'disabled' ? 'enabled' : 'disabled';
    if (nextState === 'disabled') {
      fetch('/dashboard/permissions/capability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: tool, state: 'disabled-permanent', reason: 'disabled from topology drawer' }),
      }).then(function() {
        btn.setAttribute('data-state', 'disabled');
        btn.textContent = 'OFF';
        row.setAttribute('data-disabled-now', 'true');
      }).catch(function() {});
    } else {
      fetch('/dashboard/permissions/capability/' + encodeURIComponent(tool), {
        method: 'DELETE',
      }).then(function() {
        btn.setAttribute('data-state', 'enabled');
        btn.textContent = 'ON';
        row.setAttribute('data-disabled-now', 'false');
      }).catch(function() {});
    }
  });

  // ---------- Esc to close ----------
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && drawer.getAttribute('data-open') === 'true') close();
  });

  // ---------- ?inspect= deep-link restore ----------
  try {
    const url = new URL(window.location.href);
    const inspectActor = url.searchParams.get('inspect');
    if (inspectActor) {
      open(inspectActor, inspectActor, 'restored from deep-link');
    }
  } catch (_) {}
})();
`;
