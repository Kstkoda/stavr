/**
 * MCPs page — browse the github.com/mcp registry (static snapshot for v0.4),
 * see what's currently installed, and check which servers need auth.
 *
 * Three tabs:
 *   Browse        — the static registry, with search + sort + category filter
 *   Installed     — bricks in this stavr daemon's registry
 *   Auth-needed   — installed entries flagged needs_auth = true
 *
 * Install button is a v0.4 no-op (paste URL in `~/.stavr/bricks/manifest.yaml`
 * for now); real install flow ships in v0.6+ alongside OAuth 2.1 +
 * Resource Indicators (ADR-035 phase 1).
 */
import { renderShell } from '../shell.js';
import { MCP_REGISTRY, type MCPServerEntry, type McpCategory } from '../data/mcp-registry.js';

export interface McpsInstalledBrick {
  id: string;
  display_name: string;
  kind: string;
  enabled: boolean;
  /** When true, the brick is missing credentials / consent. */
  needs_auth?: boolean;
}

export interface McpsData {
  installed: McpsInstalledBrick[];
}

const CATEGORY_LABELS: Record<McpCategory, string> = {
  dev: 'Development',
  database: 'Database',
  browser: 'Browser',
  productivity: 'Productivity',
  game: 'Game engines',
  design: 'Design',
  monitoring: 'Monitoring',
  cloud: 'Cloud',
  comms: 'Comms',
};

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtStars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function renderCard(e: MCPServerEntry): string {
  const auth = e.needs_auth
    ? `<span class="mcp-tag mcp-tag-auth">auth</span>`
    : '';
  return [
    `<article class="mcp-card" data-category="${escapeHtml(e.category)}" data-id="${escapeHtml(e.id)}"`,
    ` data-name="${escapeHtml(e.name.toLowerCase())}" data-author="${escapeHtml(e.author.toLowerCase())}"`,
    ` data-popularity="${e.popularity}">`,
    `<header class="mcp-card-head">`,
    `<span class="mcp-logo" aria-hidden="true">${escapeHtml(e.logo_emoji ?? '🧩')}</span>`,
    `<div>`,
    `<div class="mcp-name">${escapeHtml(e.name)} ${auth}</div>`,
    `<div class="mcp-author">${escapeHtml(e.author)} · ⭐ ${escapeHtml(fmtStars(e.popularity))}</div>`,
    `</div>`,
    `</header>`,
    `<p class="mcp-desc">${escapeHtml(e.description)}</p>`,
    `<footer class="mcp-card-foot">`,
    `<span class="mcp-tag mcp-tag-cat">${escapeHtml(CATEGORY_LABELS[e.category])}</span>`,
    `<a class="mcp-link" href="${escapeHtml(e.install_url)}" target="_blank" rel="noopener noreferrer">repo →</a>`,
    `<button type="button" class="mcp-install"`,
    ` title="Coming soon — paste URL in ~/.stavr/bricks/manifest.yaml for now"`,
    ` aria-label="Install ${escapeHtml(e.name)}">Install</button>`,
    `</footer>`,
    `</article>`,
  ].join('');
}

function renderInstalledRow(b: McpsInstalledBrick): string {
  const auth = b.needs_auth
    ? `<span class="mcp-tag mcp-tag-auth">needs auth</span>`
    : '';
  const enabled = b.enabled
    ? `<span class="mcp-tag mcp-tag-ok">enabled</span>`
    : `<span class="mcp-tag mcp-tag-dim">disabled</span>`;
  return [
    `<tr>`,
    `<td>${escapeHtml(b.display_name)} ${auth}</td>`,
    `<td><code>${escapeHtml(b.id)}</code></td>`,
    `<td>${escapeHtml(b.kind)}</td>`,
    `<td>${enabled}</td>`,
    `</tr>`,
  ].join('');
}

const MCPS_CSS = `
.mcps-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}
.mcps-tab {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.mcps-tab[aria-selected="true"] {
  border-color: var(--rust);
  color: var(--text-primary);
  background: var(--bg-surface);
}
.mcps-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.mcps-toolbar input,
.mcps-toolbar select {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
}
.mcps-toolbar input { min-width: 240px; flex: 1; }

.mcps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.mcp-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mcp-card-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.mcp-logo {
  width: 32px;
  height: 32px;
  background: var(--bg-elevated);
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 18px;
  flex-shrink: 0;
}
.mcp-name {
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mcp-author { font-size: 11px; color: var(--text-secondary); }
.mcp-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
  flex: 1;
}
.mcp-card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.mcp-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.mcp-tag-cat  { background: var(--bg-elevated); }
.mcp-tag-auth { border-color: var(--health-warn); color: var(--health-warn); }
.mcp-tag-ok   { border-color: var(--health-ok);   color: var(--health-ok); }
.mcp-tag-dim  { border-color: var(--border);      color: var(--text-dim); }
.mcp-link {
  font-size: 11px;
  color: var(--accent-mcp);
  text-decoration: underline;
}
.mcp-install {
  margin-left: auto;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--rust);
  background: transparent;
  color: var(--rust-soft);
  cursor: pointer;
  font-size: 12px;
}
.mcp-install:hover {
  background: var(--rust-glow);
  color: var(--text-primary);
}

.mcps-table {
  width: 100%;
  border-collapse: collapse;
}
.mcps-table th, .mcps-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  font-size: 12px;
}
.mcps-table th {
  color: var(--text-secondary);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.mcps-table code {
  font-size: 11px;
  background: var(--bg-elevated);
  padding: 1px 5px;
  border-radius: 4px;
}

.mcps-section { display: none; }
.mcps-section[data-active="1"] { display: block; }
`;

