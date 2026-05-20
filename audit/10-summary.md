# Audit 10 — Summary

> Top 20 findings across the nine audit docs, ranked by severity. Each line: one-line description, file:line (where applicable), recommended fix size (trivial / small / medium / BOM-worthy).

## Headline take

The codebase is in good shape. Tests are green (1401/1402, one intentional skip), no inline TODO/HACK debt, no unused dependencies, no unreachable code branches, no GPL contamination. The audit surfaced **two structural risks** worth addressing in the next BOM and **a long tail of cheap fixes** that would noticeably lift hygiene.

**The two structural risks:**

1. **Security enforcement is opt-in, not structural.** The no-go list, Layer-1 actor permission tier, and Tier-3 friction string are each designed but enforced at only a subset of call sites. A regression that adds a tool without routing through `gatedAction()` silently bypasses the no-go list. Severity: high. (Findings #1–#3.)

2. **The substrate-vs-UI gap is real and partly unlabelled.** ~55% of dashboard interactive elements reach working substrate. Most placeholders are honestly badged with `v0.7`, but ~12 are unlabelled-dead — the operator clicks, nothing happens, no toast, no error. Severity: medium for individual elements, high in aggregate because trust in the UI degrades quickly when "buttons silently do nothing" is the operator's lived experience. (Finding #9; audit/09.)

## Top 20

| # | Finding | File:line | Source | Severity | Fix size |
|---:|---|---|---|---|---|
| 1 | **No-go list only enforced via `gatedAction()` wrapper** — connector writes, steward dispatch, worker spawn beyond tier gate, and credential reads all bypass | `src/tools/gated-action.ts:78` (sole call site) | audit/06 | **HIGH** | medium / BOM-worthy |
| 2 | **Layer-1 per-actor tier never checked at tool invocation** — matrix table populated, dashboard renders it, no code path calls `ActorPermissionStore.resolve()` before the handler | `src/security/actor-permissions.ts` vs `src/server.ts:294-301` | audit/06 | **HIGH** | medium |
| 3 | **Tier-3 friction string is dishonest UI** — three independent strings in tooltips, categories, and tools page tell the operator a typed string will be required; no code path accepts one; `requireRecentTier3Assertion()` exists at `src/security/tier3-gate.ts:55-102` but only referenced from `dashboard/pages/family-mode.ts:161` (UI hint, not a gate) | as above | audit/06, audit/09 | **HIGH** | medium |
| 4 | **Append-only event log is not tamper-evident** — no hash chain, no signatures; ADR-036 designs this but is still Proposed | `src/persistence.ts:144-159` | audit/06, audit/05 | MEDIUM (HIGH if hostile-process threat model applies) | BOM-worthy |
| 5 | **ADR-023 number collision** — two ADR files share number 023 (param-constraint-matching-syntax + shared-memory-on-stavr-daemon) | `adr/023-*.md` | audit/05 | MEDIUM (organizational) | trivial |
| 6 | **Steward subprocess scaffolded but not cut over** — `src/steward-agent/` is a parallel codebase to `src/steward/`; in-process loop is the live path; ADR-032 partial; cross-codebase drift risk grows over time | `src/steward/loop.ts` (live) + `src/steward-agent/` (dormant) | audit/01, audit/05, audit/07 | MEDIUM | BOM-worthy (the cutover itself) |
| 7 | **Notification dispatch has no per-channel timeout** — promise + closures retained indefinitely if HTTP channel hangs; race shape confirmed by test transcript (`WARN: notifier: background dispatch threw {"error":"The database connection is not open"}`) | `src/notify/notifier.ts:168-174` | audit/08, audit/06 | MEDIUM | trivial |
| 8 | **Federation mDNS warns ~40× per test run** — `ServiceConfig requires \`port\` property to be set`; either tests leak real mDNS or production config path also fires the warn-and-continue path masking a real misconfig | `src/federation/mdns.ts` | audit/03, audit/06, audit/08 | MEDIUM | small |
| 9 | **Unlabelled dead UI elements** — 12 dashboard interactive elements (Helm L4 Steward input, Topology Ping, Diagnostics heal Undo/Deny, per-node charts, etc.) click to silent no-op; cf. 28 *labelled* `v0.7` placeholders which are correctly honest | `src/dashboard/pages/{helm,topology,diagnostics,capabilities}.ts` (see audit/09 table) | audit/09 | MEDIUM (aggregate) | small per element, medium total |
| 10 | **Credential reads not scope-gated** — `CredentialGrantRecord.steward_session_id` stored on grants but never checked at read; no `credential_read` audit event emitted | `src/credentials/store.ts:29-38` (stored), no enforcement site | audit/06 | MEDIUM | small |
| 11 | **Retention silently preserves uncategorised event kinds** — `pruneEvents: uncategorized event kinds preserved` warned during test run; ADR-030 says "never delete UNKNOWN" so growth is unbounded over time | `src/observability/retention.ts` | audit/03, audit/05, audit/08 | LOW–MEDIUM (long-tail growth) | trivial (track) + small (categorise) |
| 12 | **Test coverage gaps on the substrate that matters** — `src/credentials/vault.ts` has 1 test file for 5 src files; `src/steward/` has 0.38 test-to-src ratio; `src/broker.ts` has no dedicated suite | per audit/03 Gap #1, #2, #4 | audit/03 | MEDIUM | medium |
| 13 | **Host-exec ordering inverts intuition** — scope check runs before allowlist check; a stale-but-active scope plus a freshly-banned command would pass | `src/security/host-exec-tool.ts:121` (scope) vs `:150-176` (allowlist) | audit/06 | LOW–MEDIUM | trivial |
| 14 | **Trust scopes have no per-session granularity** — once granted, a scope is global; one Steward session can use a scope granted to another | `src/trust/store.ts findActiveScopeFor()` | audit/06 | MEDIUM (privacy / accountability) | small |
| 15 | **Two pre-fix heap snapshots in repo root** — `Heap.20260519.*.heapsnapshot` (~37 MB + truncated 0 B) from pre-leak-fix 8 GB heap event; post-fix 48h soak verification still open | repo root | audit/08 | LOW (operational verification, not code) | medium (operational) |
| 16 | **Orphaned file `empty-state.ts`** — exported `EMPTY_STATE_CSS` and `renderEmptyState()` created v0.6.12 Phase 8, never integrated; zero refs in src/ and tests/ | `src/dashboard/components/empty-state.ts` | audit/07 | LOW | trivial |
| 17 | **Dead module `placeholders.ts`** — v0.3 C1–C9 scaffold; `renderPlaceholderPage()` zero external refs; module still loaded | `src/dashboard/pages/placeholders.ts` | audit/07 | LOW | trivial |
| 18 | **DEP0190 child-process deprecation** — one occurrence in test transcript ("args to a child process with shell option true can lead to security vulnerabilities"); Node 22 will promote to error; call site to locate (likely `src/workers/shell.ts` or `src/security/host-exec-runner.ts`) | TBD | audit/03, audit/08 | LOW (today), MEDIUM (when Node 22 lands) | small |
| 19 | **Tests write 37–43 MB heap snapshots into `tmp/` during normal `npm test`** — debug-endpoint test paths exercise the real heap/cpu writer; bloats dev workspaces | `src/observability/debug-endpoints.ts` exercised by tests | audit/03, audit/08 | LOW | trivial |
| 20 | **Peer registry has no explicit listener dispose** — `src/federation/peer-registry.ts` extends EventEmitter; dashboard widgets subscribe; cleanup depends on page lifecycle, not a return value | `src/federation/peer-registry.ts:24` | audit/08 | LOW | small |

## Themes

### Theme A — opt-in security enforcement
Findings #1, #2, #3, #10, #13, #14. The architecture is well-designed; the call sites are inconsistent. A structural fix (universal middleware that wraps `server.registerTool()` with no-go + actor-permission + tier-3 checks) would close most of these in one BOM.

### Theme B — UI ahead of substrate
Findings #3, #9. Cross-cuts security (Tier 3 strings are the most-visible dishonest UI). Either label every unlabelled dead element with the existing `parked-pill` / `v0.7` convention, or wire the substrate. A CI lint that fails on `data-role` / `data-action` attributes whose value doesn't appear in any handler registration would prevent regression.

### Theme C — long-tail hygiene
Findings #5, #7, #8, #11, #15–#20. Most are trivial individual fixes. Could be bundled into a "hygiene sweep" BOM with predictable scope.

### Theme D — parallel codebases
Finding #6 (steward in-process vs subprocess). Not dead code, but it carries duplication cost until ADR-032 cutover lands. Worth a project-level decision: keep both or accelerate the cutover.

## Recommended BOMs (sizing)

| BOM | Findings | Size |
|---|---|---|
| `BOM: structural security enforcement` | #1, #2, #3, #10, #13, #14 | medium–large |
| `BOM: substrate behind every dashboard click` | #9 (12 elements) + CI lint to prevent regression | medium |
| `BOM: audit integrity (hash chain + Ed25519)` | #4 | large; depends on ADR-039 if signing moves to Rust |
| `BOM: hygiene sweep` | #5, #7, #8, #11, #15–#20 | small–medium aggregate |
| `BOM: steward subprocess cutover` | #6 | medium; unblocks ADR-040 |

## What's working well

For balance — the audit also surfaced things worth defending:

- Zero TODO / FIXME / HACK / XXX comments. Phasing is explicit.
- Zero `as any`, zero `@ts-ignore`. The 20 `as unknown as` casts are all defensive (dynamic imports, optional native modules, runtime probes).
- Zero unused dependencies, zero missing dependencies.
- Tests pass (1401/1402) at 25.9s wall time.
- Append-only event store is durable (WAL) and lifecycle-tested.
- Retention runs on schedule with correct kind-aware policy.
- Memory-leak fix from 2026-05-19 is observed in the cleanup pattern; 48h soak verification is the open work item.
- No dead routes, no unreachable branches, no commented-out code blocks.
- Visual conventions from CLAUDE.md (no deprecated `topo-bus` / `topo-mode-chips` / `enterprise bus` in active code) are respected.
