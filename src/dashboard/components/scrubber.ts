/**
 * Time scrubber — bottom-of-page slider that scrolls a page's content
 * back through history. Owned by Topology (C5); skeleton here so the
 * styling and DOM contract land in C1.
 *
 * The slider's value is the index into a fixed snapshot array; the page
 * binds to `change` / `input` to re-render to that snapshot. Releasing
 * the slider snaps to "live" (max).
 */

export interface ScrubberInput {
  id?: string;
  /** Number of snapshot steps; the slider's max value. */
  steps?: number;
  /** Optional label displayed above the slider. */
  label?: string;
}

export function renderScrubber(input: ScrubberInput = {}): string {
  const id = input.id ?? 'scrubber';
  const steps = Math.max(1, input.steps ?? 100);
  const label = input.label ?? 'Time';
  return [
    `<div class="scrubber" data-role="scrubber">`,
    `<div class="scrubber-row">`,
    `<span class="scrubber-label">${label}</span>`,
    `<input type="range" id="${id}" min="0" max="${steps}" value="${steps}"`,
    ` step="1" class="scrubber-slider" aria-label="Time scrubber" />`,
    `<span class="scrubber-value" data-role="value">live</span>`,
    `</div>`,
    `</div>`,
  ].join('');
}

export const SCRUBBER_CSS = `
.scrubber {
  position: sticky;
  bottom: 0;
  background: var(--bg-surface);
  border-top: 1px solid var(--border);
  padding: 10px 16px;
}
.scrubber-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.scrubber-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.scrubber-slider {
  flex: 1;
  accent-color: var(--accent-mcp);
}
.scrubber-value {
  min-width: 60px;
  text-align: right;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-secondary);
}
`;
