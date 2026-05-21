/**
 * Single timeline row component for `/dashboard/history`. Renders one
 * HistoryItem as a glass-styled row with:
 *
 *   - Time chip (HH:MM, hover shows full ISO)
 *   - Kind icon (registered via HISTORY_KIND_REGISTRY)
 *   - Status halo on the icon (ok/warn/crit per CLAUDE.md §5)
 *   - Title text
 *   - Optional source-agent badge + trace-depth chip (notifications)
 *   - Optional source-url click-out
 *
 * Per CLAUDE.md §5: type = color of the icon, status = halo ring. Never
 * use color to signal status on the row body.
 *
 * The registry pattern is the foundation for ADR-041 / the
 * universal-signal-trace roadmap — new event kinds (LLM-calls,
 * DB-queries, MCP-traffic, federation) become tabs + rows without
 * touching this file beyond extending the registry.
 */
import type { HistoryItem, HistoryKind, HistoryStatus } from '../data/history/types.js';

export interface HistoryKindMeta {
  id: HistoryKind;
  label: string;
  /** Unicode icon for now — replaced with SVG by an icon-sprite migration. */
  icon: string;
  /** Type-color CSS variable (or hex) used for the icon glyph. */
  color: string;
}

export const HISTORY_KIND_REGISTRY: Record<HistoryKind, HistoryKindMeta> = {
  decision:     { id: 'decision',     label: 'Decision',     icon: '⚖',  color: 'var(--accent-decision, #d4a85c)' },
  scope:        { id: 'scope',        label: 'Scope',        icon: '🔑', color: 'var(--accent-scope, #6aa9ff)' },
  'bom-file':   { id: 'bom-file',     label: 'BOM',          icon: '📜', color: 'var(--accent-bom, #b8542a)' },
  plan:         { id: 'plan',         label: 'Plan',         icon: '☰',  color: 'var(--accent-plan, #b78cff)' },
  'host-exec':  { id: 'host-exec',    label: 'Host-exec',    icon: '⌨',  color: 'var(--accent-exec, #57c785)' },
  commit:       { id: 'commit',       label: 'Commit',       icon: '⎇',  color: 'var(--accent-commit, #c5a5ff)' },
  ci:           { id: 'ci',           label: 'CI',           icon: '✓',  color: 'var(--accent-ci, #57c785)' },
  notification: { id: 'notification', label: 'Notification', icon: '✉',  color: 'var(--accent-notify, #ff8aa8)' },
};

export const HISTORY_TAB_ORDER: HistoryKind[] = [
  'decision', 'scope', 'bom-file', 'plan', 'host-exec', 'commit', 'ci', 'notification',
];

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_HALO: Record<HistoryStatus, string> = {
  pending:       'warn',
  success:       'ok',
  failure:       'crit',
  expired:       'warn',
  revoked:       'crit',
  cancelled:     'warn',
  'in-progress': 'info',
  unknown:       'info',
};

function timeChip(iso: string): string {
  // Render HH:MM (operator's locale via browser). The full ISO is on the
  // title attribute so hover surfaces the exact moment.
  let label = '—';
  if (iso) {
    const m = /T(\d{2}:\d{2})/.exec(iso);
    if (m) label = m[1];
  }
  return `<span class="row-time" title="${escapeHtml(iso)}">${escapeHtml(label)}</span>`;
}

export function renderHistoryRow(item: HistoryItem): string {
  const meta = HISTORY_KIND_REGISTRY[item.kind];
  const halo = item.status ? STATUS_HALO[item.status] : 'info';
  const hasCorrelation = Boolean(item.correlation_id);
  const isNotification = item.kind === 'notification';
  // Notification rows show source-agent badge + trace-depth placeholder
  // (filled in by P4 hover). All rows can host the source-link wing when
  // source_url is set.
  const sourceBadge = isNotification && item.actor
    ? `<span class="row-source">[${escapeHtml(item.actor)}]</span>`
    : '';
  const traceChip = isNotification && hasCorrelation
    ? `<span class="row-trace" data-role="trace-depth" data-corr="${escapeHtml(item.correlation_id!)}" title="hop depth — hover to load">↩ …</span>`
    : '';
  const sourceLink = item.source_url
    ? `<a class="row-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(meta.label)} source">↗</a>`
    : '';
  const traceAffordance = hasCorrelation
    ? `<button type="button" class="row-trace-btn" data-role="open-trace" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}" data-corr="${escapeHtml(item.correlation_id!)}" aria-label="Open trace drawer">⤢</button>`
    : '';
  return [
    `<li class="history-row" data-role="history-row"`,
    ` data-kind="${escapeHtml(item.kind)}"`,
    ` data-id="${escapeHtml(item.id)}"`,
    ` data-at="${escapeHtml(item.at)}"`,
    item.correlation_id ? ` data-corr="${escapeHtml(item.correlation_id)}"` : '',
    item.status ? ` data-status="${escapeHtml(item.status)}"` : '',
    `>`,
    timeChip(item.at),
    `<span class="row-icon-wrap" data-halo="${halo}">`,
    `<span class="row-icon" style="color:${meta.color}" aria-label="${escapeHtml(meta.label)}">${meta.icon}</span>`,
    `</span>`,
    `<span class="row-kind">${escapeHtml(meta.label)}</span>`,
    `<span class="row-title">${escapeHtml(item.title)}</span>`,
    sourceBadge,
    traceChip,
    sourceLink,
    traceAffordance,
    `</li>`,
  ].join('');
}

export const TIMELINE_ROW_CSS = `
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.history-row {
  display: grid;
  grid-template-columns: 60px 28px 90px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--ink-0);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  transition: border-color 0.12s ease, transform 0.12s ease;
}
.history-row:hover { border-color: var(--line-2); }
.history-row[hidden] { display: none; }
.row-time {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}
.row-icon-wrap {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  position: relative;
}
.row-icon-wrap[data-halo="ok"]   { box-shadow: 0 0 0 1.5px var(--ok) inset, 0 0 8px rgba(87,199,133,0.35); }
.row-icon-wrap[data-halo="warn"] { box-shadow: 0 0 0 1.5px var(--warn) inset, 0 0 8px rgba(212,168,92,0.35); }
.row-icon-wrap[data-halo="crit"] { box-shadow: 0 0 0 1.5px var(--crit) inset, 0 0 8px rgba(239,68,68,0.35); }
.row-icon-wrap[data-halo="info"] { box-shadow: 0 0 0 1.5px var(--line-2) inset; }
.row-icon {
  font-size: 14px;
  line-height: 1;
}
.row-kind {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.row-title {
  color: var(--ink-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.row-source {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-2);
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--line-2);
}
.row-trace {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-2);
  cursor: help;
}
.row-link, .row-trace-btn {
  background: transparent;
  border: 0;
  color: var(--ink-2);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
}
.row-link:hover, .row-trace-btn:hover { color: var(--ink-0); background: rgba(255,255,255,0.04); }
`;