const MCPS_JS = `
(function() {
  const search = document.querySelector('[data-role="mcp-search"]');
  const sort   = document.querySelector('[data-role="mcp-sort"]');
  const cat    = document.querySelector('[data-role="mcp-cat"]');
  const grid   = document.querySelector('[data-role="mcp-grid"]');

  function applyFilter() {
    if (!grid) return;
    const q = (search && search.value || '').trim().toLowerCase();
    const c = cat && cat.value || '';
    const s = sort && sort.value || 'popularity';
    const cards = Array.from(grid.querySelectorAll('.mcp-card'));
    let visible = cards.filter(function(card) {
      if (c && card.getAttribute('data-category') !== c) return false;
      if (!q) return true;
      const hay = (card.getAttribute('data-name') || '') + ' ' +
                  (card.getAttribute('data-author') || '') + ' ' +
                  card.textContent.toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    if (s === 'popularity') {
      visible.sort(function(a, b) {
        return Number(b.getAttribute('data-popularity')) - Number(a.getAttribute('data-popularity'));
      });
    } else if (s === 'name') {
      visible.sort(function(a, b) {
        return (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
      });
    }
    cards.forEach(function(c) { c.style.display = 'none'; });
    visible.forEach(function(c, i) {
      c.style.display = '';
      c.style.order = String(i);
    });
  }

  if (search) search.addEventListener('input', applyFilter);
  if (sort)   sort.addEventListener('change', applyFilter);
  if (cat)    cat.addEventListener('change', applyFilter);

  document.querySelectorAll('.mcps-tab').forEach(function(t) {
    t.addEventListener('click', function() {
      const tab = t.getAttribute('data-tab');
      document.querySelectorAll('.mcps-tab').forEach(function(x) {
        x.setAttribute('aria-selected', x === t ? 'true' : 'false');
      });
      document.querySelectorAll('[data-role="mcp-section"]').forEach(function(s) {
        s.setAttribute('data-active', s.getAttribute('data-section') === tab ? '1' : '0');
      });
    });
  });

  document.querySelectorAll('.mcp-install').forEach(function(b) {
    b.addEventListener('click', function() {
      if (window.__stavrFloatingInspector) {
        window.__stavrFloatingInspector.openAt(b, {
          icon: '!',
          title: 'Install — coming soon',
          sub: 'v0.4 placeholder',
          sections: [
            { label: 'For now', value: 'Paste the repo URL into ~/.stavr/bricks/manifest.yaml.' },
            { label: 'Real flow', value: 'OAuth 2.1 + Resource Indicators install — v0.6, ADR-035 phase 1.' },
          ],
        });
      }
    });
  });
})();
`;

export function renderMcpsPage(data?: McpsData): string {
  const installed = data?.installed ?? [];
  const authNeeded = installed.filter((b) => b.needs_auth);

  const cards = MCP_REGISTRY.map(renderCard).join('');

  const categoryOptions = (['all', ...Object.keys(CATEGORY_LABELS)] as Array<'all' | McpCategory>)
    .map((c) => {
      const label = c === 'all' ? 'All categories' : CATEGORY_LABELS[c as McpCategory];
      return `<option value="${c === 'all' ? '' : c}">${escapeHtml(label)}</option>`;
    })
    .join('');

  const browseSection = [
    `<div class="mcps-toolbar">`,
    `<input type="search" placeholder="Search MCP servers…" data-role="mcp-search" />`,
    `<select data-role="mcp-cat">${categoryOptions}</select>`,
    `<select data-role="mcp-sort">`,
    `<option value="popularity">Sort · Popularity</option>`,
    `<option value="name">Sort · Name</option>`,
    `</select>`,
    `</div>`,
    `<div class="mcps-grid" data-role="mcp-grid">${cards}</div>`,
  ].join('');

  const installedSection = installed.length === 0
    ? `<div class="placeholder">No MCP bricks installed yet. Browse the registry → Install (or edit <code>~/.stavr/bricks/manifest.yaml</code> directly for v0.4).</div>`
    : `<table class="mcps-table"><thead><tr><th>Name</th><th>Id</th><th>Kind</th><th>State</th></tr></thead><tbody>${installed.map(renderInstalledRow).join('')}</tbody></table>`;

  const authSection = authNeeded.length === 0
    ? `<div class="placeholder">No installed brick is currently flagged as needing auth.</div>`
    : `<table class="mcps-table"><thead><tr><th>Name</th><th>Id</th><th>Kind</th><th>State</th></tr></thead><tbody>${authNeeded.map(renderInstalledRow).join('')}</tbody></table>`;

  const body = [
    `<div class="page-head">`,
    `<h1 class="page-title">MCPs</h1>`,
    `<span class="page-sub">Browse · install · audit MCP servers</span>`,
    `</div>`,
    `<div class="mcps-tabs" role="tablist">`,
    `<button class="mcps-tab" role="tab" data-tab="browse"    aria-selected="true">Browse · ${MCP_REGISTRY.length}</button>`,
    `<button class="mcps-tab" role="tab" data-tab="installed" aria-selected="false">Installed · ${installed.length}</button>`,
    `<button class="mcps-tab" role="tab" data-tab="auth"      aria-selected="false">Auth-needed · ${authNeeded.length}</button>`,
    `</div>`,
    `<section data-role="mcp-section" data-section="browse"    data-active="1">${browseSection}</section>`,
    `<section data-role="mcp-section" data-section="installed" data-active="0">${installedSection}</section>`,
    `<section data-role="mcp-section" data-section="auth"      data-active="0">${authSection}</section>`,
  ].join('');

  return renderShell({
    title: 'Stavr — MCPs',
    activePage: 'mcps',
    body,
    head: `<style>${MCPS_CSS}</style>`,
    script: MCPS_JS,
  });
}
