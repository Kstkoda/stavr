# Hygiene-Sweep Phase 0 — confirmed checklist (2026-05-21)

Re-verifying each item from `audit/10-summary.md` (branch `chore/full-codebase-audit`) against current `main` tip after #62 / #64 / #66. Where main has moved, the item is adjusted in place; where the item is now owned by another BOM, it's dropped.

## Items

### 1. Notifier per-channel timeout — KEEP (Phase 1)
`src/notify/notifier.ts` `dispatchAll()` (~line 206-220) awaits `ch.send(input)` with no timeout. A hanging HTTP channel retains the promise + closures indefinitely (footprint of finding #7 in audit/10). Trivial fix: wrap each send in `Promise.race(send, sleep(timeoutMs))` and record the timeout as a failed dispatch.

### 2. mDNS port misconfig — KEEP (Phase 1)
**Coordination:** family-mode Phase 1 owns the *async* error-handler fix (the bonjour "Service name is already in use" warning is asynchronous and bypasses the try/catch); family-mode Phase 3 owns the *naming* redesign (`stavr-self` collision). This sweep owns the port misconfig.

Root cause located: `src/transports.ts:1050` passes `opts.port!` to `federation.start`. When tests call `mountTransports(broker, { mode: 'daemon', port: 0, ... })` (ephemeral port for tests), the value 0 is forwarded into `bonjour-service.publish({ port: 0, ... })` which rejects it: `ServiceConfig requires \`port\` property to be set`. The error is emitted and logged by `mdns.on('error', ...)` (~40 warnings per `npm test`).

Fix: read the actual bound port from `s.address()` inside the listen callback and pass that to `federation.start`. Falls through cleanly when port was already specified.

### 3. Retention UNKNOWN-kind tracking — KEEP (Phase 1)
`src/observability/retention.ts` + `src/persistence.ts:766-837`. UNKNOWN classification is implemented and `unknownPreserved` is returned; the warn-log line in `persistence.ts:824` reports the count but NOT the kind names. So the operator sees the count climb (`1198 → 1861`) but can't extend the OPERATIONAL/AUDIT sets without grepping the DB.

Fix: have `pruneEvents()` also collect the distinct unknown kind names + per-kind counts, log them, and surface them in the `RetentionResult` so the daemon scheduler can emit them on the `retention_swept` event. The categorize-them-properly step is operator follow-up (data-driven) — the BOM scope is to make the data legible, not to guess at what kinds exist.

### 4. DEP0190 caller — KEEP (Phase 1), scope clarified
Located via `NODE_OPTIONS=--trace-deprecation`. Three test-side call sites:
- `tests/federation/bind.test.ts:41` (`spawnCli`)
- `tests/federation/pairing.test.ts:39` (`spawnDaemon`) + `:54` (`runCli`)
- `tests/federation/steward-bug-fix.test.ts:54` (`runCli`)

Pattern: `spawn('npx', ['tsx', cliEntry, ...args], { shell: isWindows })`. On Windows, `shell:true` combined with an args array triggers DEP0190 (Node 22+ promotes to error). The audit guessed `src/workers/shell.ts` or `src/security/host-exec-runner.ts` — both are fine; the offenders are tests.

Fix: replace the args-array+shell:true pattern with a quoted command string on Windows. Shared into `tests/utils/spawn-cli.ts` so the three callers converge.

### 5. empty-state.ts orphan — KEEP (Phase 1) — remove, do not wire
`src/dashboard/components/empty-state.ts` confirmed: zero external references (`renderEmptyState`, `EMPTY_STATE_CSS` not imported anywhere). v0.6.12 Phase 8 left this dangling. Decision: **remove**. The codebase already has "no data" surfaces shipped without it; retrofitting them is out of scope and would be its own visual decision.

### 6. placeholders.ts dead module — KEEP (Phase 1) — remove
Operator note: "src/dashboard/pages/placeholders.ts was modified by #66 — re-check whether it is actually dead." Re-checked:
- The file's `renderPlaceholderPage()` export has **zero callers** (`grep -r renderPlaceholderPage src tests` returns only its own definition).
- The grep for "placeholders" in src/ matches `src/dashboard/pages/helm.ts`, `home.ts`, `src/steward/planner.ts`, but those are **string mentions** (the word "placeholders" in a UI label or comment), **not** imports of this module. Verified by inspecting each match.
- The `SPECS` table inside placeholders.ts still names `topology, workers, plans, decide, toolkit, capabilities, settings` — but every one of those pages now has its own real implementation in `src/dashboard/pages/*.ts`.

Confirmed dead. Remove.

### 7. ADR-023 collision — KEEP (Phase 2)
Confirmed: both `adr/023-param-constraint-matching-syntax.md` AND `adr/023-shared-memory-on-stavr-daemon.md` exist. Free numbers in the 020s gap: **025, 026, 027, 029** (`024-reporting-cadences-and-channels` and `028-dashboard-architecture` are taken).

Choice: renumber `adr/023-shared-memory-on-stavr-daemon.md` → `adr/025-shared-memory-on-stavr-daemon.md`. Rationale: `023-param-constraint-matching-syntax.md` is older and more widely referenced; the shared-memory ADR is later and less-cited; and 025 is the first free slot. Fix the internal `# ADR 023` heading to match the new number.

### 8. Dead dashboard UI elements — KEEP (Phase 2)
The 12-element list from `audit/09-ui-substrate-gap.md` (still in effect after #66):

| Element | Page | Action |
|---|---|---|
| Helm L4 Steward intent input | `helm.ts:229` (now `data-role="l4-composer"`) | Label as parked (v0.7) — disable submit + tooltip |
| Helm L4 STEWARD button | `helm.ts:224` | Same — label as parked |
| Topology Ping action | `topology.ts:549` | Label as parked (matches Restart/Disable convention right next to it) |
| Topology Add (+) | `topology.ts:475` | Already parked (v0.7 badge) — verify no regression |
| Topology Edit (✎) | `topology.ts:475` | Already parked (v0.7 badge) — verify no regression |
| Topology inspector per-node charts (qps/p95/err/retry) | `topology.ts:539-542` | Label as parked or replace with empty-state |
| Topology inspector time-window buttons (5m/1h/24h/7d) | `topology.ts:533-536` | Label as parked (page JS doesn't respect them) |
| Topology Permissions drawer body | `topology.ts` | Already drawer-rendered; label inner body as parked |
| Settings "add no-go rule" button | `settings.ts` | Label as parked |
| Diagnostics heal Undo / Deny | `diagnostics.ts:873-874` | Label as parked (real wiring is a separate BOM) |
| Capabilities model SAVE | `capabilities.ts:352` | Already labelled read-only — verify visible label |
| Streams pane expand (⤢) — now Workers page after #66 | `workers.ts` (was `streams.ts:122-123`) | Label as parked OR remove the button |

The convention to apply: add `data-parked="v0.7"` + a `title=` tooltip + `aria-disabled="true"` so the operator gets feedback. Two of the entries (Topology Add/Edit) are already in this state per the audit table — verify and move on. The work is per-element-trivial, aggregate-medium.

### 9. Heap snapshots in repo root — DROPPED (out of hygiene-sweep scope)
Finding #15: two pre-leak-fix heap snapshots in repo root. Operator decision territory (cleanup of one-off artefacts vs preserving for post-mortem). Not coded — skip in this BOM.

### 10. Test heap-snapshot bloat (#19) — DROPPED (out of scope)
Finding #19 (tests write 37–43 MB heap snapshots into `tmp/`). The recommended action is gating writes behind `STAVR_TEST_ALLOW_SNAPSHOTS`. This touches `src/observability/debug-endpoints.ts` which is observability primitives. Out of "long-tail hygiene"; better filed as its own small BOM if the operator wants it.

### 11. PeerRegistry listener dispose (#20) — DROPPED (out of scope)
Finding #20. The audit calls this LOW; the fix is a small refactor of `peer-registry.ts` extending EventEmitter. Borderline — the BOM brief lists items #5, #7, #8, #11, #15–#20, but #20 isn't on this BOM's enumerated list. Skip.

## Coordination summary

- **mDNS work split:**
  - Family-mode Phase 1 owns the async `'error'` listener on `advertised` / `browser` (~6 lines).
  - Family-mode Phase 3 owns the `stavr-self` peer-id naming redesign.
  - This sweep owns the `port: 0` → resolved-port handoff in `src/transports.ts`.
  - All three are independent — no overlap.
- **Don't-touch:** security primitives, persistence schema, anything family-mode owns. None of the Phase 1/2 fixes here cross into either.

## What lands in each phase

- **Phase 1 (code hygiene):** items 1, 2, 3, 4, 5, 6.
- **Phase 2 (ADR renumber + dead UI):** items 7, 8.
- **Phase 3 (verification + run summary):** no code; clean test/build/tsc + final report.
