/**
 * Food-label card — 4-cell What/Risk/Reversible/Cost layout.
 *
 * Re-used by Plans (BOM cards), Decide (decision cards), and Topology
 * hover-cards. Pure render function — no DOM, no state. Returns an HTML
 * string the page wraps into its grid.
 */

export type FoodLabelRisk = 'low' | 'medium' | 'high';
export type FoodLabelReversible = 'yes' | 'partial' | 'no';

export interface FoodLabelInput {
  /** Card title shown in the header strip. */
  name: string;
  /** Short prose describing the action. */
  what: string;
  /** Highest risk class in the envelope. */
  riskClass: FoodLabelRisk;
  /** Whether the action is reversible. */
  reversible: FoodLabelReversible;
  /** Estimated USD cost (or actual, for finished items). */
  costUsd: number;
  /** Optional model-mix label (e.g. "Sonnet · Opus"). */
  modelMix?: string;
  /** Optional href — wraps the card as <a>. */
  href?: string;
  /** Optional id used for click handlers / tests. */
  id?: string;
}

const RISK_LABEL: Record<FoodLabelRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const REVERSIBLE_LABEL: Record<FoodLabelReversible, string> = {
  yes: '✓ Yes',
  partial: '⚠ Partial',
  no: '✗ No',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '&lt;$0.01';
  return `$${usd.toFixed(2)}`;
}

export function renderFoodLabel(input: FoodLabelInput): string {
  const id = input.id ? ` data-id="${escapeHtml(input.id)}"` : '';
  const tag = input.href ? 'a' : 'div';
  const hrefAttr = input.href ? ` href="${escapeHtml(input.href)}"` : '';
  const mix = input.modelMix
    ? `<span class="fl-mix">${escapeHtml(input.modelMix)}</span>`
    : '';
  return [
    `<${tag} class="food-label" data-risk="${input.riskClass}"${id}${hrefAttr}>`,
    `<div class="fl-head">`,
    `<span class="fl-name">${escapeHtml(input.name)}</span>`,
    mix,
    `</div>`,
    `<div class="fl-cell fl-what">`,
    `<div class="fl-label">What</div>`,
    `<div class="fl-value">${escapeHtml(input.what)}</div>`,
    `</div>`,
    `<div class="fl-cell fl-risk risk-${input.riskClass}">`,
    `<div class="fl-label">Risk</div>`,
    `<div class="fl-value">${RISK_LABEL[input.riskClass]}</div>`,
    `</div>`,
    `<div class="fl-cell fl-reversible">`,
    `<div class="fl-label">Reversible</div>`,
    `<div class="fl-value">${REVERSIBLE_LABEL[input.reversible]}</div>`,
    `</div>`,
    `<div class="fl-cell fl-cost">`,
    `<div class="fl-label">Cost</div>`,
    `<div class="fl-value">${formatCost(input.costUsd)}</div>`,
    `</div>`,
    `</${tag}>`,
  ].join('');
}

export const FOOD_LABEL_CSS = `
.food-label {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  grid-template-rows: auto 1fr;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  transition: border-color 0.12s ease, transform 0.12s ease;
}
.food-label:hover { border-color: var(--border-strong); }
.food-label .fl-head {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}
.food-label .fl-name {
  font-weight: 500;
  font-size: 14px;
  color: var(--text-primary);
}
.food-label .fl-mix {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.food-label .fl-cell {
  padding: 12px 14px;
  border-right: 1px solid var(--border);
}
.food-label .fl-cell:last-child { border-right: 0; }
.food-label .fl-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.food-label .fl-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.food-label .fl-risk.risk-low    .fl-value { color: var(--risk-low); }
.food-label .fl-risk.risk-medium .fl-value { color: var(--risk-medium); }
.food-label .fl-risk.risk-high   .fl-value { color: var(--risk-high); }
`;
