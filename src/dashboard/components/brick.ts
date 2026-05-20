/**
 * Brick component — Lego/DUPLO-style SVG block with stud dots on top.
 *
 * Used by Topology, Toolkit, and Capabilities. The `kind` controls colour
 * (mapping is fixed: external AI = purple, internal AI = yellow, MCP =
 * blue, steward = red, connector above/below = orange/green).
 *
 * Bricks DO NOT have connecting lines — they're either registered or not.
 * The presence of the brick is the registration; click opens the inspector
 * for its config_schema. See project_cowire_dashboard_modes.md.
 */

export type BrickKind =
  | 'ai-external'
  | 'ai-internal'
  | 'mcp'
  | 'steward'
  | 'connector-above'
  | 'connector-below';

export type BrickStatus = 'idle' | 'running' | 'error' | 'disabled';

export interface BrickInput {
  /** Stable id — used for click handlers + inspector lookup. */
  id: string;
  /** Visual category. Determines colour. */
  kind: BrickKind;
  /** Human-readable label shown on the brick face. */
  displayName: string;
  /** Optional position above (external) or below (internal) the ESB bus. */
  position?: 'above' | 'below';
  /** Optional status dot. */
  status?: BrickStatus;
  /** Number of studs on top (default 4). */
  studs?: number;
}

const KIND_VAR: Record<BrickKind, string> = {
  'ai-external':     '--accent-ai-external',
  'ai-internal':     '--accent-ai-internal',
  'mcp':             '--accent-mcp',
  'steward':         '--accent-steward',
  'connector-above': '--accent-connector-above',
  'connector-below': '--accent-connector-below',
};

const STATUS_VAR: Record<BrickStatus, string> = {
  idle:     '--risk-low',
  running:  '--risk-medium',
  error:    '--risk-high',
  disabled: '--text-dim',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBrick(input: BrickInput): string {
  const studs = Math.max(1, Math.min(8, input.studs ?? 4));
  const w = 96;
  const h = 56;
  const studR = 5;
  const studGap = (w - 16) / studs;
  const studY = 6;

  const fillVar = KIND_VAR[input.kind];
  const statusVar = input.status ? STATUS_VAR[input.status] : null;

  const studDots: string[] = [];
  for (let i = 0; i < studs; i++) {
    const cx = 8 + studGap * (i + 0.5);
    studDots.push(
      `<circle cx="${cx.toFixed(1)}" cy="${studY}" r="${studR}" fill="var(${fillVar})" filter="brightness(0.85)" />`,
    );
  }

  const statusDot = statusVar
    ? `<circle class="brick-status" cx="${w - 10}" cy="${h - 10}" r="4" fill="var(${statusVar})" />`
    : '';

  const labelY = h / 2 + 4;
  return [
    `<svg class="brick" data-id="${escapeHtml(input.id)}" data-kind="${input.kind}"`,
    input.position ? ` data-position="${input.position}"` : '',
    ` width="${w}" height="${h + studY}" viewBox="0 -${studY} ${w} ${h + studY}"`,
    ` xmlns="http://www.w3.org/2000/svg" role="button" tabindex="0"`,
    ` aria-label="${escapeHtml(input.displayName)}">`,
    studDots.join(''),
    `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="7" ry="7"`,
    ` fill="var(${fillVar})" stroke="rgba(0,0,0,0.25)" stroke-width="1" />`,
    `<text x="${w / 2}" y="${labelY}" text-anchor="middle"`,
    ` font-family="ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif"`,
    ` font-size="11" font-weight="700" fill="#0a0a0f">${escapeHtml(input.displayName)}</text>`,
    statusDot,
    `</svg>`,
  ].join('');
}

export const BRICK_CSS = `
.brick {
  cursor: pointer;
  transition: transform 0.12s ease, filter 0.12s ease;
}
.brick:hover { transform: translateY(-2px); filter: brightness(1.06); }
.brick:focus-visible {
  outline: 2px solid var(--accent-mcp);
  outline-offset: 2px;
  border-radius: 10px;
}
`;
