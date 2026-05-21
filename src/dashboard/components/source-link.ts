/**
 * Source-link component — renders an external or internal link with the
 * appropriate target + rel. Centralised so every row uses the same
 * security posture (rel="noopener noreferrer" on external; same-tab
 * for internal).
 *
 * The classification is purely URL-shape based:
 *   - http(s)://...   → external (target=_blank, noopener)
 *   - /...            → internal (same tab)
 *   - anything else   → rendered as plain text (defensive)
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface SourceLinkOpts {
  href: string;
  label: string;
  /** Optional aria-label override (defaults to "Open <label>"). */
  ariaLabel?: string;
  /** Optional CSS class added alongside `source-link`. */
  className?: string;
}

export type LinkKind = 'external' | 'internal' | 'plain';

export function classifyLink(href: string): LinkKind {
  if (/^https?:\/\//i.test(href)) return 'external';
  if (href.startsWith('/')) return 'internal';
  return 'plain';
}

export function renderSourceLink(opts: SourceLinkOpts): string {
  const kind = classifyLink(opts.href);
  const aria = opts.ariaLabel ?? `Open ${opts.label}`;
  const cls = ['source-link', opts.className].filter(Boolean).join(' ');
  if (kind === 'plain') {
    return `<span class="${escapeHtml(cls)}" aria-label="${escapeHtml(aria)}">${escapeHtml(opts.label)}</span>`;
  }
  const tgt = kind === 'external' ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="${escapeHtml(cls)}" href="${escapeHtml(opts.href)}"${tgt} aria-label="${escapeHtml(aria)}">${escapeHtml(opts.label)} ↗</a>`;
}

/**
 * Derive a GitHub commit URL from a head SHA + repo coords. Returns null
 * when the inputs are insufficient (e.g., no head_sha). The repo coords
 * default to the env-overridable repo for the current daemon — pages
 * that need a different repo should pass the override explicitly.
 */
export function gitHubCommitUrl(sha: string, repo: string): string | null {
  if (!sha || !/^[a-f0-9]{7,40}$/i.test(sha)) return null;
  if (!repo.includes('/')) return null;
  return `https://github.com/${repo}/commit/${sha}`;
}

export function gitHubPrUrl(prNumber: number, repo: string): string | null {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  if (!repo.includes('/')) return null;
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export const SOURCE_LINK_CSS = `
.source-link {
  font-size: 12px;
  color: var(--ink-1);
  text-decoration: none;
  padding: 2px 6px;
  border-radius: 4px;
}
.source-link:hover { color: var(--ink-0); background: rgba(255,255,255,0.04); }
`;
