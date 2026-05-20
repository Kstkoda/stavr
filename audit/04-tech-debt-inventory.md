# Audit 04 — Tech Debt Inventory

> Grep-driven catalogue of unfinished, hacked, or deferred surfaces. Scope: `src/**/*.ts` (198 files) + `governor/src/**/*.rs`.

## Headline

| Category | Count | Verdict |
|---|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` comments | **0** | unusually clean — the team uses explicit phase annotations instead |
| `as unknown as` casts | **20** | all defensive: dynamic imports, runtime probes, Zod enum casts |
| `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` | **0** | clean — no escape hatches |
| `any[]` in function signatures | **0** | clean |
| Phase / version deferrals (v0.5/v0.6/v0.7/v1.0 in comments) | **157** | expected — release-cycle phasing |
| Placeholder / stub markers ("placeholder", "stub", "for now", "not yet wired") | **80** | mostly UI scaffolding + test injection seams |
| Empty function bodies (`return; / return null;` that look abandoned) | **0** | clean |
| Unimplemented platform branches (Rust) | **1** | `governor/src/restart.rs:195` — non-Windows path |

**Overall:** the codebase scores well on the "inline debt" axis. The honesty problem isn't *hidden* debt — it's that ~157 v0.6.x/v0.7/v1.0 markers exist *because* features are deliberately phased. The risk is that as v0.7 ships, those markers must be promoted to real implementations and not silently retained.

## 1. Type escape hatches (`as unknown as`) — 20 instances, all justified

| File | Count | Reason |
|---|---|---|
| `src/adapters/github.ts` | 2 | dynamic import + ExecRunner unsafe |
| `src/broker.ts` | 2 | event payload shape access |
| `src/cli.ts` | 1 | better-sqlite3 instance property access |
| `src/credentials/vault.ts` | 1 | optional Windows credential import (`wincred`) |
| `src/notify/channels/email.ts` | 1 | nodemailer dynamic import |
| `src/observability/debug-endpoints.ts` | 1 | `process.report` internal probe |
| `src/observability/memory-poller.ts` | 1 | `handle.unref()` optional method |
| `src/observability/perf-poller.ts` | 1 | same |
| `src/observability/rss-watchdog.ts` | 1 | same |
| `src/steward-agent/autonomy/reactive.ts` | 1 | `NodeJS.Timeout` forward reference |
| `src/steward-agent/runtimes/schemas.ts` | 2 | Zod enum tag casting |
| `src/steward-bug-fix-cli.ts` | 1 | scope payload access |
| `src/steward/executor.ts` | 2 | dynamic step property access |
| `src/tools/registry.ts` | 2 | MCP server proto introspection |
| `src/transports.ts` | 1 | transport `_writable` property probe |

None of these are "real" type violations — each one accesses runtime truths TypeScript cannot express statically (dynamic import, optional Windows-only module, `unref` on opaque handles, schema-tag down-cast, SDK private field). Risk: **LOW**.

## 2. Version deferrals — 157 instances

Strategic, not debt. Grouped by deferral target:

| Target | Count | Where it lives |
|---|---|---|
| v0.6.x (in-flight, phases 2–12) | 68 | dashboard (90%), event-types, transports, daemon |
| v0.7 (next major) | 38 | dashboard (95%), federation, server, types |
| v1.0 (long-term) | 8 | `federation/peer-client.ts`, `persistence/operator-credentials`, `federation/index.ts` |
| Unversioned ("for now") | 43 | dashboard pages, steward, security |

### High-impact examples (per file:line)

| Location | Marker |
|---|---|
| `src/dashboard/pages/capabilities.ts:551` | "Read-only · v0.6.12. … Save-flow lands in v0.7" |
| `src/dashboard/pages/mcps.ts:327` | "Install for X lands in v0.7 (ADR-035 — OAuth 2.1 + RI)" |
| `src/federation/peer-client.ts:3` | "WebRTC deferred to v1.0 … v0.7 runs over HTTP LAN" |
| `src/dashboard/pages/tools.ts:66` | "Per-tool invocation tracking lands in v0.6.9 PR #2" |
| `src/steward/planner.ts:435` | "Wattage card (v0.5) tracks separately" |

### Per-directory breakdown

| Directory | Count |
|---|---|
| dashboard | 90 |
| federation | 12 |
| event-types | 11 |
| transports | 12 |
| security | 9 |
| observability | 4 |
| persistence | 3 |
| server | 4 |
| steward | 3 |

**Risk:** **LOW–MEDIUM.** Risk grows once v0.7 ships if these markers are not actively retired. Recommend linking each marker to a specific ADR/issue (e.g., `// ADR-035 §3 Phase 2` instead of `// v0.7`).

## 3. Placeholder / stub markers — 80 instances

| Type | Count | Examples |
|---|---|---|
| UI scaffolding ("honesty stubs") | 35 | `src/dashboard/index.ts:119` ("render honesty stubs in Phase 2 and are filled in Phase 4"); `src/dashboard/pages/helm.ts:18` ("sparklines are deterministic stubs derived from event_count"); `src/dashboard/pages/diagnostics.ts:1420` ("empty/stub state") |
| Test injection points | 12 | `exec?`, `git?`, `driver?`, `fetcher?` — optional doubles in interfaces |
| Deferred wiring ("not yet wired") | 8 | tracking counts, invocation metrics, data pipelines |
| Runtime markers ("for now") | 25 | operator-declared status, conservative notification rules |

**Risk:** **LOW.** UI stubs are intentional honesty scaffolding (v0.6.12 design pattern). Test injection points are clean contracts. No abandoned dead code. **But** they cross-reference audit/09 — the UI substrate gap audit found 28 placeholder + 12 dead UI elements, several of which are *not* labelled and therefore confuse the operator.

## 4. Empty / no-op function bodies — 0

No abandoned function bodies found. The codebase either implements fully, uses clean abstract patterns, or exposes explicit optional test seams.

## 5. Governor (Rust) — 1 instance

```
governor/src/restart.rs:195
  Err(std::io::Error::new(
    std::io::ErrorKind::Unsupported,
    "process kill not implemented for this platform",
  ))
```

Non-Windows branch; expected — the governor is Windows-first for tray integration. Risk: **LOW** (consciously scoped).

## Cross-reference

| Concern raised here | Confirmed in other audit |
|---|---|
| 90 "v0.7" markers in dashboard | audit/09 found 28 placeholder + 12 dead UI elements; these match |
| `// stub` placeholders in topology | audit/09 lists topology Add/Edit/Restart/Disable/Ping as placeholders |
| Phase markers in `event-types.ts` (11) | audit/05 marks ADR-041 (universal signal trace) as PARTIAL — phase markers track that gap |
| Phase markers in `federation/` (12) | audit/05 marks ADR-042 as PARTIAL |
| Phase markers in `steward/` and `steward-agent/` | audit/05 marks ADR-032 as PARTIAL; audit/03 Gap #2 flags steward as the weakest-tested module |

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Add a CI lint that surfaces every `// v0.7` / `// for now` / `// stub` marker and grows the list over time, so a v0.7 release blocker is "no v0.7 markers remain" | small |
| 2 | Replace freeform `// v0.7` with `// ADR-NNN §X phase Y` so markers retire with ADR status changes | trivial per file; medium aggregate |
| 3 | Promote the 12 *unlabelled* dead UI elements from audit/09 into proper placeholder markers (visible to operator) | trivial |
| 4 | Don't add `as any` or `@ts-ignore` to fix new bugs — current zero count is a quality signal worth defending | culture / lint |
