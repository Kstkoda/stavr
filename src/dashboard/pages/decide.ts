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
  // v0.6 Task 4 Phase D — expand row to surface the full decision
  // record so the operator can audit a past decision in-place rather
  // than digging through the event log.
  const requestedMs = d.requested_at ? Date.parse(d.requested_at) : NaN;
  const respondedMs = d.responded_at ? Date.parse(d.responded_at) : NaN;
  const elapsedStr =
    Number.isFinite(requestedMs) && Number.isFinite(respondedMs)
      ? formatElapsed(respondedMs - requestedMs)
      : null;
  const defaultLabel = d.default_option_id
    ? d.options.find((o) => o.id === d.default_option_id)?.label ?? d.default_option_id
    : null;
  // Best-effort cross-link surfaces:
  //   - PR-shaped decisions get a "View PR" affordance when the
  //     question text contains a github.com/<owner>/<repo>/pull/<n> URL
  //   - Trust-scope-shaped decisions get a "View scope" affordance when
  //     the question references a `ts-*` scope id
  const prMatch = /https?:\/\/github\.com\/[^\s)\]]+\/pull\/\d+/i.exec(d.question);
  const scopeMatch = /\bts-[a-zA-Z0-9._-]+\b/.exec(d.question);
  const crossLinks: string[] = [];
  if (prMatch) {
    crossLinks.push(
      `<a class="resolved-link" href="${escapeHtml(prMatch[0])}" target="_blank" rel="noopener">View PR ↗</a>`,
    );
  }
  if (scopeMatch) {
    crossLinks.push(
      `<a class="resolved-link" href="/dashboard/capabilities?scope=${encodeURIComponent(scopeMatch[0])}">View scope</a>`,
    );
  }
  const optionsList = d.options
    .map((o) => {
      const isChosen = d.chosen_option_id === o.id;
      const isDefault = d.default_option_id === o.id;
      const flags: string[] = [];
      if (isChosen) flags.push('chosen');
      if (isDefault) flags.push('default');
      return [
        `<li class="resolved-opt${flags.length ? ' resolved-opt-' + flags.join('-') : ''}">`,
        `<code>${escapeHtml(o.id)}</code>`,
        ` — ${escapeHtml(o.label)}`,
        flags.length ? ` <span class="resolved-opt-flag">(${flags.join(' · ')})</span>` : '',
        `</li>`,
      ].join('');
    })
    .join('');
  return [
    `<details class="resolved-card" data-corr="${escapeHtml(d.correlation_id)}" data-role="resolved-card">`,
    `<summary class="resolved-summary">`,
    `<div class="resolved-head">`,
    renderPill({ text: d.status, variant: RESOLVED_PILL[d.status] }),
    `<span class="resolved-q" title="${escapeHtml(d.question)}">${escapeHtml(d.question)}</span>`,
    `</div>`,
    `<div class="resolved-body">`,
    `<span class="resolved-chosen">→ ${escapeHtml(chosen)}</span>`,
    d.responded_by ? `<span class="resolved-by">by ${escapeHtml(d.responded_by)}</span>` : '',
    elapsedStr ? `<span class="resolved-elapsed">in ${escapeHtml(elapsedStr)}</span>` : '',
    `</div>`,
    `</summary>`,
    `<div class="resolved-detail">`,
    `<dl class="resolved-meta">`,
    `<dt>Correlation id</dt><dd><code>${escapeHtml(d.correlation_id)}</code></dd>`,
    `<dt>Requested at</dt><dd>${escapeHtml(d.requested_at || '—')}</dd>`,
    `<dt>Deadline</dt><dd>${d.timeout_sec}s · expires ${escapeHtml(d.expires_at || '—')}</dd>`,
    d.responded_at
      ? `<dt>Responded at</dt><dd>${escapeHtml(d.responded_at)}${elapsedStr ? ` <span class="resolved-elapsed">(${escapeHtml(elapsedStr)})</span>` : ''}</dd>`
      : '',
    d.responded_by ? `<dt>Responder</dt><dd>${escapeHtml(d.responded_by)}</dd>` : '',
    d.chosen_option_id ? `<dt>Chosen option</dt><dd><code>${escapeHtml(d.chosen_option_id)}</code> — ${escapeHtml(chosen)}</dd>` : '',
    defaultLabel ? `<dt>Default option</dt><dd><code>${escapeHtml(d.default_option_id!)}</code> — ${escapeHtml(defaultLabel)}</dd>` : '',
    d.response_reason ? `<dt>Reason</dt><dd>${escapeHtml(d.response_reason)}</dd>` : '',
    `</dl>`,
    `<div class="resolved-options"><div class="resolved-options-head">Options offered</div><ul class="resolved-options-list">${optionsList}</ul></div>`,
    crossLinks.length > 0
      ? `<div class="resolved-links">${crossLinks.join('')}</div>`
      : '',
    `</div>`,
    `</details>`,
  ].join('');
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
}

const DECIDE_CSS = `
.decide-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.decide-card {
  background: var(--bg-glass);
  border: 1px solid rgba(226,169,66,.35);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 0 0 0 rgba(226,169,66,0.0);
  transition: box-shadow 0.3s ease;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
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
/* v0.6 Task 4 Phase D — resolved decisions are now <details> with the
 * collapsed summary keeping the original single-line layout. */
.resolved-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 12px;
  overflow: hidden;
}
.resolved-summary {
  list-style: none;
  cursor: pointer;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.resolved-summary::-webkit-details-marker { display: none; }
.resolved-summary::before {
  content: '▸';
  color: var(--text-dim);
  font-size: 10px;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}
.resolved-card[open] > .resolved-summary::before { transform: rotate(90deg); }
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
.resolved-elapsed { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.resolved-detail {
  padding: 0 12px 12px 28px;
  border-top: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.resolved-meta {
  display: grid;
  grid-template-columns: 130px 1fr;
  row-gap: 4px;
  column-gap: 12px;
  margin: 10px 0 0 0;
  font-size: 11px;
}
.resolved-meta dt { color: var(--text-dim); }
.resolved-meta dd { color: var(--text-primary); margin: 0; }
.resolved-meta code { font-family: var(--font-mono); font-size: 10.5px; }
.resolved-options-head {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.resolved-options-list {
  margin: 4px 0 0 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--text-secondary);
}
.resolved-opt-chosen { color: var(--text-primary); font-weight: 600; }
.resolved-opt-flag { color: var(--text-dim); font-size: 10px; }
.resolved-links { display: flex; gap: 10px; }
.resolved-link {
  color: #4ea2d8;
  text-decoration: none;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(78, 162, 216, 0.08);
}
.resolved-link:hover { background: rgba(78, 162, 216, 0.18); }
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
    refreshTimer = (window.__stavrCleanup ? window.__stavrCleanup.setTimeout : setTimeout)(function() {
      refreshTimer = null;
      window.location.reload();
    }, 350);
  }
  if (window.__stavrStream) {
    window.__stavrStream.on('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data && typeof data.kind === 'string'
            && (data.kind === 'decision_request' || data.kind === 'decision_response'
                || data.kind === 'await_decision' || data.kind.indexOf('decision_') === 0)) {
          scheduleRefresh();
        }
      } catch (_) { /* ignore */ }
    });
    window.__stavrStream.on('open', function() {
      if (liveStatus) liveStatus.textContent = 'live · listening';
    });
    window.__stavrStream.on('error', function() {
      if (liveStatus) liveStatus.textContent = 'live · reconnecting';
    });
  }
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
