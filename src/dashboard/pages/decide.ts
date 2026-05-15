/**
 * Decide page — open decisions as food-label cards with options as
 * buttons, a countdown to the timeout-default, and a context block
 * showing the last few related events.
 *
 * Server-renders the current open + recently-resolved decisions, then
 * lives off /dashboard/stream — every decision_request adds a card,
 * every decision_response moves one to the resolved section.
 */
import type { DecisionRecord } from '../../persistence.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface DecideData {
  open: DecisionRecord[];
  resolved: DecisionRecord[];
  /** Optional context per correlation_id — last few events for the
   *  decision. Loaded lazily by the client when missing. */
  context?: Record<string, ContextEvent[]>;
}

export interface ContextEvent {
  kind: string;
  at: string;
  source_agent: string;
  summary: string;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RESOLVED_PILL: Record<DecisionRecord['status'], PillVariant> = {
  open:      'warning',
  responded: 'success',
  expired:   'neutral',
};

function shortCorr(corr: string): string {
  return corr.length > 16 ? corr.slice(0, 14) + '…' : corr;
}

function renderOpenCard(d: DecisionRecord, ctx?: ContextEvent[]): string {
  const expiresAt = Date.parse(d.expires_at);
  const defaultOpt = d.default_option_id
    ? d.options.find((o) => o.id === d.default_option_id)
    : undefined;
  const buttons = d.options.map((opt) => {
    const isDefault = opt.id === d.default_option_id;
    return [
      `<button type="button" class="opt-btn${isDefault ? ' opt-default' : ''}"`,
      ` data-role="respond" data-corr="${escapeHtml(d.correlation_id)}"`,
      ` data-option="${escapeHtml(opt.id)}">`,
      `<span class="opt-label">${escapeHtml(opt.label)}</span>`,
      isDefault ? `<span class="opt-default-tag">default</span>` : '',
      `</button>`,
    ].join('');
  }).join('');
  const context = (ctx ?? []).slice(0, 3).map((e) => [
    `<li class="ctx-event">`,
    `<span class="ctx-kind">${escapeHtml(e.kind)}</span>`,
    `<span class="ctx-source">${escapeHtml(e.source_agent)}</span>`,
    `<span class="ctx-summary">${escapeHtml(e.summary)}</span>`,
    `</li>`,
  ].join('')).join('');
  return [
    `<article class="decide-card" data-corr="${escapeHtml(d.correlation_id)}"`,
    ` data-expires="${expiresAt}" data-default="${escapeHtml(d.default_option_id ?? '')}">`,
    `<header class="decide-head">`,
    `<div class="decide-q">${escapeHtml(d.question)}</div>`,
    `<div class="decide-meta">`,
    renderPill({ text: 'awaiting', variant: 'warning' }),
    `<span class="decide-corr" title="${escapeHtml(d.correlation_id)}">${escapeHtml(shortCorr(d.correlation_id))}</span>`,
    `</div>`,
    `</header>`,
    `<div class="decide-timer-row">`,
    `<div class="decide-timer" data-role="timer">…</div>`,
    defaultOpt
      ? `<div class="decide-default">switches to <strong>${escapeHtml(defaultOpt.label)}</strong> on timeout</div>`
      : `<div class="decide-default decide-default-none">no default — timeout errors</div>`,
    `</div>`,
    `<div class="decide-opts">${buttons}</div>`,
    context
      ? `<details class="decide-ctx" open><summary>Context</summary><ol class="ctx-list">${context}</ol></details>`
      : `<details class="decide-ctx" data-role="ctx" data-loaded="false"><summary>Context</summary><ol class="ctx-list"><li class="ctx-empty">Loading…</li></ol></details>`,
    `</article>`,
  ].join('');
}

function renderResolvedCard(d: DecisionRecord): string {
  const chosen = d.chosen_option_id
    ? d.options.find((o) => o.id === d.chosen_option_id)?.label ?? d.chosen_option_id
    : '—';
  return [
    `<article class="resolved-card" data-corr="${escapeHtml(d.correlation_id)}">`,
    `<div class="resolved-head">`,
    renderPill({ text: d.status, variant: RESOLVED_PILL[d.status] }),
    `<span class="resolved-q">${escapeHtml(d.question)}</span>`,
    `</div>`,
    `<div class="resolved-body">`,
    `<span class="resolved-chosen">→ ${escapeHtml(chosen)}</span>`,
    d.responded_by ? `<span class="resolved-by">by ${escapeHtml(d.responded_by)}</span>` : '',
    d.response_reason ? `<span class="resolved-reason">${escapeHtml(d.response_reason)}</span>` : '',
    `</div>`,
    `</article>`,
  ].join('');
}

const DECIDE_CSS = `
.decide-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.decide-card {
  background: var(--bg-surface);
  border: 1px solid var(--risk-medium);
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 0 0 0 rgba(250,204,21,0.0);
  transition: box-shadow 0.3s ease;
}
.decide-card[data-urgent="true"] {
  box-shadow: 0 0 0 2px rgba(250,204,21,0.35);
  border-color: var(--risk-high);
}
.decide-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 10px;
}
.decide-q {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.decide-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.decide-corr {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  color: var(--text-dim);
}
.decide-timer-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
  font-size: 12px;
}
.decide-timer {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 16px;
  font-weight: 700;
  color: var(--risk-medium);
  padding: 2px 10px;
  border-radius: 5px;
  border: 1px solid var(--risk-medium);
  background: rgba(250,204,21,0.10);
}
.decide-timer[data-state="critical"] {
  color: var(--risk-high);
  border-color: var(--risk-high);
  background: rgba(239,68,68,0.10);
  animation: pulse 1.2s ease infinite;
}
.decide-timer[data-state="expired"] {
  color: var(--text-dim);
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
.decide-default { color: var(--text-secondary); }
.decide-default-none { color: var(--risk-high); font-weight: 600; }
.decide-opts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.opt-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  cursor: pointer;
  color: var(--text-primary);
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
}
.opt-btn:hover { background: var(--bg-hover); border-color: var(--accent-mcp); transform: translateY(-1px); }
.opt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.opt-btn.opt-default { border-color: var(--accent-mcp); }
.opt-label { font-size: 13px; font-weight: 600; }
.opt-default-tag {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent-mcp);
}
.decide-ctx {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.decide-ctx summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ctx-list {
  list-style: none;
  margin: 8px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ctx-event {
  display: grid;
  grid-template-columns: 140px 100px 1fr;
  gap: 8px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--bg-elevated);
}
.ctx-kind { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--accent-mcp); }
.ctx-source { color: var(--text-dim); }
.ctx-summary { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ctx-empty { color: var(--text-dim); font-style: italic; }

.section-h {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  margin: 28px 0 10px 0;
}
.resolved-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  opacity: 0.75;
}
.resolved-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
}
.resolved-head { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.resolved-q { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resolved-body {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: 11px;
}
.resolved-chosen { color: var(--text-primary); font-weight: 600; }
.empty-decide {
  padding: 50px 16px;
  text-align: center;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
}
`;

const DECIDE_JS = `
(function() {
  const root = document.querySelector('[data-role="decide-list"]');
  const liveStatus = document.querySelector('[data-role="live-status"]');
  if (!root) return;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- countdown timers ----------
  function tickTimers() {
    const now = Date.now();
    document.querySelectorAll('.decide-card').forEach(function(card) {
      const exp = Number(card.getAttribute('data-expires'));
      if (!exp) return;
      const remainMs = exp - now;
      const timer = card.querySelector('[data-role="timer"]');
      if (!timer) return;
      if (remainMs <= 0) {
        timer.textContent = 'expired';
        timer.setAttribute('data-state', 'expired');
        return;
      }
      const total = Math.floor(remainMs / 1000);
      const mm = Math.floor(total / 60);
      const ss = total % 60;
      timer.textContent = mm + ':' + (ss < 10 ? '0' + ss : ss);
      if (total <= 10) {
        timer.setAttribute('data-state', 'critical');
        card.setAttribute('data-urgent', 'true');
      } else if (total <= 30) {
        timer.setAttribute('data-state', 'warning');
      }
    });
  }
  tickTimers();
  setInterval(tickTimers, 1000);

  // ---------- option button → POST ----------
  root.addEventListener('click', async function(ev) {
    const btn = ev.target.closest('[data-role="respond"]');
    if (!btn) return;
    ev.preventDefault();
    const corr = btn.getAttribute('data-corr');
    const option = btn.getAttribute('data-option');
    const card = btn.closest('.decide-card');
    const opts = card ? card.querySelectorAll('.opt-btn') : [];
    opts.forEach(function(b) { b.setAttribute('disabled', ''); });
    try {
      const r = await fetch('/dashboard/decisions/' + encodeURIComponent(corr) + '/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chosen_option_id: option }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // Refresh the page rather than re-rendering — keeps the resolved
      // section logic in one place (server-side).
      window.location.reload();
    } catch (err) {
      opts.forEach(function(b) { b.removeAttribute('disabled'); });
      const msg = document.createElement('div');
      msg.className = 'decide-default decide-default-none';
      msg.textContent = 'Failed: ' + String(err);
      btn.parentElement.parentElement.appendChild(msg);
    }
  });

  // ---------- lazy-load context ----------
  document.querySelectorAll('[data-role="ctx"]').forEach(function(det) {
    det.addEventListener('toggle', async function() {
      if (!det.open || det.getAttribute('data-loaded') === 'true') return;
      const card = det.closest('.decide-card');
      const corr = card.getAttribute('data-corr');
      try {
        const r = await fetch('/dashboard/events?correlation_id=' + encodeURIComponent(corr) + '&limit=3');
        const data = await r.json();
        const list = det.querySelector('.ctx-list');
        list.innerHTML = '';
        (data.events || []).slice(0, 3).forEach(function(e) {
          const payload = e.payload || {};
          const summary = payload.message
            || payload.question
            || payload.title
            || (typeof payload === 'string' ? payload : JSON.stringify(payload).slice(0, 80));
          const li = document.createElement('li');
          li.className = 'ctx-event';
          li.innerHTML = '<span class="ctx-kind">' + escapeHtml(e.kind) + '</span>'
            + '<span class="ctx-source">' + escapeHtml(e.source_agent || '—') + '</span>'
            + '<span class="ctx-summary">' + escapeHtml(summary) + '</span>';
          list.appendChild(li);
        });
        if ((data.events || []).length === 0) {
          list.innerHTML = '<li class="ctx-empty">No related events yet.</li>';
        }
        det.setAttribute('data-loaded', 'true');
      } catch (err) {
        det.querySelector('.ctx-list').innerHTML = '<li class="ctx-empty">Failed to load.</li>';
      }
    });
  });

  // ---------- live refresh on decision events ----------
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function() { refreshTimer = null; window.location.reload(); }, 350);
  }
  try {
    const es = new EventSource('/dashboard/stream');
    es.addEventListener('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data && typeof data.kind === 'string'
            && (data.kind === 'decision_request' || data.kind === 'decision_response'
                || data.kind === 'await_decision' || data.kind.indexOf('decision_') === 0)) {
          scheduleRefresh();
        }
      } catch (_) { /* ignore */ }
    });
    es.addEventListener('open', function() {
      if (liveStatus) liveStatus.textContent = 'live · listening';
    });
    es.addEventListener('error', function() {
      if (liveStatus) liveStatus.textContent = 'live · reconnecting';
    });
  } catch (_) { /* fall through to no live updates */ }
})();
`;

export function renderDecidePage(data?: DecideData): string {
  const snapshot: DecideData = data ?? { open: [], resolved: [] };
  const openHtml = snapshot.open.length === 0
    ? `<div class="empty-decide">No open decisions. Stavr is unblocked.</div>`
    : snapshot.open
        .map((d) => renderOpenCard(d, snapshot.context?.[d.correlation_id]))
        .join('');
  const resolvedHtml = snapshot.resolved.length === 0
    ? ''
    : [
      `<h2 class="section-h">Recently resolved · last 24h</h2>`,
      `<div class="resolved-list">${snapshot.resolved.map(renderResolvedCard).join('')}</div>`,
    ].join('');

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Decide</h1>`,
    `<span class="page-sub" data-role="live-status">${snapshot.open.length} open · ${snapshot.resolved.length} recent</span>`,
    `</div>`,
    `<div class="decide-list" data-role="decide-list">${openHtml}</div>`,
    resolvedHtml,
  ].join('');

  return renderShell({
    title: 'Stavr — Decide',
    activePage: 'decide',
    body,
    head: `<style>${DECIDE_CSS}</style>`,
    script: DECIDE_JS,
  });
}
