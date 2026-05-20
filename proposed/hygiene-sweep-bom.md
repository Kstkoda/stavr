# BOM: CC Hygiene-Sweep

**Owner:** CC
**Sensitivity:** `careful` — a set of small independent fixes; mostly reversible, no security primitives.
**Verification window:** `targeted`.
**Branch:** `feat/hygiene-sweep`
**Base:** `main`
**Estimated scope:** ~8 items, 4 phases, 2 PRs.

---

## Why this BOM exists

CC's full codebase audit (branch `chore/full-codebase-audit`, `audit/10-summary.md`) found the codebase in good shape but with a long tail of cheap fixes that would noticeably lift hygiene. This BOM lifts that prose into an executable sweep.

## Phase 0 — Read the audit

Read `audit/10-summary.md` on branch `chore/full-codebase-audit` for the full per-item detail. Output a checklist confirming each item's current state — some may already be fixed by intervening work; drop those.

## The items

- **notifier per-channel timeout** — a notifier channel can hang the notify path; add a bounded per-channel timeout.
- **mDNS port misconfig** — *coordinate:* the mDNS async-error-handler fix is in family-mode Phase 1; the mDNS naming redesign (`stavr-self` collision) is family-mode Phase 3. This sweep handles only whatever "port misconfig" is that those two do not. Phase 0 disambiguates; if it is already covered, drop it.
- **retention UNKNOWN-kind tracking** — the retention sweep logs uncategorized event kinds (`unknown_count` observed climbing 1198→1861 in 12h on 2026-05-20). Categorize the unknown kinds in `src/observability/retention.ts` (task #41).
- **DEP0190 caller** — a Node deprecation warning; fix the offending call site.
- **empty-state.ts orphan** — `src/dashboard/components/empty-state.ts` exists but is not wired in. Wire it or remove it.
- **placeholders.ts dead module** — `src/dashboard/pages/placeholders.ts` is dead code. Remove it.
- **ADR-023 number collision** — two ADR-023 files: `adr/023-param-constraint-matching-syntax.md` and `adr/023-shared-memory-on-stavr-daemon.md`. Renumber one into a free gap (025/026/027/029 are unused) and fix its internal `# ADR 023` heading to match.
- **~12 dead dashboard UI elements** — unlabelled elements that silently no-op (Helm L4 Steward input, Topology Ping, Diagnostics heal Undo/Deny, per-node charts, etc.). Per the no-orphan-components rule: wire each to a real path, or honestly label it as not-yet-functional. Phase 0's checklist enumerates the exact set from the audit.

## Don't-touch

- Anything the family-mode Phase 1/2/3 BOMs own — coordinate, do not duplicate. The mDNS items especially.
- Security primitives, persistence schema.

---

## Phases

- **Phase 0** — read the audit, produce the confirmed checklist.
- **Phase 1** — code hygiene: notifier timeout, retention unknown-kinds, DEP0190, the dead modules (empty-state wiring/removal, placeholders removal).
- **Phase 2** — ADR-023 renumber + the dead-dashboard-element pass.
- **Phase 3** — verification: `npm test` + build + `tsc` clean; the no-orphan-components rule holds.

## Sensitivity & cadence

`careful`. Status check before/after commits; one delta report per phase.

## PR grouping

- PR 1 — Phase 0 checklist + Phase 1 (code hygiene).
- PR 2 — Phase 2 (ADR renumber + dead UI) + Phase 3 verification.

## Definition of done

1. Every audit hygiene item is either fixed or explicitly confirmed already-resolved/out-of-scope in the Phase 0 checklist.
2. No dead modules remain; no DEP0190 warning.
3. ADR numbering has no collision.
4. No dead dashboard element — each is wired or honestly labelled.
5. Full test suite green.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/hygiene-sweep-bom.md. Execute Phase 0 — read audit/10-summary.md on branch chore/full-codebase-audit, output the confirmed checklist, then continue through Phases 1-3.

Sensitivity: careful. Status check before/after commits; delta report per phase. Coordinate the mDNS item with family-mode Phases 1/3 — do not duplicate their work.

Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. One commit per phase, DCO -s. Branch feat/hygiene-sweep off main.

Go.
```

---

## End of BOM
