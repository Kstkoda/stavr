# CC Hygiene-Sweep — overnight run summary (2026-05-21)

**Branch:** `feat/hygiene-sweep` (pushed to `origin`)
**Base:** `main` at the time of branching
**Commits:** 3 (one per phase, all DCO `-s`)
**Final test state:** 1584 passed, 1 skipped. `npm run build` clean. `npx tsc --noEmit` clean.
**Approval gates fired:** 0 (autonomous local-only run as designed).
**PR opened / merged:** none (per execution mode override of the BOM's "PR grouping" section).

## Phase commits

| Phase | SHA | Subject |
|---|---|---|
| 0 | `cb9b8b7` | docs — confirmed checklist against current main |
| 1 | `25d48c0` | code hygiene (notifier timeout, retention kinds, DEP0190, mDNS port, dead modules) |
| 2 | `a574ca8` | ADR-023 renumber + dead-UI honesty pass |

## What the BOM asked for vs what landed

| BOM item | Status |
|---|---|
| Notifier per-channel timeout | ✅ `src/notify/notifier.ts` — `channelTimeoutMs` opt (default 10s); `dispatchAll` wraps each send in `Promise.race` against a `setTimeout`. Timed-out send recorded as failed dispatch. |
| mDNS port misconfig | ✅ `src/transports.ts:1042-1054` — read `s.address().port` inside the listen callback and forward the resolved port into `federation.start`. The ~40 `ServiceConfig requires port property to be set` warnings per `npm test` are now 0. (Coordinated with family-mode Phase 1/3, which own different mDNS items — no overlap.) |
| Retention UNKNOWN-kind tracking | ✅ `pruneEvents()` now emits per-kind counts via `unknownKinds` on `RetentionResult`; the warn log includes the names; the `retention_swept` event payload carries them so the operator can extend `OPERATIONAL_KINDS`/`AUDIT_KINDS` from the data. |
| DEP0190 caller | ✅ Located via `NODE_OPTIONS=--trace-deprecation` in four test files (the audit guessed `src/workers/shell.ts`/`src/security/host-exec-runner.ts` — both fine). Fix: invoke tsx via node directly with the resolved `tsx/dist/cli.mjs`, bypassing `npx`/`shell:true` entirely. DEP0190 count: 4 → 0. |
| empty-state.ts orphan | ✅ Removed. Zero callers; retrofitting the existing "no data" surfaces was deliberately left out of scope (separate visual decision). |
| placeholders.ts dead module | ✅ Removed after re-verification post-#66 (operator note). Zero callers; every page in the SPECS table has its own real implementation now. |
| ADR-023 collision | ✅ `adr/023-shared-memory-on-stavr-daemon.md` → `adr/025-shared-memory-on-stavr-daemon.md` (first free slot). Internal heading updated. Cross-refs updated in ADR-032, ADR-044, `adr/README.md`. The `src/trust/matcher.ts` "Per ADR-023" comment correctly refers to the param-constraint ADR (which kept 023) — left unchanged. |
| Dead dashboard UI elements | ✅ Honesty pass applied: Helm L4 STEWARD/composer, Topology Ping + per-node charts + time-window buttons, Diagnostics heal Undo/Deny, Capabilities model dropdown + pin toggle — all now `data-parked="v0.7"` + `aria-disabled="true"` + `disabled` + tooltip. Topology Add/Edit were already parked. Two items the audit listed turned out to be wired (Settings "add no-go rule" — verified `postJson` to `/dashboard/settings/nogo`; Streams pane expand — wired to the fullscreen-tail handler after #66 rename to Workers). Noted in the Phase 2 commit and Phase 0 recon. |

## What I deliberately did NOT do

- **No PR opened / no merge** — execution mode override of the BOM's "PR grouping" section was explicit in the kickoff prompt.
- **mDNS async-error-handler fix.** Family-mode Phase 1 owns it; would have been duplicative. The Phase 0 recon documents the split.
- **mDNS `stavr-self` naming redesign.** Family-mode Phase 3 owns it. Out of scope.
- **Retention `unknownKinds` categorisation.** This sweep makes the data legible (names + counts); the operator (or a follow-up BOM) decides how to extend `OPERATIONAL_KINDS`/`AUDIT_KINDS` once data accumulates in real workloads. Guessing categorisations now would be cargo-cult work.
- **Wiring the parked dashboard elements.** Each parked element has a v0.7 follow-up (e.g., `/dashboard/api/topology/:nodeId/metrics` for the per-node charts). Wiring is out of scope for a hygiene sweep; "honest signal" is the deliverable.
- **Tests-write-heap-snapshots fix** (audit #19) — recommended action touches observability primitives; sized as a separate small BOM.
- **Pre-fix heap snapshots in repo root** (audit #15) — operator decision territory, not coded.
- **PeerRegistry listener dispose refactor** (audit #20) — outside the BOM's enumerated list (#5, #7, #8, #11, #15–#20).

## File list (3 commits combined)

```
Phase 0:
  + proposed/hygiene-sweep-recon.md

Phase 1:
  M src/daemon.ts
  M src/notify/notifier.ts
  M src/observability/retention.ts
  M src/persistence.ts
  M src/transports.ts
  M tests/cli/start-unification.test.ts
  M tests/federation/bind.test.ts
  M tests/federation/pairing.test.ts
  M tests/federation/steward-bug-fix.test.ts
  D src/dashboard/components/empty-state.ts
  D src/dashboard/pages/placeholders.ts

Phase 2:
  R adr/023-shared-memory-on-stavr-daemon.md → adr/025-shared-memory-on-stavr-daemon.md
  M adr/032-steward-model-portable-agent.md
  M adr/044-streamable-http-transport-migration.md
  M adr/README.md
  M src/dashboard/pages/capabilities.ts
  M src/dashboard/pages/diagnostics.ts
  M src/dashboard/pages/helm.ts
  M src/dashboard/pages/topology.ts
```

Nothing in the don't-touch list was modified: security primitives, persistence schema (the `pruneEvents` change is additive — one new field on `RetentionResult`, no schema or table change), the permission model, and anything family-mode owns all stayed put.

## Final verification (branch tip)

- `npx tsc --noEmit`: clean
- `npm run build`: clean
- `npm test`: **1584 passed, 1 skipped** (the one intentional soak skip)
- `npm test` DEP0190 warning count: **0** (was 4)
- `npm test` `ServiceConfig requires \`port\` property to be set` warning count: **0** (was ~40)

## Behaviour you'll see

- A notification channel that hangs no longer leaks the dispatch promise; it now records a clean `channel send timed out after 10000ms` failure after the configurable timeout.
- The `retention_swept` event now carries `unknown_kinds: [{ kind, count }, ...]` — visible via `stavr tail`. The warn log line includes the names too.
- The Helm L4 strip is honest about being non-interactive until v0.7; the Topology drawer's Ping button + time-window buttons + per-node charts all read as parked rather than mysteriously inert.

## Open follow-ups (not in this BOM)

1. **Wire each parked dashboard element.** The parked-pill is honest scaffolding; the actual substrate (heal Undo/Deny → `respond_to_decision`; per-node charts → new `/dashboard/api/topology/:nodeId/metrics`; etc.) is the audit's recommended #9 + #6 ("CI lint that flags `data-role`/`data-action` whose value isn't in any handler"). Worth a dedicated BOM.
2. **`unknownKinds` categorisation pass.** Now that names are surfaced, run the daemon under realistic load for a day or two, read the `retention_swept` events, and extend `OPERATIONAL_KINDS`/`AUDIT_KINDS` accordingly.
3. **Tests heap-snapshot bloat** (audit #19) — gate test-time snapshot writes behind `STAVR_TEST_ALLOW_SNAPSHOTS`. ~37–43 MB written into `tmp/` per `npm test`.

— CC
