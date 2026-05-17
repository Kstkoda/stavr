/**
 * Tools page — `/dashboard/tools`. Browse the full set of MCP tools stavR
 * has registered with the operator's permissions / risk lens. Closes the
 * audit question: "how many tools do i have available in stavr, i see
 * nothing about that anywhere" (2026-05-17).
 *
 * v0.6.9 PR #1 scope (this commit):
 *   - Renders one card per registered tool: id, category chip, default
 *     tier pill, reversibility tag, description.
 *   - Toolbar: free-text search, category filter, tier filter.
 *   - Header counts: total registered + per-category breakdown.
 *
 * Deferred to PR #2:
 *   - Last-24h invocation counts + top callers (needs `tool_invoked`
 *     event kind from the runtime authorisation gate).
 *   - Click-card-to-drawer with full metadata + caller breakdown.
 *
 * The page reads from `ToolsData` (populated by `fetchToolsData(registry)`
 * in `transports.ts`); see `src/dashboard/data/tools-data.ts`.
 */
import { renderShell } from '../shell.js';
import type { ToolsData, ToolRow } from '../data/tools-data.js';
import type { Tier, ToolCategory } from '../../tools/categories.js';
import { emptyToolsData } from '../data/tools-data.js';

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  worker: 'Workers',
  scope: 'Trust scopes',
  github: 'GitHub',
  steward: 'Steward',
  credentials: 'Credentials',
  subscription: 'Subscriptions',
  event: 'Events',
  decision: 'Decisions',
  shell: 'Shell',
  plan: 'Planning',
  other: 'Other',
};

const TIER_LABELS: Record<Tier, string> = {
  AUTO: 'AUTO',
  CONFIRM: 'CONFIRM',
  EXPLICIT: 'EXPLICIT',
  NO_GO: 'NO-GO',
};

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  AUTO: 'Executes without operator interaction',
  CONFIRM: 'Operator clicks Confirm before each call',
  EXPLICIT: 'Operator types a friction string before each call',
  NO_GO: 'Cannot execute from this actor regardless of scope',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderToolCard(t: ToolRow): string {
  const desc = t.description.trim() || 'No description provided.';
  const callsCell = t.callsLast24h == null
    ? `<span class="tools-calls-pending" title="Per-tool invocation tracking lands in v0.6.9 PR #2">—</span>`
    : `<span class="tools-calls">${t.callsLast24h}</span>`;
  return [
    `<article class="tools-card"`,
    ` data-id="${escapeHtml(t.id)}"`,
    ` data-category="${escapeHtml(t.category)}"`,
    ` data-tier="${escapeHtml(t.defaultTier)}"`,
    ` data-reversibility="${escapeHtml(t.reversibility)}"`,
    ` data-search="${escapeHtml((t.id + ' ' + t.description + ' ' + t.category).toLowerCase())}"`,
    `>`,
    `<header class="tools-card-head">`,
    `<code class="tools-id">${escapeHtml(t.id)}</code>`,
    `<span class="tools-cat tools-cat-${escapeHtml(t.category)}">${escapeHtml(CATEGORY_LABELS[t.category])}</span>`,
    `</header>`,
    `<p class="tools-desc">${escapeHtml(desc)}</p>`,
    `<footer class="tools-card-foot">`,
    `<span class="tools-tier tools-tier-${escapeHtml(t.defaultTier)}"`,
    ` title="${escapeHtml(TIER_DESCRIPTIONS[t.defaultTier])}">`,
    `${escapeHtml(TIER_LABELS[t.defaultTier])}</span>`,
    `<span class="tools-rev tools-rev-${escapeHtml(t.reversibility)}">${escapeHtml(t.reversibility)}</span>`,
    `<span class="tools-calls-wrap">calls 24h: ${callsCell}</span>`,
    `</footer>`,
    `</article>`,
  ].join('');
}

