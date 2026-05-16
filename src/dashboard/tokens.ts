/**
 * Dark 2.0 design tokens — single source of truth for v0.3 dashboard CSS
 * custom properties. Re-used by every page; injected into the shell.
 *
 * Color invariants come from project_cowire_dashboard_modes.md:
 *   external AI = purple, internal AI = yellow, MCP = blue,
 *   steward = red, connector-above = orange, connector-below = green.
 */
export const TOKENS_CSS = `
:root {
  color-scheme: dark;
  /* Base surfaces */
  --bg-base:        #0a0a0f;
  --bg-surface:     #14141a;
  --bg-elevated:    #1c1c24;
  --bg-hover:       #25252f;
  --border:         #2a2a36;
  --border-strong:  #3a3a48;
  /* Text */
  --text-primary:   #e8e8f0;
  --text-secondary: #8a8a96;
  --text-dim:       #6a6a78;
  /* Brick / role colors */
  --accent-ai-external:   #a78bfa;
  --accent-ai-internal:   #facc15;
  --accent-mcp:           #60a5fa;
  --accent-steward:       #ef4444;
  --accent-connector-above: #fb923c;
  --accent-connector-below: #4ade80;
  /* Risk */
  --risk-low:    #4ade80;
  --risk-medium: #facc15;
  --risk-high:   #ef4444;
  /* Profile mode badges */
  --profile-turbo:    #a78bfa;
  --profile-balanced: #60a5fa;
  --profile-eco:      #4ade80;
  /* v8 additions (2026-05-17, Helm visual language) */
  --rust:             #b8542a;
  --rust-soft:        #c97a4f;
  --rust-glow:        rgba(184, 84, 42, 0.4);
  --bg-popover:       rgba(14, 16, 22, 0.92);
  --glass-blur:       blur(24px) saturate(140%);
  --health-ok:        #4ade80;
  --health-warn:      #facc15;
  --health-down:      #ef4444;
}
`;
