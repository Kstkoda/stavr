# BOM: Shadow Mode — Mode Resolver

**Owner:** CC
**Sensitivity:** `careful` — changes how autonomous work is executed and routed; no security primitives.
**Verification window:** `full` — steward-adjacent.
**Branch:** `feat/shadow-mode`
**Base:** `main`
**Estimated scope:** 6 phases, 3-4 PRs.

---

## Why this BOM exists

How a BOM gets executed — who drives it, on what brain, at what cost — is implicit today. This BOM builds the mode resolver per the design locked 2026-05-19 via 10-3-1 (memory `project_stavr_shadow_mode_design_2026_05_19`, corrected version).

## The design (locked — do not re-litigate)

**Three orthogonal axes** — all three apply independently:

1. **Driving mode** — `Interactive` (the operator drives via Cowork, the Steward observes) · `Autonomous-External` (the Steward drives, cloud brain) · `Autonomous-Local` (the Steward drives, local brain).
2. **Cost dial** — `Turbo` / `Balanced` / `Eco`, set per-BOM.
3. **Per-step executor override** — the "nitty-picky" axis: override the executor for a single step.

**Layered defaults + escape hatches at every level** (option #10). Important correction from the design memory: the cost dial (Turbo/Balanced/Eco) and the driving mode are *independent* — both apply; the cost dial is not replaced by the driving mode.

## Reference reading

- Memory: `project_stavr_shadow_mode_design_2026_05_19`, `project_cowire_dashboard_modes` (the Turbo/Balanced/Eco chips).
- Code: `src/steward/`, `src/steward-agent/runtimes/` (the brain/runtime selection), `src/types/stavr-bom.ts` (BOM schema — the cost dial is a BOM field), `src/dashboard/pages/helm.ts` (the existing mode chips).

## Don't-touch

- The 4-tier action model and the permission layers — Shadow mode is orthogonal to the action gate. It changes *how* work runs, not *whether* an action is allowed.

---

## Phases

- **Phase 0** — recon: the existing Turbo/Balanced/Eco chips on Helm, how the Steward currently selects a runtime/brain, the BOM schema. Output a findings doc.
- **Phase 1** — the mode resolver: a single resolver that computes `(driving mode, cost dial, executor)` for a given BOM/step from layered defaults + overrides.
- **Phase 2** — the driving-mode axis: Interactive / Autonomous-External / Autonomous-Local wired into how the Steward picks up and drives work.
- **Phase 3** — the cost-dial axis: Turbo/Balanced/Eco as a per-BOM field, feeding brain/runtime + budget selection.
- **Phase 4** — the per-step executor override.
- **Phase 5** — verification.

## Sensitivity & cadence

`careful`. Status check before/after commits; delta report per phase.

## PR grouping

- PR 1 — Phase 0 recon + Phase 1 (resolver).
- PR 2 — Phases 2-3 (driving mode + cost dial).
- PR 3 — Phase 4-5 (executor override + verification).

## Definition of done

1. The mode resolver computes all three axes from layered defaults with escape hatches at every level.
2. Driving mode, cost dial, and per-step executor override all function and are independent.
3. The cost dial is a per-BOM field and is not conflated with driving mode.
4. Full test suite green.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/shadow-mode-bom.md. Execute Phase 0 (recon) and STOP for operator review, then continue.

Sensitivity: careful. Status check before/after commits; delta report per phase.

Key correction baked into the design: the cost dial (Turbo/Balanced/Eco) and the driving mode are independent axes — both apply. Do not conflate them.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO -s. Branch feat/shadow-mode off main.

Go.
```

---

## End of BOM
