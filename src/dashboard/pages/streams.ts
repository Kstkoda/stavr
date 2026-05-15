/**
 * Streams page — multi-pane terminal view for live worker output.
 *
 * One pane per running worker, up to 20, in a 4-wide responsive grid.
 * Each pane shows the worker name + type + status pill and tails the
 * last few events. Top bar carries filters (type / status / scope) and
 * a search box that substring-filters across panes.
 *
 * Live updates: every event on /dashboard/stream is appended to the
 * matching pane (matched on correlation_id == worker.id OR
 * event.payload.id == worker.id). Workers with no output in N minutes
 * fade to half opacity.
 */
import type { WorkerRecord, StoredEvent } from '../../persistence.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';

export interface StreamsData {
  workers: WorkerRecord[];
  /** Map of workerId → last N events (most recent last). */
  recent: Record<string, StoredEvent[]>;
}

const STATUS_PILL: Record<WorkerRecord['status'], PillVariant> = {
  starting:   'info',
  running:    'info',
  idle:       'success',
  terminated: 'neutral',
  crashed:    'danger',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function eventLine(ev: StoredEvent): string {
  const payload = ev.payload as Record<string, unknown> | null;
  let msg = '';
  if (payload && typeof payload === 'object') {
    msg = String(payload.message ?? payload.title ?? payload.command ?? JSON.stringify(payload).slice(0, 160));
  } else {
    msg = String(payload ?? '');
  }
  return [
    `<div class="line" data-kind="${escapeHtml(ev.kind)}">`,
    `<span class="line-time">${escapeHtml(ev.at?.slice(11, 19) ?? '')}</span>`,
    `<span class="line-kind">${escapeHtml(ev.kind)}</span>`,
    `<span class="line-msg">${escapeHtml(msg)}</span>`,
    `</div>`,
  ].join('');
}

function renderPane(w: WorkerRecord, events: StoredEvent[]): string {
  const status = w.status;
  const pill = renderPill({ text: status, variant: STATUS_PILL[status] });
  const lines = events.length === 0
    ? `<div class="line line-empty">No output yet.</div>`
    : events.slice(-8).map(eventLine).join('');
  const lastAt = events.length > 0 ? events[events.length - 1].at : (w.last_activity_at || w.started_at);
  return [
    `<article class="stream-pane" data-worker-id="${escapeHtml(w.id)}"`,
    ` data-type="${escapeHtml(w.type)}" data-status="${escapeHtml(status)}"`,
    ` data-last-at="${escapeHtml(lastAt ?? '')}">`,
    `<header class="pane-head">`,
    `<span class="pane-name">${escapeHtml(w.name || w.id)}</span>`,
    `<span class="pane-type">${escapeHtml(w.type)}</span>`,
    pill,
    `</header>`,
    `<div class="pane-tail" data-role="tail">${lines}</div>`,
    `<button type="button" class="pane-expand" data-role="expand" data-id="${escapeHtml(w.id)}"`,
    ` aria-label="Open full tail">⤢</button>`,
    `</article>`,
  ].join('');
}

const STREAMS_CSS = `
.streams-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.streams-search {
  flex: 1;
  min-width: 220px;
  padding: 7px 11px;
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  color: var(--text-primary);
  font-family: inherit;
}
.streams-search:focus { outline: 2px solid var(--accent-mcp); outline-offset: 1px; }
.filter-select {
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  color: var(--text-primary);
  font-family: inherit;
}
.streams-count {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.streams-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.stream-pane {
  background: #07080b;
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  min-height: 180px;
  position: relative;
  transition: opacity 0.2s ease, border-color 0.2s ease;
}
.stream-pane.quiet { opacity: 0.5; }
.stream-pane.hidden { display: none; }
.stream-pane[data-status="crashed"] { border-color: var(--risk-high); }
.stream-pane[data-status="running"] { border-color: var(--accent-mcp); }

.pane-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  border-radius: 8px 8px 0 0;
}
.pane-name { font-size: 12px; font-weight: 600; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-type {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}
.pane-tail {
  flex: 1;
  overflow-y: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
}
.line {
  display: grid;
  grid-template-columns: 70px 100px 1fr;
  gap: 6px;
  line-height: 1.4;
}
.line-time { color: var(--text-dim); }
.line-kind { color: var(--accent-mcp); }
.line-msg { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.line-empty { color: var(--text-dim); font-style: italic; }

.pane-expand {
  position: absolute;
  top: 8px;
  right: 8px;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
}
.pane-expand:hover { color: var(--text-primary); }

.streams-empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-radius: 10px;
  border: 1px dashed var(--border-strong);
}

.fullscreen-tail {
  position: fixed;
  inset: 0;
  background: #07080b;
  z-index: 60;
  display: flex;
  flex-direction: column;
  padding: 30px;
}
.fullscreen-tail .close-btn {
  position: absolute;
  top: 20px;
  right: 24px;
  font-size: 28px;
  background: transparent;
  border: 0;
  color: var(--text-secondary);
  cursor: pointer;
}
.fullscreen-tail h2 {
  margin: 0 0 20px 0;
  font-size: 18px;
  color: var(--text-primary);
}
.fullscreen-tail .pane-tail {
  flex: 1;
  max-height: none;
  font-size: 13px;
}
`;

const QUIET_THRESHOLD_MS = 2 * 60 * 1000; // 2 min idle = quiet pane

const STREAMS_JS = `
(function() {
  const grid = document.querySelector('[data-role="streams-grid"]');
  if (!grid) return;

  const search    = document.querySelector('[data-role="search"]');
  const typeFilt  = document.querySelector('[data-role="filter-type"]');
  const statusFilt = document.querySelector('[data-role="filter-status"]');
  const countEl   = document.querySelector('[data-role="visible-count"]');

  function applyFilters() {
    const q = (search && search.value || '').toLowerCase().trim();
    const wantType = typeFilt && typeFilt.value || '*';
    const wantStatus = statusFilt && statusFilt.value || '*';
    let visible = 0;
    grid.querySelectorAll('.stream-pane').forEach(function(pane) {
      const text = pane.textContent.toLowerCase();
      const matchSearch = q === '' || text.indexOf(q) !== -1;
      const matchType = wantType === '*' || pane.getAttribute('data-type') === wantType;
      const matchStatus = wantStatus === '*' || pane.getAttribute('data-status') === wantStatus;
      const show = matchSearch && matchType && matchStatus;
      pane.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    if (countEl) countEl.textContent = visible + ' visible';
  }
  if (search) search.addEventListener('input', applyFilters);
  if (typeFilt) typeFilt.addEventListener('change', applyFilters);
  if (statusFilt) statusFilt.addEventListener('change', applyFilters);
  applyFilters();

  // ---------- quiet treatment ----------
  function tickQuiet() {
    const now = Date.now();
    grid.querySelectorAll('.stream-pane').forEach(function(pane) {
      const lastAt = Date.parse(pane.getAttribute('data-last-at') || '');
      const quiet = Number.isFinite(lastAt) && now - lastAt > ${QUIET_THRESHOLD_MS};
      pane.classList.toggle('quiet', quiet && pane.getAttribute('data-status') !== 'crashed');
    });
  }
  tickQuiet();
  setInterval(tickQuiet, 15_000);

  // ---------- expand pane → fullscreen ----------
  grid.addEventListener('click', function(ev) {
    const btn = ev.target.closest('[data-role="expand"]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const pane = btn.closest('.stream-pane');
    if (!pane) return;
    const fs = document.createElement('div');
    fs.className = 'fullscreen-tail';
    fs.innerHTML = '<button type="button" class="close-btn" aria-label="Close">×</button>'
      + '<h2>' + (pane.querySelector('.pane-name').textContent || id) + '</h2>'
      + '<div class="pane-tail">' + pane.querySelector('.pane-tail').innerHTML + '</div>';
    document.body.appendChild(fs);
    fs.querySelector('.close-btn').addEventListener('click', function() { document.body.removeChild(fs); });
  });

  // ---------- live updates ----------
  function appendLine(pane, ev) {
    const tail = pane.querySelector('.pane-tail');
    if (!tail) return;
    const time = (ev.at || '').slice(11, 19);
    const payload = ev.payload || {};
    const msg = String(payload.message || payload.title || payload.command || JSON.stringify(payload).slice(0, 160));
    const div = document.createElement('div');
    div.className = 'line';
    div.setAttribute('data-kind', ev.kind || '');
    div.innerHTML = '<span class="line-time">' + esc(time) + '</span>'
      + '<span class="line-kind">' + esc(ev.kind || '') + '</span>'
      + '<span class="line-msg">' + esc(msg) + '</span>';
    // Drop the empty placeholder if it's still there.
    const empty = tail.querySelector('.line-empty');
    if (empty) tail.removeChild(empty);
    tail.appendChild(div);
    // Keep tail length bounded.
    while (tail.children.length > 30) tail.removeChild(tail.firstChild);
    tail.scrollTop = tail.scrollHeight;
    pane.setAttribute('data-last-at', new Date().toISOString());
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  try {
    const es = new EventSource('/dashboard/stream');
    es.addEventListener('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        const workerId = (data && (data.correlation_id || (data.payload && data.payload.id))) || null;
        if (!workerId) return;
        const pane = grid.querySelector('[data-worker-id="' + workerId.replace(/"/g, '\\\\"') + '"]');
        if (pane) appendLine(pane, data);
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* no live */ }
})();
`;

export function renderStreamsPage(data?: StreamsData): string {
  const snapshot: StreamsData = data ?? { workers: [], recent: {} };

  // Cap visible workers at 20 — beyond that the grid is unusable.
  const visible = snapshot.workers.slice(0, 20);
  const types = Array.from(new Set(visible.map((w) => w.type))).sort();
  const statuses: WorkerRecord['status'][] = ['running', 'idle', 'starting', 'crashed', 'terminated'];

  const panes = visible.length === 0
    ? `<div class="streams-empty">No workers running. Streams will appear here once stavr spawns a worker.</div>`
    : visible.map((w) => renderPane(w, snapshot.recent[w.id] ?? [])).join('');

  const typeOptions = ['<option value="*">all types</option>']
    .concat(types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`))
    .join('');
  const statusOptions = ['<option value="*">all statuses</option>']
    .concat(statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`))
    .join('');

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Streams</h1>`,
    `<span class="page-sub">${visible.length} pane${visible.length === 1 ? '' : 's'}${snapshot.workers.length > 20 ? ` · capped at 20 of ${snapshot.workers.length}` : ''}</span>`,
    `</div>`,
    `<div class="streams-toolbar">`,
    `<input class="streams-search" data-role="search" type="search" placeholder="Search across panes…" aria-label="Search worker output" />`,
    `<select class="filter-select" data-role="filter-type" aria-label="Filter by type">${typeOptions}</select>`,
    `<select class="filter-select" data-role="filter-status" aria-label="Filter by status">${statusOptions}</select>`,
    `<span class="streams-count" data-role="visible-count">${visible.length} visible</span>`,
    `</div>`,
    `<div class="streams-grid" data-role="streams-grid">${panes}</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Streams',
    activePage: 'streams',
    body,
    head: `<style>${STREAMS_CSS}</style>`,
    script: STREAMS_JS,
  });
}
