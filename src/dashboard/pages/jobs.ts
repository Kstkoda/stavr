/**
 * Jobs page — multi-pane terminal view for live job output.
 *
 * One pane per running job, up to 20, in a 4-wide responsive grid. Each
 * pane shows the job name + binding kind/target + lifecycle pill and tails
 * the last few events. Top bar carries filters (kind / state / scope) and
 * a search box that substring-filters across panes.
 *
 * Live updates: every event on /dashboard/stream (the SSE event-stream
 * endpoint — distinct concept from this page) is appended to the matching
 * pane (matched on correlation_id == job.id OR event.payload.id == job.id
 * OR event.payload.job_id == job.id). Jobs with no output in N minutes
 * fade to half opacity.
 *
 * Historic split: non-active jobs fall into a collapsed details section,
 * bounded to the last 24h. Older runs live in the audit log; the Jobs page
 * is the 24h live view. A link in the historic section deep-links into
 * /dashboard/history for the rest.
 *
 * Phase 3c.1 of proposed/worker-dispatch-bom.md — renamed from
 * src/dashboard/pages/workers.ts; carries the same UX with JobRecord as
 * the data shape.
 */
import type { StoredEvent } from '../../persistence.js';
import type { JobRecord } from '../../jobs/types.js';
import { renderShell } from '../shell.js';
import { renderPill, type PillVariant } from '../components/pill.js';
import {
  deriveLifecycleState,
  isCurrentlyActive,
  lifecycleLabel,
  type JobLifecycleState,
} from '../../jobs/lifecycle.js';

export interface JobsData {
  jobs: JobRecord[];
  /** Map of jobId → last N events (most recent last). */
  recent: Record<string, StoredEvent[]>;
}

/**
 * Per-lifecycle pill variant for the job roster table — mirrors the
 * Topology page's halo mapping. Operator-kill reads distinct from a clean
 * exit per the BOM v0.6.6 P3 rule.
 */
const JOB_LIFECYCLE_PILL: Record<JobLifecycleState, PillVariant> = {
  'dispatched':         'info',
  'running':            'info',
  'completed-clean':    'success',
  'completed-error':    'warning',
  'killed-by-operator': 'warning',
  'killed-by-system':   'danger',
  'crashed':            'danger',
  'stale':              'warning',
};

function bindingLabel(j: JobRecord): string {
  return `${j.binding_kind}:${j.binding_target}`;
}

/**
 * Job roster table, lifted from the Topology page. Renders one row per
 * job with name + binding + lifecycle pill. Sits below the jobs grid as
 * the canonical "list of jobs" surface.
 */
function renderJobRoster(jobs: JobRecord[], now: number = Date.now()): string {
  if (jobs.length === 0) {
    return `<div class="jobs-roster-empty">No jobs running.</div>`;
  }
  return jobs.map((j) => {
    const lifecycle = deriveLifecycleState(j, now);
    const pill = renderPill({
      text: lifecycleLabel(lifecycle),
      variant: JOB_LIFECYCLE_PILL[lifecycle] ?? 'neutral',
    });
    return [
      `<li class="roster-row" data-id="${escapeHtml(j.id)}" data-lifecycle="${escapeHtml(lifecycle)}">`,
      `<span class="roster-name">${escapeHtml(j.name || j.id)}</span>`,
      `<span class="roster-type">${escapeHtml(bindingLabel(j))}</span>`,
      pill,
      `</li>`,
    ].join('');
  }).join('');
}

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

/**
 * Map lifecycle state to the pane border treatment + dot variant. Mirrors
 * the iron-palette mapping from helm.ts so panes read the same colour
 * across pages.
 */
function paneStateClass(state: JobLifecycleState): 'ok' | 'warn' | 'crit' | 'idle' {
  switch (state) {
    case 'dispatched':
    case 'running':
      return 'ok';
    case 'killed-by-operator':
    case 'stale':
    case 'completed-error':
      return 'warn';
    case 'killed-by-system':
    case 'crashed':
      return 'crit';
    case 'completed-clean':
    default:
      return 'idle';
  }
}

function renderPane(j: JobRecord, events: StoredEvent[], now: number): string {
  const lifecycle = deriveLifecycleState(j, now);
  const stateClass = paneStateClass(lifecycle);
  const pill = renderPill({
    text: lifecycleLabel(lifecycle),
    variant: JOB_LIFECYCLE_PILL[lifecycle] ?? 'neutral',
  });
  const lines = events.length === 0
    ? `<div class="line line-empty">No output yet.</div>`
    : events.slice(-8).map(eventLine).join('');
  const lastAt = events.length > 0 ? events[events.length - 1].at : (j.last_activity_at || j.started_at);
  return [
    `<article class="stream-pane" data-job-id="${escapeHtml(j.id)}"`,
    ` data-kind="${escapeHtml(j.binding_kind)}" data-target="${escapeHtml(j.binding_target)}"`,
    ` data-lifecycle="${escapeHtml(lifecycle)}" data-state="${escapeHtml(stateClass)}"`,
    ` data-last-at="${escapeHtml(lastAt ?? '')}">`,
    `<header class="pane-head">`,
    `<span class="pane-name">${escapeHtml(j.name || j.id)}</span>`,
    `<span class="pane-type">${escapeHtml(bindingLabel(j))}</span>`,
    pill,
    `</header>`,
    `<div class="pane-tail" data-role="tail">${lines}</div>`,
    `<button type="button" class="pane-expand" data-role="expand" data-id="${escapeHtml(j.id)}"`,
    ` aria-label="Open full tail">⤢</button>`,
    `</article>`,
  ].join('');
}

