/**
 * v0.6.12 Phase 8 — consistent empty-state component.
 *
 * Every "no data" surface in the dashboard renders through this so the
 * voice + visual stays consistent. Three pieces:
 *   - title (plain-language headline of the empty state)
 *   - body (one or two sentences explaining what would populate it)
 *   - cta? (optional call-to-action — label + href; renders as a button)
 *
 * Anti-pattern this replaces: each page coining its own "No data yet."
 * string in italic dim text with no follow-up.
 */

export const EMPTY_STATE_CSS = `
.empty-state {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px;
  padding: 28px 24px;
  background: var(--bg-glass);
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  text-align: center;
  color: var(--ink-2);
  backdrop-filter: blur(var(--glass-blur));
}
.empty-state .es-title {
  font-size: 14px;
  color: var(--ink-0);
  font-weight: 500;
  margin: 0;
}
.empty-state .es-body {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.55;
  max-width: 480px;
  margin: 0;
}
.empty-state .es-cta {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--rust-soft);
  border: 1px solid var(--rust);
  color: #ffd9c4;
  font-family: var(--mono);
  font-size: 12px;
  text-decoration: none;
}
.empty-state .es-cta:hover { background: rgba(184,84,42,0.20); }
`;

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmptyStateProps {
  title: string;
  body: string;
  cta?: { label: string; href: string };
}

export function renderEmptyState(p: EmptyStateProps): string {
  const cta = p.cta
    ? `<a class="es-cta" href="${escapeHtml(p.cta.href)}">${escapeHtml(p.cta.label)} →</a>`
    : '';
  return [
    `<div class="empty-state" data-role="empty-state">`,
    `<h3 class="es-title">${escapeHtml(p.title)}</h3>`,
    `<p class="es-body">${escapeHtml(p.body)}</p>`,
    cta,
    `</div>`,
  ].join('');
}
