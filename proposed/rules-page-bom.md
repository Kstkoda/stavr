# BOM: Rules Page

**Owner:** CC
**Sensitivity:** `high` — builds the operator's policy-editing surface (no-go list, approval rules). A wrong autonomous change here weakens enforcement. Operator approval gate between every phase.
**Verification window:** `full`.
**Branch:** `feat/rules-page`
**Base:** `main`
**Depends on:** **family-mode Phase 1** — the enforcement wiring. A Rules editor over rules that are not actually enforced is theater. Do NOT crunch this BOM until Phase 1's enforcement phases (2-4) have merged.
**Estimated scope:** 7 phases, 4-5 PRs.

---

## Why this BOM exists

stavR's rules (no-go list, approval policy, routing) are sourced loosely today. This BOM builds the Rules page — the operator's single surface for viewing and editing policy — per the design locked 2026-05-19 via 10-3-1 (memory `project_stavr_rules_page_design_2026_05_19`).

## The design (locked — do not re-litigate)

Hybrid model, option #10:
- Rules are **sourced statically as YAML** (the version-controlled source of truth).
- Rules are **edited via a dashboard Rules page** (mirrors the no-go-editor guardrails).
- A **Steward composition layer** composes the applicable rule subset per `(BOM, actor, tier, data_class, federation_context)`.
- The Rules page **subsumes the no-go-list editor** as its first content type.
- **Workers receive their applicable rule subset at spawn time.**

## The 7 guardrails (from the no-go dashboard-edit decision, memory `project_stavr_no_go_dashboard_edit_decision`)

Any dashboard edit of a rule must: (1) be audit-logged; (2) require a 30+ character reason; (3) require a passkey signature for *removes*; (4) show a diff before commit; (5) honour a configurable cooling-off; (6) be reversible for 24h per change; (7) sync to the YAML source as a patch.

## Reference reading

- Memory: `project_stavr_rules_page_design_2026_05_19`, `project_stavr_no_go_dashboard_edit_decision`, `project_stavr_four_tier_approval_model`.
- `adr/045-mcp-server-trust-model.md`, the family-mode Phase 1 BOM (enforcement is the substrate this surface edits).
- Code: `src/trust/no-go-list.ts`, `src/security/policies-yaml.ts`, `src/security/policies.ts`, `src/security/webauthn.ts`, `src/dashboard/pages/permissions.ts`.

---

## Phases

- **Phase 0** — recon: current rule sources (`policies-yaml.ts`, `no-go-list.ts`), the no-go editor state, the WebAuthn passkey path. Output a findings doc.
- **Phase 1** — YAML rule source + schema: a single versioned YAML rule format with a strict schema.
- **Phase 2** — the Steward composition layer: compose the applicable rule subset per `(BOM, actor, tier, data_class, federation_context)`.
- **Phase 3** — the dashboard Rules page editor, with all 7 guardrails enforced.
- **Phase 4** — migrate the no-go-list editor in as the Rules page's first content type.
- **Phase 5** — workers receive their applicable rule subset at spawn time.
- **Phase 6** — verification.

## Sensitivity & cadence

`high`. Operator approval gate between every phase; full diff per phase. This is policy/security surface.

## PR grouping

- PR 1 — Phase 0 recon + Phase 1 (YAML source + schema).
- PR 2 — Phase 2 (composition layer).
- PR 3 — Phase 3 (Rules page editor + guardrails).
- PR 4 — Phases 4-5 (no-go migration + worker subset).
- PR 5 — Phase 6 verification.

## Definition of done

1. Rules are versioned YAML; the dashboard editor writes back as YAML patches.
2. All 7 guardrails enforced on every dashboard edit.
3. The composition layer resolves the correct rule subset per the 5-tuple.
4. The no-go editor lives inside the Rules page.
5. Workers receive their rule subset at spawn.
6. Full test suite green; the rules edited here are demonstrably the rules enforced (per family-mode Phase 1).

## Run prompt for CC

```
Read CLAUDE.md, then proposed/rules-page-bom.md. CONFIRM family-mode Phase 1 enforcement (phases 2-4) has merged before starting — if not, stop and hand back. Then execute Phase 0 (recon) and STOP for operator review.

Sensitivity: high. Operator approval gate between EVERY phase. Full diff per phase. NOT a continuous run.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO -s. Branch feat/rules-page off main.

Go — Phase 0 only.
```

---

## End of BOM