const JOBS_CSS = `
.jobs-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.jobs-search {
  flex: 1;
  min-width: 220px;
  padding: 7px 11px;
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
}
.jobs-search:focus { outline: 2px solid var(--accent-mcp); outline-offset: 1px; }
.filter-select {
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
}
.jobs-count {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.jobs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.stream-pane {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  min-height: 180px;
  position: relative;
  transition: opacity 0.2s ease, border-color 0.2s ease;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  overflow: hidden;
}
.stream-pane.quiet { opacity: 0.5; }
.stream-pane.hidden { display: none; }
.stream-pane[data-state="crit"] { border-color: var(--crit); }
.stream-pane[data-state="ok"]   { border-color: rgba(106,169,255,.35); }

.pane-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: rgba(255,255,255,.02);
  border-radius: 10px 10px 0 0;
}
.pane-name { font-size: 12px; font-weight: 500; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

.jobs-empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--ink-2);
  background: var(--bg-glass);
  border-radius: 12px;
  border: 1px dashed var(--line-2);
  backdrop-filter: blur(14px) saturate(140%);
}

.jobs-history { margin-top: 14px; }
.jobs-history-foot {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ink-3);
}
.jobs-history-link {
  color: var(--sky, var(--accent-mcp));
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}
.jobs-history-link:hover { color: var(--ink-0); }

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
  font-size: 22px;
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

.jobs-roster {
  margin-top: 18px;
  padding: 14px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.jobs-roster h2 { margin: 0 0 8px 0; }
.jobs-roster ul { list-style: none; padding: 0; margin: 0; }
.jobs-roster .roster-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
}
.jobs-roster .roster-row:last-child { border-bottom: 0; }
.jobs-roster .roster-name { color: var(--ink-0); }
.jobs-roster .roster-type {
  color: var(--ink-3);
  font-family: var(--mono);
  font-size: 11px;
}
.jobs-roster-empty {
  color: var(--ink-3);
  font-style: italic;
  font-size: 12px;
  padding: 8px 0;
}
`;

const QUIET_THRESHOLD_MS = 2 * 60 * 1000; // 2 min idle = quiet pane

const JOBS_JS = `
(function() {
  const grid = document.querySelector('[data-role="jobs-grid"]');
  if (!grid) return;

  const search    = document.querySelector('[data-role="search"]');
  const kindFilt  = document.querySelector('[data-role="filter-kind"]');
  const stateFilt = document.querySelector('[data-role="filter-state"]');
  const countEl   = document.querySelector('[data-role="visible-count"]');

  function applyFilters() {
    const q = (search && search.value || '').toLowerCase().trim();
    const wantKind = kindFilt && kindFilt.value || '*';
    const wantState = stateFilt && stateFilt.value || '*';
    let visible = 0;
    grid.querySelectorAll('.stream-pane').forEach(function(pane) {
      const text = pane.textContent.toLowerCase();
      const matchSearch = q === '' || text.indexOf(q) !== -1;
      const matchKind = wantKind === '*' || pane.getAttribute('data-kind') === wantKind;
      const matchState = wantState === '*' || pane.getAttribute('data-lifecycle') === wantState;
      const show = matchSearch && matchKind && matchState;
      pane.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    if (countEl) countEl.textContent = visible + ' visible';
  }
  if (search) search.addEventListener('input', applyFilters);
  if (kindFilt) kindFilt.addEventListener('change', applyFilters);
  if (stateFilt) stateFilt.addEventListener('change', applyFilters);
  applyFilters();

  // ---------- quiet treatment ----------
  function tickQuiet() {
    const now = Date.now();
    grid.querySelectorAll('.stream-pane').forEach(function(pane) {
      const lastAt = Date.parse(pane.getAttribute('data-last-at') || '');
      const quiet = Number.isFinite(lastAt) && now - lastAt > ${QUIET_THRESHOLD_MS};
      pane.classList.toggle('quiet', quiet && pane.getAttribute('data-state') !== 'crit');
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
    const empty = tail.querySelector('.line-empty');
    if (empty) tail.removeChild(empty);
    tail.appendChild(div);
    while (tail.children.length > 30) tail.removeChild(tail.firstChild);
    tail.scrollTop = tail.scrollHeight;
    pane.setAttribute('data-last-at', new Date().toISOString());
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  if (window.__stavrStream) {
    window.__stavrStream.on('event', function(ev) {
      try {
        const data = JSON.parse(ev.data || '{}');
        // Match a pane on correlation_id, payload.id (job_started / progress /
        // heartbeat / metadata / error / terminated), or payload.job_id (job_log).
        const payload = data && data.payload || {};
        const jobId = (data && data.correlation_id) || payload.id || payload.job_id || null;
        if (!jobId) return;
        const pane = grid.querySelector('[data-job-id="' + String(jobId).replace(/"/g, '\\\\"') + '"]');
        if (pane) appendLine(pane, data);
      } catch (_) { /* ignore */ }
    });
  }
})();
`;

