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
/* v0.6 Task 4 Phase B — category groups + visual hierarchy. */
.tools-group {
  margin-top: 16px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(20, 22, 31, 0.4);
  overflow: hidden;
}
.tools-group > summary {
  list-style: none;
  cursor: pointer;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--ink);
  user-select: none;
}
.tools-group > summary::-webkit-details-marker { display: none; }
.tools-group > summary::before {
  content: '▸';
  color: var(--ink-dim);
  transition: transform 0.15s ease;
}
.tools-group[open] > summary::before { transform: rotate(90deg); }
.tools-group > summary .tools-group-count {
  color: var(--ink-dim);
  font-size: 12px;
  margin-left: auto;
}
.tools-group .tools-grid { padding: 10px 14px 14px 14px; }
.tools-pinned {
  border: 1px solid rgba(250, 156, 76, 0.40);
  background: rgba(250, 156, 76, 0.04);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.tools-pinned > .tools-pinned-head {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--warn, #fa9c4c);
  margin-bottom: 8px;
}
/* EXPLICIT + NO_GO cards: darker glass, larger title, status halo. */
.tools-card[data-tier="EXPLICIT"],
.tools-card[data-tier="NO_GO"] {
  background: rgba(10, 11, 16, 0.78);
  border-color: rgba(250, 156, 76, 0.45);
  box-shadow: 0 0 0 1px rgba(250, 156, 76, 0.15) inset;
}
.tools-card[data-tier="NO_GO"] {
  border-color: rgba(216, 78, 78, 0.50);
  box-shadow: 0 0 0 1px rgba(216, 78, 78, 0.20) inset;
}
.tools-card[data-tier="EXPLICIT"] .tools-id,
.tools-card[data-tier="NO_GO"]    .tools-id {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-0, #fff);
}
`;

const TOOLS_JS = `
(function () {
  const search = document.querySelector('[data-role="tools-search"]');
  const catSel = document.querySelector('[data-role="tools-cat"]');
  const tierSel = document.querySelector('[data-role="tools-tier"]');

  function applyFilter() {
    const q = (search && search.value || '').trim().toLowerCase();
    const c = catSel && catSel.value || '';
    const t = tierSel && tierSel.value || '';
    // v0.6 Task 4 Phase B — cards live in multiple grids (pinned +
    // per-category groups). Query globally; per-group visibility is
    // recomputed below from the per-card visibility.
    const cards = Array.from(document.querySelectorAll('.tools-card'));
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
    // Hide category groups whose every card is filtered out. Helps the
    // operator scan results without empty-section noise.
    document.querySelectorAll('[data-role="tools-group"]').forEach(function (grp) {
      const anyVisible = Array.from(grp.querySelectorAll('.tools-card'))
        .some(function (card) { return card.style.display !== 'none'; });
      grp.style.display = anyVisible ? '' : 'none';
      // Auto-expand collapsed groups when an active filter matches them
      // so the operator can see the matches without manually opening.
      const hasFilter = !!(q || c || t);
      if (anyVisible && hasFilter) grp.setAttribute('open', '');
    });
  }

  if (search) search.addEventListener('input', applyFilter);
  if (catSel) catSel.addEventListener('change', applyFilter);
  if (tierSel) tierSel.addEventListener('change', applyFilter);
})();
`;

// v0.6 Task 4 Phase B — category sort order for the grouped layout.
// GitHub goes last + default-collapsed since it's the largest family
// and tends to drown out the smaller, more-frequently-touched groups.
const CATEGORY_ORDER: ToolCategory[] = [
  'decision',
  'credentials',
  'scope',
  'worker',
  'shell',
  'steward',
  'subscription',
  'event',
  'plan',
  'other',
  'github',
];

// Categories that default-collapse so the page opens compact even when
// stavR has registered the full GitHub family.
const DEFAULT_COLLAPSED: ReadonlyArray<ToolCategory> = ['github'];

// Tier values considered "critical" — pinned to the top of the page.
const CRITICAL_TIERS: ReadonlyArray<Tier> = ['EXPLICIT', 'NO_GO'];

export function renderToolsPage(data?: ToolsData): string {
  const d = data ?? emptyToolsData();
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

  // v0.6 Task 4 Phase B — pinned "critical tools" section at the top
  // (EXPLICIT + NO_GO default-tier), then the rest grouped by category.
  const criticalTools = d.tools.filter((t) => CRITICAL_TIERS.includes(t.defaultTier));
  const pinnedSection = criticalTools.length === 0
    ? ''
    : [
        `<section class="tools-pinned">`,
        `<div class="tools-pinned-head">Critical · ${criticalTools.length} tools at EXPLICIT or NO-GO by default</div>`,
        `<div class="tools-grid" data-role="tools-grid">${criticalTools.map(renderToolCard).join('')}</div>`,
        `</section>`,
      ].join('');

  // Group every tool by category for the second pass; critical tools
  // intentionally appear in BOTH the pinned section and their category
  // group so search/filter find them in either location.
  const byCat = new Map<ToolCategory, ToolRow[]>();
  for (const t of d.tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category)!.push(t);
  }
  const orderedCats = CATEGORY_ORDER.filter((c) => byCat.has(c));
  // Append any leftover categories not in CATEGORY_ORDER (defensive —
  // new categories shouldn't silently vanish).
  for (const c of byCat.keys()) {
    if (!orderedCats.includes(c)) orderedCats.push(c);
  }
  const groupedSections = orderedCats
    .map((c) => {
      const tools = byCat.get(c)!;
      const open = !DEFAULT_COLLAPSED.includes(c);
      const cards = tools.map(renderToolCard).join('');
      return [
        `<details class="tools-group" data-role="tools-group" data-category="${escapeHtml(c)}"${open ? ' open' : ''}>`,
        `<summary>`,
        `<span>${escapeHtml(CATEGORY_LABELS[c])}</span>`,
        `<span class="tools-group-count">${tools.length}</span>`,
        `</summary>`,
        `<div class="tools-grid" data-role="tools-grid">${cards}</div>`,
        `</details>`,
      ].join('');
    })
    .join('');

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">Tools</h1>`,
    `<span class="page-sub">MCP tools stavR exposes — category, default tier, risk</span>`,
    `</div>`,
    `<div class="tools-head">`,
    `<div class="tools-counts">${d.registeredCount} registered · ${d.categoriesPresent.length} categories${criticalTools.length > 0 ? ` · ${criticalTools.length} critical` : ''}</div>`,
    `</div>`,
    banner,
    `<div class="tools-toolbar">`,
    `<input type="search" placeholder="Search tools…" data-role="tools-search" />`,
    `<select data-role="tools-cat"><option value="">All categories</option>${catOptions}</select>`,
    `<select data-role="tools-tier"><option value="">All tiers</option>${tierOptions}</select>`,
    `</div>`,
    d.tools.length === 0
      ? `<div class="placeholder">No tools registered yet. (Daemon may be in stdio-only mode or the registry wrap missed first-session timing.)</div>`
      : `${pinnedSection}${groupedSections}`,
  ].join('');

  return renderShell({
    title: 'Stavr — Tools',
    activePage: 'tools',
    body,
    head: `<style>${TOOLS_CSS}</style>`,
    script: TOOLS_JS,
  });
}
