/**
 * Plans page — food-label list of every BOM with click-to-expand step
 * detail and approve/reject actions.
 *
 * Server-renders the current list from a snapshot, then live-refreshes
 * on bom_* SSE events. Expanded detail loads from /dashboard/plans/:id
 * on click; approve/reject POST to /dashboard/plans/:id/respond.
 */
import type { Bom, BomStatus, RiskClass } from '../../types/stavr-bom.js';
import { renderShell } from '../shell.js';
import { renderFoodLabel } from '../components/food-label.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import {
  bomToFoodLabel,
  highestRisk,
  splitEnvelope,
  RISK_BUCKET,
} from '../adapters/bom.js';

export interface PlansData {
  boms: Bom[];
  totals: Record<BomStatus, number>;
}

const STATUS_PILL: Record<BomStatus, PillVariant> = {
  proposed:  'warning',
  approved:  'info',
  running:   'info',
  done:      'success',
  failed:    'danger',
  cancelled: 'neutral',
  rejected:  'neutral',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RISK_LABEL: Record<RiskClass, string> = {
  'read-only':     'read-only',
  'write-local':   'write-local',
  'execute':       'execute',
  'write-remote':  'write-remote',
  'external-comm': 'external-comm',
  'credential':    'credential',
  'financial':     'financial',
  'destructive':   'destructive',
};

function renderRiskBreakdown(envelope: RiskClass[]): string {
  if (envelope.length === 0) {
    return `<span class="risk-empty">no risk declared</span>`;
  }
  const split = splitEnvelope(envelope);
  const parts: string[] = [];
  if (split.allowed.length > 0) {
    parts.push(
      `<div class="risk-line">`,
      `<span class="risk-glyph risk-glyph-ok">✓</span>`,
      `<span class="risk-label">approved without re-prompt</span>`,
      `<span class="risk-chips">`,
      split.allowed.map((r) => `<span class="risk-chip allowed">${escapeHtml(RISK_LABEL[r])}</span>`).join(''),
      `</span>`,
      `</div>`,
    );
  }
  if (split.willAsk.length > 0) {
    parts.push(
      `<div class="risk-line">`,
      `<span class="risk-glyph risk-glyph-warn">⚠</span>`,
      `<span class="risk-label">will ask before each</span>`,
      `<span class="risk-chips">`,
      split.willAsk.map((r) => `<span class="risk-chip will-ask">${escapeHtml(RISK_LABEL[r])}</span>`).join(''),
      `</span>`,
      `</div>`,
    );
  }
  return parts.join('');
}

function renderBomRow(bom: Bom): string {
  const fl = bomToFoodLabel(bom);
  // Render the food-label first, then a "details" row hidden by default
  // that the client expands when the card is clicked.
  const statusPill = renderPill({
    text: bom.status,
    variant: STATUS_PILL[bom.status],
    title: `BOM status: ${bom.status}`,
  });
  return [
    `<article class="bom-row" data-bom-id="${escapeHtml(bom.id)}" data-status="${escapeHtml(bom.status)}">`,
    `<button type="button" class="bom-toggle" data-role="toggle" aria-expanded="false"`,
    ` aria-controls="bom-detail-${escapeHtml(bom.id)}">`,
    renderFoodLabel({ ...fl, href: undefined, id: bom.id }),
    `</button>`,
    `<div class="bom-status-strip">`,
    statusPill,
    `<span class="bom-id" title="${escapeHtml(bom.id)}">${escapeHtml(bom.id.slice(0, 14))}…</span>`,
    `<div class="bom-risk-breakdown">${renderRiskBreakdown(bom.risk_envelope)}</div>`,
    `</div>`,
    `<section id="bom-detail-${escapeHtml(bom.id)}" class="bom-detail" hidden`,
    ` data-role="detail" data-loaded="false">`,
    `<div class="detail-placeholder">Loading steps…</div>`,
    `</section>`,
    `</article>`,
  ].join('');
}

function renderTopBar(totals: Record<BomStatus, number>): string {
  const order: BomStatus[] = ['proposed', 'approved', 'running', 'done', 'failed', 'rejected', 'cancelled'];
  const chips = order
    .filter((s) => (totals[s] ?? 0) > 0 || s === 'proposed' || s === 'running')
    .map((s) => {
      const count = totals[s] ?? 0;
      return `<button type="button" class="filter-chip" data-status="${s}" data-active="${s === 'proposed'}">`
        + `${renderPill({ text: `${s} · ${count}`, variant: STATUS_PILL[s] })}`
        + `</button>`;
    });
  return [
    `<div class="plans-toolbar">`,
    `<div class="filter-row" role="tablist" aria-label="Filter by status">`,
    chips.join(''),
    `</div>`,
    `<div class="toolbar-sub" data-role="live-status">live · listening</div>`,
    `</div>`,
  ].join('');
}

const PLANS_CSS = `
.plans-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
  gap: 8px;
}
.filter-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.filter-chip {
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.12s ease;
}
.filter-chip[data-active="true"], .filter-chip:hover { opacity: 1; }
.toolbar-sub {
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.plans-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bom-row {
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
}
.bom-toggle {
  display: block;
  width: 100%;
  background: none;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.bom-toggle .food-label {
  border: 0;
  border-radius: 10px 10px 0 0;
  background: transparent;
}
.bom-status-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  background: var(--bg-elevated);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.bom-id {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}
.bom-risk-breakdown {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 200px;
}
.risk-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.risk-glyph {
  width: 16px;
  text-align: center;
  font-weight: 700;
}
.risk-glyph-ok   { color: var(--risk-low); }
.risk-glyph-warn { color: var(--risk-medium); }
.risk-label {
  color: var(--text-secondary);
  font-size: 11px;
  letter-spacing: 0.03em;
}
.risk-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.risk-chip {
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  border: 1px solid var(--border-strong);
}
.risk-chip.allowed  { color: var(--risk-low);    border-color: rgba(74,222,128,0.45); }
.risk-chip.will-ask { color: var(--risk-medium); border-color: rgba(250,204,21,0.45); }
.risk-empty { color: var(--text-dim); font-style: italic; font-size: 12px; }

.bom-detail {
  border-top: 1px solid var(--border);
  padding: 16px;
}
.bom-detail[hidden] { display: none; }
.detail-placeholder { color: var(--text-dim); font-style: italic; }
.steps-table {
  display: grid;
  grid-template-columns: 38px 1fr auto auto auto;
  gap: 8px 14px;
  align-items: center;
}
.step-header {
  display: contents;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.step-header > span {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  font-weight: 700;
}
.step-cell {
  font-size: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.step-cell.title { color: var(--text-primary); }
.step-cell.risk[data-risk="high"]   { color: var(--risk-high); }
.step-cell.risk[data-risk="medium"] { color: var(--risk-medium); }
.step-cell.risk[data-risk="low"]    { color: var(--risk-low); }
.step-cell.muted { color: var(--text-dim); font-family: ui-monospace, Menlo, Consolas, monospace; }
.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  justify-content: flex-end;
}
.btn {
  padding: 7px 14px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-primary);
  cursor: pointer;
}
.btn.primary { background: rgba(74,222,128,0.10); border-color: var(--risk-low); color: var(--risk-low); }
.btn.primary:hover { background: rgba(74,222,128,0.20); }
.btn.danger  { background: rgba(239,68,68,0.10);  border-color: var(--risk-high); color: var(--risk-high); }
.btn.danger:hover { background: rgba(239,68,68,0.20); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.bom-row[data-status="running"] .bom-toggle .food-label { box-shadow: inset 0 0 0 1px var(--accent-mcp); }
.empty-plans {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-radius: 10px;
  border: 1px dashed var(--border-strong);
}
`;

const PLANS_JS = `
(function() {
  const PLANS_LIST_URL = '/dashboard/plans/list';
  const STREAM_URL = '/dashboard/stream';

  const list = document.querySelector('[data-role="plans-list"]');
  const liveStatus = document.querySelector('[data-role="live-status"]');
  if (!list) return;

  // ---------- expand/collapse ----------
  list.addEventListener('click', async function(ev) {
    const toggle = ev.target.closest('[data-role="toggle"]');
    if (toggle) {
      ev.preventDefault();
      const row = toggle.closest('.bom-row');
      const detail = row.querySelector('[data-role="detail"]');
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        toggle.setAttribute('aria-expanded', 'false');
        detail.setAttribute('hidden', '');
        return;
      }
      toggle.setAttribute('aria-expanded', 'true');
      detail.removeAttribute('hidden');
      if (detail.getAttribute('data-loaded') === 'false') {
        await loadDetail(row);
      }
      return;
    }
    const btn = ev.target.closest('[data-role="respond"]');
    if (btn) {
      ev.preventDefault();
      await respond(btn);
    }
  });

  async function loadDetail(row) {
    const id = row.getAttribute('data-bom-id');
    const detail = row.querySelector('[data-role="detail"]');
    try {
      const r = await fetch('/dashboard/plans/' + encodeURIComponent(id), {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      detail.innerHTML = renderDetail(data, id, row.getAttribute('data-status'));
      detail.setAttribute('data-loaded', 'true');
    } catch (err) {
      detail.innerHTML = '<div class="detail-placeholder">Failed to load: ' + escapeHtml(String(err)) + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function riskBucket(risk) {
    if (risk === 'destructive' || risk === 'financial' || risk === 'credential' || risk === 'external-comm') return 'high';
    if (risk === 'write-remote' || risk === 'execute') return 'medium';
    return 'low';
  }

  function renderDetail(data, bomId, status) {
    const bom = data.bom;
    const steps = data.steps || [];
    const stepRows = steps.map(function(s) {
      const bucket = riskBucket(s.risk_class);
      const deps = (s.depends_on || []).join(', ') || '—';
      return '<span class="step-cell muted">' + s.step_no + '</span>'
        + '<span class="step-cell title">' + escapeHtml(s.title) + '</span>'
        + '<span class="step-cell muted">' + escapeHtml(s.brick_id || '—') + '</span>'
        + '<span class="step-cell risk" data-risk="' + bucket + '">' + escapeHtml(s.risk_class) + '</span>'
        + '<span class="step-cell muted">$' + (Number(s.cost_estimate) || 0).toFixed(2) + '</span>';
    }).join('');
    const canRespond = status === 'proposed';
    const actions = canRespond
      ? '<div class="detail-actions">'
        + '<button type="button" class="btn danger" data-role="respond" data-verdict="reject" data-id="' + escapeHtml(bomId) + '">Reject</button>'
        + '<button type="button" class="btn primary" data-role="respond" data-verdict="approve" data-id="' + escapeHtml(bomId) + '">Approve</button>'
        + '</div>'
      : '';
    return ''
      + '<div class="steps-table">'
        + '<div class="step-header">'
          + '<span>#</span><span>Title</span><span>Brick</span><span>Risk</span><span>Cost</span>'
        + '</div>'
        + (steps.length === 0
          ? '<div class="step-cell muted" style="grid-column: 1 / -1;">No steps recorded for this version.</div>'
          : stepRows)
      + '</div>'
      + '<div style="margin-top:14px; font-size:11px; color: var(--text-dim);">'
        + 'Trust scope: ' + (bom.scope_id ? escapeHtml(bom.scope_id) : '<em>created on approval</em>')
        + ' · Profile: ' + escapeHtml(bom.profile_mode)
      + '</div>'
      + actions;
  }

  async function respond(btn) {
    const id = btn.getAttribute('data-id');
    const verdict = btn.getAttribute('data-verdict');
    const others = btn.parentElement.querySelectorAll('button');
    others.forEach(function(b) { b.setAttribute('disabled', ''); });
    try {
      const r = await fetch('/dashboard/plans/' + encodeURIComponent(id) + '/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: verdict }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('HTTP ' + r.status + ': ' + txt);
      }
      // Animate the row into the new state. C3 keeps it simple: refresh
      // the whole list so the chip filter and counts stay accurate.
      await refresh();
      if (verdict === 'approve') {
        // BOM jumps to Topology — give the executor a moment to lay it out.
        setTimeout(function() {
          window.location.href = '/dashboard/topology#' + encodeURIComponent(id);
        }, 350);
      }
    } catch (err) {
      btn.parentElement.innerHTML = '<div class="detail-placeholder">Failed: ' + escapeHtml(String(err)) + '</div>';
    }
  }

  // ---------- filter ----------
  const filterRow = document.querySelector('.filter-row');
  let activeFilter = 'proposed';
  if (filterRow) {
    filterRow.addEventListener('click', function(ev) {
      const chip = ev.target.closest('[data-status]');
      if (!chip) return;
      const status = chip.getAttribute('data-status');
      filterRow.querySelectorAll('[data-status]').forEach(function(c) {
        c.setAttribute('data-active', c === chip ? 'true' : 'false');
      });
      activeFilter = status;
      applyFilter();
    });
  }
  function applyFilter() {
    list.querySelectorAll('.bom-row').forEach(function(row) {
      const match = row.getAttribute('data-status') === activeFilter;
      row.style.display = match ? '' : 'none';
    });
    const visible = list.querySelectorAll('.bom-row:not([style*="display: none"])').length;
    const empty = list.querySelector('.empty-plans');
    if (empty) empty.style.display = visible === 0 ? '' : 'none';
  }
  applyFilter();

  // ---------- live refresh ----------
  let inflight = false;
  let timer = null;
  async function refresh() {
    if (inflight) return;
    inflight = true;
    try {
      const r = await fetch(PLANS_LIST_URL);
      if (!r.ok) return;
      const data = await r.json();
      // For C3 we rebuild the visible portion. Re-rendering the full
      // markup on the client is heavier than ideal — C10 polish can move
      // to delta updates. Here we replace the whole list HTML server-side
      // by reloading the page invisibly when too many rows changed.
      const rows = data.boms || [];
      // Strategy: if the count or any id has changed, do a soft reload.
      const seen = new Set();
      list.querySelectorAll('.bom-row').forEach(function(r) {
        seen.add(r.getAttribute('data-bom-id'));
      });
      const incoming = new Set(rows.map(function(b) { return b.id; }));
      let differs = seen.size !== incoming.size;
      if (!differs) {
        for (const id of seen) { if (!incoming.has(id)) { differs = true; break; } }
      }
      if (differs) {
        window.location.reload();
        return;
      }
      // Same set — just update status data-attrs so filters still work.
      rows.forEach(function(b) {
        const row = list.querySelector('[data-bom-id="' + b.id + '"]');
        if (row) row.setAttribute('data-status', b.status);
      });
      applyFilter();
    } catch (err) {
      // banner UX is C10
    } finally {
      inflight = false;
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(function() { timer = null; refresh(); }, 300);
  }
  setInterval(refresh, 6000);
  try {
    const es = new EventSource(STREAM_URL);
    es.addEventListener('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data && typeof data.kind === 'string' && data.kind.indexOf('bom_') === 0) {
          schedule();
        }
      } catch (_) { schedule(); }
    });
    es.addEventListener('open', function() {
      if (liveStatus) liveStatus.textContent = 'live · listening';
    });
    es.addEventListener('error', function() {
      if (liveStatus) liveStatus.textContent = 'live · reconnecting';
    });
  } catch (err) { /* fall back to interval */ }
})();
`;

export function renderPlansPage(data?: PlansData): PlansPageRender {
  const snapshot: PlansData = data ?? {
    boms: [],
    totals: { proposed: 0, approved: 0, running: 0, done: 0, failed: 0, cancelled: 0, rejected: 0 },
  };
  const rows = snapshot.boms.length === 0
    ? `<div class="empty-plans">No BOMs yet — propose one and it'll appear here.</div>`
    : snapshot.boms.map(renderBomRow).join('');
  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Stavr — Plans</h1>`,
    `<span class="page-sub">${snapshot.boms.length} BOM${snapshot.boms.length === 1 ? '' : 's'}</span>`,
    `</div>`,
    renderTopBar(snapshot.totals),
    `<div class="plans-list" data-role="plans-list">${rows}</div>`,
  ].join('');
  return renderShell({
    title: 'Stavr — Plans',
    activePage: 'plans',
    body,
    head: `<style>${PLANS_CSS}</style>`,
    script: PLANS_JS,
  });
}

// String alias for export-named clarity in tests / callers.
type PlansPageRender = string;

// Re-export the highestRisk helper for tests that want to verify the
// breakdown rendered above without re-deriving the rule.
export { highestRisk, RISK_BUCKET };