/**
 * 24h cutoff for the historic section. Older runs drop off the page; the
 * audit-history dashboard is the canonical surface for anything past this
 * window.
 */
const HISTORIC_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Most recent timestamp on a non-active job record. Falls back through
 * `ended_at → last_activity_at → started_at`. Returns NaN when no parseable
 * timestamp exists (caller decides whether NaN means "drop" or "keep" —
 * here we drop).
 */
function historicTimestampMs(j: JobRecord): number {
  const raw = j.ended_at ?? j.last_activity_at ?? j.started_at;
  if (!raw) return NaN;
  return Date.parse(raw);
}

export function renderJobsPage(data?: JobsData): string {
  const snapshot: JobsData = data ?? { jobs: [], recent: {} };

  // BOM v0.6.6 P3 — primary view shows ONLY currently-active job panes.
  // Historic panes move to a collapsible section below the grid, bounded
  // to 24h.
  const now = Date.now();
  const cutoffMs = now - HISTORIC_WINDOW_MS;
  const active: JobRecord[] = [];
  const historic: JobRecord[] = [];
  for (const j of snapshot.jobs) {
    const state = deriveLifecycleState(j, now);
    if (isCurrentlyActive(state)) {
      active.push(j);
      continue;
    }
    const ts = historicTimestampMs(j);
    if (Number.isFinite(ts) && ts >= cutoffMs) historic.push(j);
  }

  // Cap visible (active) jobs at 20 — beyond that the grid is unusable.
  const visible = active.slice(0, 20);
  const kinds = Array.from(new Set(active.map((j) => j.binding_kind))).sort();
  const states: JobLifecycleState[] = ['running', 'dispatched', 'stale', 'crashed', 'completed-clean', 'completed-error', 'killed-by-operator', 'killed-by-system'];

  const panes = visible.length === 0
    ? `<div class="jobs-empty">No jobs running. Job panes will appear here once stavr dispatches a job.</div>`
    : visible.map((j) => renderPane(j, snapshot.recent[j.id] ?? [], now)).join('');

  const historyLink = `<a class="jobs-history-link" href="/dashboard/history">Older runs → /dashboard/history</a>`;
  const historicPanes = historic.length === 0
    ? ''
    : [
        `<details class="jobs-history" data-role="jobs-history">`,
        `<summary>History · last 24h · ${historic.length} pane${historic.length === 1 ? '' : 's'}</summary>`,
        `<div class="jobs-grid">${historic.slice(0, 40).map((j) => renderPane(j, snapshot.recent[j.id] ?? [], now)).join('')}</div>`,
        `<div class="jobs-history-foot">${historyLink}</div>`,
        `</details>`,
      ].join('');

  const kindOptions = ['<option value="*">all kinds</option>']
    .concat(kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`))
    .join('');
  const stateOptions = ['<option value="*">all states</option>']
    .concat(states.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`))
    .join('');

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Jobs</h1>`,
    `<span class="page-sub" data-role="jobs-header">${visible.length} active pane${visible.length === 1 ? '' : 's'}${active.length > 20 ? ` · capped at 20 of ${active.length}` : ''}${historic.length > 0 ? ` · ${historic.length} historic (24h)` : ''}</span>`,
    `</div>`,
    `<div class="jobs-toolbar">`,
    `<input class="jobs-search" data-role="search" type="search" placeholder="Search across panes…" aria-label="Search job output" />`,
    `<select class="filter-select" data-role="filter-kind" aria-label="Filter by binding kind">${kindOptions}</select>`,
    `<select class="filter-select" data-role="filter-state" aria-label="Filter by lifecycle state">${stateOptions}</select>`,
    `<span class="jobs-count" data-role="visible-count">${visible.length} visible</span>`,
    `</div>`,
    `<div class="jobs-grid" data-role="jobs-grid">${panes}</div>`,
    historicPanes,
    `<section class="jobs-roster glass" data-role="jobs-roster">`,
    `<h2 class="card-title">Job roster</h2>`,
    `<ul>`,
    renderJobRoster([...active, ...historic], now),
    `</ul>`,
    `</section>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Jobs',
    activePage: 'jobs',
    body,
    head: `<style>${JOBS_CSS}</style>`,
    script: JOBS_JS,
  });
}
