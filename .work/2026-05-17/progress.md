# v0.4 visible-value bundle — overnight run 2026-05-17

## Context notes

Several reference files in OVERNIGHT_TASK_2026_05_17.md were not present in the
repo at the start of this run:

- `CLAUDE.md` — absent at repo root
- `docs/stavr-progress-and-plan.md` — absent
- `design-mockups/dashboard-mockup-v8.html` — absent
- `design-mockups/README.md` — absent
- `memory/SESSION_2026_05_16.md` — absent (only `project_stavr_runtime_toggles.md`
  found in `memory/`)

The v8 visual refresh (Phase 3) is therefore implemented from the textual
description in the brief plus the existing tokens / page structure in
`src/dashboard/` — no canonical mockup HTML was available to copy verbatim.
The visual language stays close to the existing Dark 2.0 tokens with the
additions called out in §3.2 (rust-glow, bg-popover, backdrop blur).

The MCPs registry static list (Phase 4) was hand-curated from public knowledge
of the github.com/mcp directory — there is no `memory/SESSION_2026_05_16.md`
snapshot to draw from. Entries are best-effort and the URLs reflect the
public directory structure; users should refresh the list when github.com/mcp
publishes a stable export.

## Phase log

- Phase 1: branch + scaffold — done
