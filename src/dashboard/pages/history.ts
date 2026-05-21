/**
 * /dashboard/history — v0.8 audit history dashboard.
 *
 * Server-renders the initial timeline at default range (24h) + tab (All)
 * using HistoryData supplied by transports.ts; the client-side JS handles
 * tab switching, range changes, search (P5), and "Load more" pagination.
 *
 * The page is a single `.glass` panel with:
 *   - Toolbar: range picker, tab strip, search input (P5)
 *   - Timeline: vertically-stacked rows from `renderHistoryRow`
 *   - Empty / pruned-history hints at the bottom edge
 *
 * Open questions §1-§6 conservative defaults (recorded in PR body):
 *   §1 retention: 30d per ADR-030; if the operator picks a deeper
 *      Custom range with no rows we render the pruned-history hint.
 *   §3 federation: local-only; sourceAgent filter shipped in P5.
 *   §4 live mode: explicit NOT in v0.8 — `/workers` is the live surface.
 *   §5 internal events: filtered out by default at the page boundary.
 *   §6 access: operator-only, existing auth model.
 */
import { renderShell } from '../shell.js';
import {
  renderHistoryRow,
  HISTORY_KIND_REGISTRY,
  HISTORY_TAB_ORDER,
  TIMELINE_ROW_CSS,
} from '../components/timeline-row.js';
import {
  renderRangePicker,
  RANGE_PICKER_CSS,
  RANGE_PICKER_JS,
  type RangePreset,
} from '../components/range-picker.js';
import {
  renderHistoryDrawerShell,
  HISTORY_DRAWER_CSS,
  HISTORY_DRAWER_JS,
} from '../components/history-drawer.js';
import { SOURCE_LINK_CSS } from '../components/source-link.js';
import {
  CORRELATION_THREAD_CSS,
  CORRELATION_THREAD_JS,
} from '../components/correlation-thread.js';
import type { HistoryItem, HistoryKind } from '../data/history/types.js';

