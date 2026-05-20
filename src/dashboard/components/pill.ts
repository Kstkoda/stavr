/**
 * Status pill — small coloured badge for worker status, profile mode,
 * trust scope class, etc. Cheap to render, easy to drop anywhere.
 */

export type PillVariant =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'profile-turbo'
  | 'profile-balanced'
  | 'profile-eco';

export interface PillInput {
  text: string;
  variant?: PillVariant;
  title?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPill(input: PillInput): string {
  const variant = input.variant ?? 'neutral';
  const title = input.title ? ` title="${escapeHtml(input.title)}"` : '';
  return `<span class="pill pill-${variant}"${title}>${escapeHtml(input.text)}</span>`;
}

export const PILL_CSS = `
.pill {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
.pill-success { color: var(--risk-low); border-color: var(--risk-low); background: rgba(74,222,128,0.10); }
.pill-warning { color: var(--risk-medium); border-color: var(--risk-medium); background: rgba(250,204,21,0.10); }
.pill-danger  { color: var(--risk-high); border-color: var(--risk-high); background: rgba(239,68,68,0.10); }
.pill-info    { color: var(--accent-mcp); border-color: var(--accent-mcp); background: rgba(96,165,250,0.10); }
.pill-profile-turbo    { color: var(--profile-turbo); border-color: var(--profile-turbo); background: rgba(167,139,250,0.10); }
.pill-profile-balanced { color: var(--profile-balanced); border-color: var(--profile-balanced); background: rgba(96,165,250,0.10); }
.pill-profile-eco      { color: var(--profile-eco); border-color: var(--profile-eco); background: rgba(74,222,128,0.10); }
`;