const TOOLS_CSS = `
.tools-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}
.tools-head .tools-counts {
  color: var(--ink-dim);
  font-size: 13px;
}
.tools-pending-banner {
  background: rgba(250, 156, 76, 0.08);
  border: 1px solid rgba(250, 156, 76, 0.3);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--ink-dim);
  font-size: 13px;
  margin-bottom: 12px;
}
.tools-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.tools-toolbar input,
.tools-toolbar select {
  background: rgba(20, 22, 31, 0.55);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--ink);
  font-size: 13px;
}
.tools-toolbar input[type="search"] {
  flex: 1 1 240px;
}
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.tools-card {
  background: rgba(20, 22, 31, 0.55);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  backdrop-filter: blur(14px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tools-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.tools-id {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tools-cat {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--ink-dim);
  white-space: nowrap;
}
.tools-desc {
  margin: 0;
  color: var(--ink-dim);
  font-size: 12px;
  line-height: 1.4;
}
.tools-card-foot {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 11px;
}
.tools-tier {
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
}
.tools-tier-AUTO     { background: rgba(126, 211, 102, 0.18); color: #7ed366; }
.tools-tier-CONFIRM  { background: rgba(78, 162, 216, 0.18); color: #4ea2d8; }
.tools-tier-EXPLICIT { background: rgba(250, 156, 76, 0.18); color: #fa9c4c; }
.tools-tier-NO_GO    { background: rgba(216, 78, 78, 0.18); color: #d84e4e; }
.tools-rev {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--ink-dim);
}
.tools-rev-irreversible {
  background: rgba(216, 78, 78, 0.10);
  color: #d84e4e;
}
.tools-calls-wrap {
  margin-left: auto;
  color: var(--ink-dim);
}
.tools-calls-pending {
  color: var(--ink-dim);
  font-style: italic;
}
`;

const TOOLS_JS = `
(function () {
  const search = document.querySelector('[data-role="tools-search"]');
  const catSel = document.querySelector('[data-role="tools-cat"]');
  const tierSel = document.querySelector('[data-role="tools-tier"]');
  const grid = document.querySelector('[data-role="tools-grid"]');

  function applyFilter() {
    if (!grid) return;
    const q = (search && search.value || '').trim().toLowerCase();
    const c = catSel && catSel.value || '';
    const t = tierSel && tierSel.value || '';
    const cards = Array.from(grid.querySelectorAll('.tools-card'));
    cards.forEach(function (card) {
      if (c && card.getAttribute('data-category') !== c) {
        card.style.display = 'none';
        return;
      }
      if (t && card.getAttribute('data-tier') !== t) {
        card.style.display = 'none';
        return;
      }
      if (q) {
        const hay = card.getAttribute('data-search') || '';
        if (hay.indexOf(q) < 0) {
          card.style.display = 'none';
          return;
        }
      }
      card.style.display = '';
    });
  }

  if (search) search.addEventListener('input', applyFilter);
  if (catSel) catSel.addEventListener('change', applyFilter);
  if (tierSel) tierSel.addEventListener('change', applyFilter);
})();
`;

export function renderToolsPage(data?: ToolsData): string {
  const d = data ?? emptyToolsData();
  const cards = d.tools.map(renderToolCard).join('');
  const catOptions = (Object.keys(CATEGORY_LABELS) as ToolCategory[])
    .filter((c) => d.byCategory.some((b) => b.category === c))
    .map((c) => {
      const cnt = d.byCategory.find((b) => b.category === c)?.count ?? 0;
      return `<option value="${c}">${escapeHtml(CATEGORY_LABELS[c])} · ${cnt}</option>`;
    })
    .join('');
  const tierOptions = (Object.keys(TIER_LABELS) as Tier[])
    .map((t) => `<option value="${t}">${escapeHtml(TIER_LABELS[t])}</option>`)
    .join('');

  const banner = d.invocationTrackingEnabled
    ? ''
    : `<div class="tools-pending-banner">📊 Per-tool invocation tracking + top callers land in <strong>v0.6.9 PR #2</strong>. This page lists the registered catalog; usage cells show "—" for now.</div>`;

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Tools</h1>`,
    `<span class="page-sub">MCP tools stavR exposes — category, default tier, risk</span>`,
    `</div>`,
    `<div class="tools-head">`,
    `<div class="tools-counts">${d.registeredCount} registered · ${d.categoriesPresent.length} categories</div>`,
    `</div>`,
    banner,
    `<div class="tools-toolbar">`,
    `<input type="search" placeholder="Search tools…" data-role="tools-search" />`,
    `<select data-role="tools-cat"><option value="">All categories</option>${catOptions}</select>`,
    `<select data-role="tools-tier"><option value="">All tiers</option>${tierOptions}</select>`,
    `</div>`,
    d.tools.length === 0
      ? `<div class="placeholder">No tools registered yet. (Daemon may be in stdio-only mode or the registry wrap missed first-session timing.)</div>`
      : `<div class="tools-grid" data-role="tools-grid">${cards}</div>`,
  ].join('');

  return renderShell({
    title: 'Stavr — Tools',
    activePage: 'tools',
    body,
    head: `<style>${TOOLS_CSS}</style>`,
    script: TOOLS_JS,
  });
}