export interface HistoryData {
  /** Initial timeline rows (24h range, All tab). */
  items: HistoryItem[];
  /** total_estimate across all sources (footnote text). */
  total_estimate: number;
  /** Active range preset on first paint. */
  range?: RangePreset;
  /** Whether the deepest source returned a next_cursor — drives "Load more". */
  has_more: boolean;
  /** Whether the page is beyond the retention boundary — shows hint. */
  pruned_boundary?: boolean;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTabStrip(activeTab: HistoryKind | 'all'): string {
  const all = `<button type="button" class="hist-tab${activeTab === 'all' ? ' active' : ''}" data-tab="all"${activeTab === 'all' ? ' aria-pressed="true"' : ''}>All</button>`;
  const tabs = HISTORY_TAB_ORDER.map((id) => {
    const meta = HISTORY_KIND_REGISTRY[id];
    const cur = id === activeTab ? ' aria-pressed="true"' : '';
    return `<button type="button" class="hist-tab${id === activeTab ? ' active' : ''}" data-tab="${escapeHtml(id)}"${cur}><span class="hist-tab-icon" style="color:${meta.color}">${meta.icon}</span><span class="hist-tab-label">${escapeHtml(meta.label)}</span></button>`;
  }).join('');
  return `<div class="hist-tabs" data-role="history-tabs">${all}${tabs}</div>`;
}

const HISTORY_CSS = `
.hist-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 14px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
}
.hist-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.hist-tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ink-1);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
}
.hist-tab-icon { font-size: 13px; }
.hist-tab:hover { background: rgba(255,255,255,0.04); color: var(--ink-0); }
.hist-tab.active {
  background: var(--rust-soft);
  color: #ffd9c4;
  border-color: rgba(184, 84, 42, 0.3);
}
.hist-search-wrap {
  flex: 1 1 200px;
  display: flex;
  justify-content: flex-end;
}
.hist-search {
  width: 100%;
  max-width: 280px;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-elevated, rgba(255,255,255,0.04));
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--ink-0);
  font-family: inherit;
}
.hist-search:focus { outline: 2px solid var(--rust-soft); outline-offset: 1px; }
.hist-actor-filter {
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-elevated, rgba(255,255,255,0.04));
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--ink-0);
  font-family: inherit;
}
.hist-reset {
  padding: 6px 10px;
  font-size: 11px;
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--ink-2);
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}
.hist-reset:hover { color: var(--ink-0); border-color: var(--line); }

.hist-panel {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
}
.hist-empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--ink-2);
}
.hist-empty strong {
  display: block;
  margin-bottom: 6px;
  color: var(--ink-0);
  font-size: 14px;
}
.hist-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  font-size: 11px;
  color: var(--ink-3);
}
.hist-load-more {
  background: var(--bg-elevated, rgba(255,255,255,0.04));
  border: 1px solid var(--line-2);
  border-radius: 6px;
  color: var(--ink-1);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.hist-load-more:hover { color: var(--ink-0); border-color: var(--line); }
.hist-load-more:disabled { opacity: 0.5; cursor: not-allowed; }
.hist-pruned {
  margin-top: 18px;
  padding: 14px;
  text-align: center;
  color: var(--ink-3);
  background: rgba(255,255,255,0.02);
  border: 1px dashed var(--line-2);
  border-radius: 8px;
  font-size: 12px;
}
`;

/**
 * Client JS — tab switching, range/search updates, load-more.
 *
 * The page server-renders an initial slice; XHR re-fetches happen via
 * GET /dashboard/api/history?since=&until=&tab=&search=&offset= which
 * transports.ts wires up.
 */
const HISTORY_JS = `
(function() {
  const panel = document.querySelector('[data-role="history-panel"]');
  if (!panel) return;
  const list = panel.querySelector('[data-role="history-list"]');
  const empty = panel.querySelector('[data-role="history-empty"]');
  const loadMore = panel.querySelector('[data-role="load-more"]');
  const totalEl = panel.querySelector('[data-role="history-total"]');
  const tabsEl = document.querySelector('[data-role="history-tabs"]');
  const rangeEl = document.querySelector('[data-role="range-picker"]');
  const searchEl = document.querySelector('[data-role="history-search"]');
  const actorEl = document.querySelector('[data-role="history-actor-filter"]');
  const resetEl = document.querySelector('[data-role="history-reset"]');

  // P5 — localStorage-backed filter persistence. Reading is best-effort
  // so a hard-locked Safari private mode doesn't crash the page.
  const LS_KEYS = {
    range: 'stavr.history.range',
    tab: 'stavr.history.tab',
    search: 'stavr.history.search',
    actor: 'stavr.history.actor_filter',
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsRemove(k) { try { localStorage.removeItem(k); } catch (_) {} }

  const state = {
    tab: lsGet(LS_KEYS.tab) || 'all',
    since: panel.getAttribute('data-since') || null,
    until: panel.getAttribute('data-until') || null,
    search: lsGet(LS_KEYS.search) || '',
    actor: lsGet(LS_KEYS.actor) || '',
    offset: Number(panel.getAttribute('data-offset') || '0'),
    limit: Number(panel.getAttribute('data-limit') || '100'),
    nextCursor: panel.getAttribute('data-next-cursor') || null,
  };

  // Restore tab UI to the saved state.
  if (state.tab !== 'all' && tabsEl) {
    const restoredBtn = tabsEl.querySelector('[data-tab="' + state.tab + '"]');
    if (restoredBtn) {
      tabsEl.querySelectorAll('.hist-tab').forEach(function(b) {
        const on = b === restoredBtn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
  }
  if (searchEl && state.search) searchEl.value = state.search;
  if (actorEl && state.actor) actorEl.value = state.actor;

  function applyClientFilter() {
    const q = (state.search || '').toLowerCase();
    const wantActor = state.actor || '';
    let visible = 0;
    list.querySelectorAll('.history-row').forEach(function(row) {
      const kind = row.getAttribute('data-kind');
      const text = (row.textContent || '').toLowerCase();
      const actor = (row.querySelector('.row-source') ? (row.querySelector('.row-source').textContent || '').replace(/[\\[\\]]/g, '').trim() : '');
      const matchTab = state.tab === 'all' || kind === state.tab;
      const matchSearch = q === '' || text.indexOf(q) !== -1;
      const matchActor = wantActor === '' || (actor && actor === wantActor);
      const show = matchTab && matchSearch && matchActor;
      row.hidden = !show;
      if (show) visible++;
    });
    if (empty) empty.hidden = visible !== 0;
  }

  tabsEl && tabsEl.addEventListener('click', function(ev) {
    const btn = ev.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.getAttribute('data-tab');
    lsSet(LS_KEYS.tab, state.tab);
    tabsEl.querySelectorAll('.hist-tab').forEach(function(b) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyClientFilter();
  });

  rangeEl && rangeEl.addEventListener('range:change', function(ev) {
    state.since = ev.detail.since;
    state.until = ev.detail.until;
    state.offset = 0;
    lsSet(LS_KEYS.range, rangeEl.getAttribute('data-active') || '24h');
    refetch(/* replace */ true);
  });

  let searchTimer = null;
  searchEl && searchEl.addEventListener('input', function() {
    state.search = searchEl.value || '';
    lsSet(LS_KEYS.search, state.search);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(applyClientFilter, 200);
  });

  actorEl && actorEl.addEventListener('change', function() {
    state.actor = actorEl.value || '';
    lsSet(LS_KEYS.actor, state.actor);
    applyClientFilter();
  });

  resetEl && resetEl.addEventListener('click', function() {
    state.tab = 'all';
    state.search = '';
    state.actor = '';
    lsRemove(LS_KEYS.tab);
    lsRemove(LS_KEYS.search);
    lsRemove(LS_KEYS.actor);
    lsRemove(LS_KEYS.range);
    if (searchEl) searchEl.value = '';
    if (actorEl) actorEl.value = '';
    if (tabsEl) {
      tabsEl.querySelectorAll('.hist-tab').forEach(function(b) {
        const on = b.getAttribute('data-tab') === 'all';
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    applyClientFilter();
  });

  loadMore && loadMore.addEventListener('click', function() {
    if (!state.nextCursor) return;
    state.offset = Number(state.nextCursor);
    refetch(/* replace */ false);
  });

  // Apply restored client filter once the page is wired.
  applyClientFilter();

  function refetch(replace) {
    const params = new URLSearchParams();
    if (state.since) params.set('since', state.since);
    if (state.until) params.set('until', state.until);
    params.set('offset', String(state.offset));
    params.set('limit', String(state.limit));
    loadMore && (loadMore.disabled = true);
    fetch('/dashboard/api/history?' + params.toString(), { headers: { accept: 'application/json' } })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        if (replace) list.innerHTML = '';
        data.items.forEach(function(item) {
          list.insertAdjacentHTML('beforeend', item.html);
        });
        state.nextCursor = data.next_cursor;
        if (totalEl) totalEl.textContent = String(data.total_estimate);
        applyClientFilter();
        if (loadMore) {
          loadMore.disabled = state.nextCursor === null;
          loadMore.style.display = state.nextCursor === null ? 'none' : '';
        }
      })
      .catch(function() {})
      .finally(function() { if (loadMore && state.nextCursor) loadMore.disabled = false; });
  }
})();
`;

export function renderHistoryPage(data?: HistoryData): string {
  const snapshot: HistoryData = data ?? {
    items: [],
    total_estimate: 0,
    range: '24h',
    has_more: false,
  };
  const rows = snapshot.items.map(renderHistoryRow).join('');
  const empty = snapshot.items.length === 0
    ? `<div class="hist-empty" data-role="history-empty"><strong>No history in this range.</strong>History begins when stavR records its first decision, scope, or BOM.</div>`
    : `<div class="hist-empty" data-role="history-empty" hidden></div>`;

  // Initial since/until — match the 24h preset by default. The client
  // recomputes on range change; this just gives the load-more endpoint
  // a starting point on first XHR.
  const now = new Date();
  const initialSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const initialUntil = now.toISOString();

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">History</h1>`,
    `<span class="page-sub"><span data-role="history-total">${snapshot.total_estimate}</span> entries · read-only audit view</span>`,
    `</div>`,
    `<div class="hist-toolbar">`,
    renderRangePicker({ active: snapshot.range ?? '24h' }),
    renderTabStrip('all'),
    `<div class="hist-search-wrap">`,
    `<input class="hist-search" type="search" data-role="history-search" placeholder="Search title, command, BOM name…" aria-label="Search history" />`,
    `<select class="hist-actor-filter" data-role="history-actor-filter" aria-label="Filter by actor">`,
    `<option value="">all actors</option>`,
    `<option value="operator">operator</option>`,
    `<option value="cc">cc</option>`,
    `<option value="steward-agent">steward-agent</option>`,
    `<option value="cowork-claude">cowork-claude</option>`,
    `<option value="dashboard">dashboard</option>`,
    `</select>`,
    `<button type="button" class="hist-reset" data-role="history-reset" aria-label="Reset filters">Reset</button>`,
    `</div>`,
    `</div>`,
    `<section class="hist-panel" data-role="history-panel"`,
    ` data-since="${escapeHtml(initialSince)}"`,
    ` data-until="${escapeHtml(initialUntil)}"`,
    ` data-offset="0"`,
    ` data-limit="100"`,
    ` data-next-cursor="${snapshot.has_more ? '100' : ''}">`,
    `<ul class="history-list" data-role="history-list">${rows}</ul>`,
    empty,
    `<div class="hist-footer">`,
    `<span>Showing ${snapshot.items.length} of <span data-role="history-total">${snapshot.total_estimate}</span></span>`,
    snapshot.has_more
      ? `<button type="button" class="hist-load-more" data-role="load-more">Load more ↓</button>`
      : '',
    `</div>`,
    snapshot.pruned_boundary
      ? `<div class="hist-pruned">Earlier history pruned — retention is ${escapeHtml(String(30))} days per ADR-030.</div>`
      : '',
    `</section>`,
    renderHistoryDrawerShell(),
  ].join('');

  const head = `<style>${HISTORY_CSS}\n${TIMELINE_ROW_CSS}\n${RANGE_PICKER_CSS}\n${HISTORY_DRAWER_CSS}\n${SOURCE_LINK_CSS}\n${CORRELATION_THREAD_CSS}</style>`;
  return renderShell({
    title: 'Stavr — History',
    activePage: 'history',
    body,
    head,
    script: `${RANGE_PICKER_JS}\n${HISTORY_JS}\n${HISTORY_DRAWER_JS}\n${CORRELATION_THREAD_JS}`,
  });
}
