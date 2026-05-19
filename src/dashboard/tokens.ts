/**
 * Dashboard design tokens — single source of truth for the v0.4.1 polish
 * CSS custom properties. Re-used by every page; injected into the shell.
 *
 * Two palettes coexist:
 *   - Legacy (v0.3): --bg-base / --accent-steward / --risk-* / --profile-*.
 *     Still referenced by existing pages + asserted by shell.test.ts, so
 *     these names cannot move.
 *   - Iron (v0.4.1, from dashboard-mockup-v8.html + dashboard-helm-v2): the
 *     rust / ink-0..3 / ok+warn+crit / type-color palette that gives the
 *     dashboard its glass-and-rust look. Add new pages with these tokens.
 *
 * The .glass utility lives here too because every panel uses it.
 */
export const TOKENS_CSS = `
:root {
  color-scheme: dark;
  /* === Legacy v0.3 tokens (don't rename — asserted by tests) === */
  --bg-base:        #0a0a0f;
  --bg-surface:     #14141a;
  --bg-elevated:    #1c1c24;
  --bg-hover:       #25252f;
  --border:         #2a2a36;
  --border-strong:  #3a3a48;
  --text-primary:   #e8e8f0;
  --text-secondary: #8a8a96;
  --text-dim:       #6a6a78;
  --accent-ai-external:   #a78bfa;
  --accent-ai-internal:   #facc15;
  --accent-mcp:           #60a5fa;
  --accent-steward:       #ef4444;
  --accent-connector-above: #fb923c;
  --accent-connector-below: #4ade80;
  --risk-low:    #4ade80;
  --risk-medium: #facc15;
  --risk-high:   #ef4444;
  --profile-turbo:    #a78bfa;
  --profile-balanced: #60a5fa;
  --profile-eco:      #4ade80;
  --health-ok:        #4ade80;
  --health-warn:      #facc15;
  --health-down:      #ef4444;

  /* === Iron palette (v0.4.1, v8 canonical) === */
  --bg-0: #0a0b10;
  --bg-1: #0f1018;
  --bg-2: #14161f;
  --bg-deep: #04050a;
  --bg-glass:   rgba(20, 22, 31, 0.55);
  --bg-glass-2: rgba(28, 30, 42, 0.72);
  --bg-sheet:   rgba(10, 12, 18, 0.78);
  --bg-popover: rgba(14, 16, 22, 0.92);
  --surface:    rgba(20, 22, 31, 0.72);
  --surface-2:  rgba(28, 30, 42, 0.78);
  --line:       rgba(255, 255, 255, 0.06);
  --line-2:     rgba(255, 255, 255, 0.10);
  --line-hi:    rgba(255, 255, 255, 0.16);

  --ink-0: #e8e9ef;
  --ink-1: #b9bbc6;
  --ink-2: #7e8090;
  --ink-3: #4f5160;

  --rust:      #b8542a;
  --rust-soft: rgba(184, 84, 42, 0.14);
  --rust-glow: rgba(184, 84, 42, 0.40);

  /* Status quartet — halo rings, never to communicate node type */
  --ok:   #6dd58c;
  --warn: #e2a942;
  --crit: #ef5a6f;
  --info: #6aa9ff;

  /* Type palette — node + tile colors. Status uses the halo, not these. */
  --t-core:       #b8542a;
  --t-mcp-remote: #6aa9ff;
  --t-mcp-local:  #5ec1a2;
  --t-webhook:    #e2a942;
  --t-db:         #b394ff;
  --t-model:      #a78bfa;
  --t-worker:     #6dd58c;
  --t-peer:       #f06ec1;

  /* v0.6.10 Task 4a — Actor palette. First-class actors on the topology
     constellation get their own color so flow particles read at a glance
     (operator = rust, CC = blue, Cowork-Claude = teal, remote peer = cyan,
     fallback / switch-default = neutral). Status is still encoded by the
     halo per CLAUDE.md §5 — these tokens drive node fill only. */
  --actor-operator: #b8542a;
  --actor-cc:       #6aa9ff;
  --actor-cowork:   #5ec1a2;
  --actor-peer:     #5cc6ff;
  --actor-default:  #4f5160;

  /* Convenience aliases used in mockups */
  --purple: #a78bfa;
  --sky:    #6aa9ff;
  --green:  #6dd58c;
  --amber:  #e2a942;
  --red:    #ef5a6f;
  --orange: #fb923c;
  --teal:   #5ec1a2;
  --cyan:   #5cc6ff;
  --pink:   #f06ec1;

  --glass-blur: 14px;
  --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

/* Glass utility — every panel/band/card uses this. */
.glass {
  background: var(--bg-glass);
  border: 1px solid var(--line);
  border-radius: 12px;
  backdrop-filter: blur(var(--glass-blur)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(140%);
}
.glass-strong {
  background: var(--bg-glass-2);
  border: 1px solid var(--line-2);
  border-radius: 14px;
  backdrop-filter: blur(28px) saturate(150%);
  -webkit-backdrop-filter: blur(28px) saturate(150%);
}

/* Status halo — wrap a node circle/hex in .halo[data-status=ok|warn|crit] */
.halo { position: relative; }
.halo::after {
  content: '';
  position: absolute; inset: -3px;
  border-radius: inherit;
  pointer-events: none;
  border: 1.5px solid transparent;
}
.halo[data-status="ok"]::after   { border-color: var(--ok);   box-shadow: 0 0 8px var(--ok); }
.halo[data-status="warn"]::after { border-color: var(--warn); box-shadow: 0 0 8px var(--warn); }
.halo[data-status="crit"]::after { border-color: var(--crit); box-shadow: 0 0 8px var(--crit); animation: halo-pulse 1.4s ease-in-out infinite; }
@keyframes halo-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
`;
