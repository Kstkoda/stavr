# Audit 05 — ADR Drift

> For every ADR in `adr/`, status of the decision against the live code. Implemented / partial / contradicted / proposed.

## Headline

| Status | Count |
|---|---|
| Implemented (decision matches code) | 18 |
| Partially implemented | 8 |
| Proposed / architected only (no code yet) | 7 |
| Architecturally honoured (no code change required) | 1 (ADR-034, positioning) |
| **Structural defects** | ADR-023 number collision + 6 missing slots (010, 011, 025, 026, 027, 029) |

## Structural defects (fix before next ADR is written)

### ADR-023 collision

Two files share the number:
- `adr/023-param-constraint-matching-syntax.md` (2026-05-12) — trust scope param constraint grammar
- `adr/023-shared-memory-on-stavr-daemon.md` (2026-05-14) — shared-memory layer on daemon

The shared-memory ADR is the newer one. Rename to `024-shared-memory-on-stavr-daemon.md` and renumber any downstream cross-references. Until done, anyone looking up "ADR-023" gets whichever file `ls` sorts first.

### Missing slots

010, 011, 025, 026, 027, 029 are absent. Add a `README.md` line in `adr/` listing intentional gaps (proposals that were never written) so future audits don't keep flagging them.

## Per-ADR status

| ADR | Title | Status | Evidence |
|---|---|---|---|
| 001 | stdio + SSE dual transport | **Implemented** | `src/transports.ts` mounts both; `src/shim.ts` for stdio↔HTTP shim. Streamable HTTP replaced SSE per spec 47. |
| 002 | SQLite not Postgres | **Implemented** | `src/persistence.ts:1` `import Database from 'better-sqlite3'`. No Postgres anywhere. |
| 003 | gh-cli not octokit | **Implemented** | `src/adapters/github.ts:1` `import { execFile }`. No `@octokit/*` imports anywhere. |
| 004 | Zod for event validation | **Implemented** | `src/event-types.ts` — every kind has a Zod schema; types inferred via `z.infer`. |
| 005 | Per-spawn architecture v0.1 | **Implemented** | `src/cli.ts` + `src/daemon.ts` both exist. Daemon is primary; per-spawn is legacy fallback. |
| 006 | Daemon binds 127.0.0.1 only | **Implemented** | `src/transports.ts` listen literal is `'127.0.0.1'`. No `0.0.0.0`. |
| 007 | EADDRINUSE graceful fallback | **Implemented** | `src/transports.ts` catches bind failure, logs, continues stdio-only. |
| 008 | Write actions await decision | **Partial** | `src/tools/gated-action.ts` wraps actions with `await_decision`. **Only the GitHub-writes adapter and `trust_scope_grant` actually use it.** Other write paths (steward dispatch, connector writes, credential reads, worker spawn beyond tier gate) do not — see audit/06. |
| 009 | Stdio↔SSE shim | **Implemented** | `src/shim.ts`, ~150 LOC. |
| 012 | Event-driven over polling | **Implemented** | Workers use `chokidar` + events; no `setInterval` loops in `src/workers/`. |
| 013 | Single workers table + discriminator | **Implemented** | `src/persistence.ts` `WorkerRecord` with `type: string`, `metadata: Record<string, unknown>`. |
| 014 | Spawner static registry | **Implemented** | `src/workers/spawners-registry.ts` — explicit imports of `ccSpawner`, `shellSpawner`, `unitySpawner`. No filesystem auto-discovery. |
| 015 | Federation readiness design | **Implemented** (constraint honored) | Events in `src/event-types.ts` carry no `stavr_session_id` field; payloads are portable. |
| 016 | cc-worker uses git worktree | **Implemented** | `src/workers/cc.ts` spawn params include `repo_path`, `branch`, `base`, `worktree_base`. Default `.stavr-worktrees/<name>`. |
| 017 | A2A protocol decision | **Architected** | `src/federation/` exists; event taxonomy unchanged (no A2A-driven renaming). A2A interop deferred. |
| 018 | Destructive ops stay manual | **Implemented (by omission)** | No force-push / repo-delete tools registered. Confirmed by grep. |
| 019 | Exponential backoff in shim | **Implemented** | `src/shim.ts` `INITIAL_BACKOFF_MS=1_000`, `MAX_BACKOFF_MS=5*60_000`, `RESET_AFTER_CLEAN_MS=30_000`, `GIVE_UP_AFTER_MS=60*60_000`. |
| 020 | Daemon watchdog | **Implemented** | `src/watchdog.ts` pings `/healthz`; OS-scheduler integration via `watchdog-install.ts`. |
| 021 | Graceful degradation vs crash | **Implemented** | EventStore corruption rename+rebuild; transient errors emit `error` events without throwing. |
| 022 | Trust scopes supersede per-action CONFIRM | **Implemented** | `src/trust/store.ts findActiveScopeFor()` called in `src/security/host-exec-tool.ts` + `src/tools/gated-action.ts`. |
| 023 (param-constraint syntax) | Param matching syntax | **Implemented** | `src/trust/matcher.ts`. **Number collides — see Structural defects.** |
| 023 (shared memory on daemon) | Shared memory layer | **Implemented** | Singleton stores per broker (WeakMap in `src/server.ts`). **Number collides — see Structural defects.** |
| 024 | Reporting cadences + channels | **Implemented** | `src/trust/reporter.ts` + event kinds `trust_scope_progress` / `trust_scope_completed`. |
| 028 | Dashboard architecture | **Implemented** | `src/dashboard/{tokens,shell,index,components,pages,adapters,data,widgets}`. No React. Server-rendered + vanilla JS. |
| 030 | Event retention + dashboard caching | **Implemented** | `src/observability/retention.ts` (OPERATIONAL 7d / 100k; AUDIT 90d / no cap); `src/dashboard/memo.ts` single-slot TTL. ⚠️ The test run logged `pruneEvents: uncategorized event kinds preserved` once — uncategorised kinds exist and are silently retained per ADR-030's "never delete UNKNOWN" rule. Track the count. |
| 031 | Observability architecture | **Implemented** | `src/observability/{metrics,otel,logger,debug-endpoints}.ts`. OTel exporter opt-in via env. |
| 032 | Steward portable agent | **Partial** | `src/steward-agent/` directory scaffolded (autonomy, runtimes, db); IPC scaffold in `src/steward/ipc.ts`. **Daemon today still runs `src/steward/loop.ts` in-process.** Three-store split (memory/lessons/prefs) not wired. Subprocess cutover is the v0.5 target. |
| 033 | stavR tray companion | **Proposed** | Largely superseded by ADR-040. `governor/` Cargo project exists; not wired into runtime (PM2 still supervises). |
| 034 | Personal MCP gateway positioning | **Accepted** | Positioning only — no code change required. Amendments §A (team) + §B (family) layer on. Family-mode policy presets live in `src/policy/presets.ts` (referenced by `src/security/policies.ts`). |
| 035 | Federated stavR · A2A + OAuth 2.1 | **Proposed** (partially architected) | `src/federation/` peer discovery, registry, mDNS, client; `stavr-spawn` binary not built. OAuth 2.1 RI token format specified in ADR; token generation deferred. |
| 036 | Audit integrity baseline | **Proposed** | No hash chain or Ed25519 signing in `src/persistence.ts` today. `src/security/script-signing.ts` is the only signing-related file and serves a different purpose. |
| 037 | Operator data lifecycle | **Proposed** | WAL mode active; nightly verified snapshots + restore-cycle tests not present. Litestream env-gated (optional off-machine). |
| 038 | Supply chain integrity | **Proposed** | No SBOM or Sigstore wiring observed in the repo (would live in `.github/workflows/`). Renovate config not visible. |
| 039 | Polyglot core (Rust extraction) | **Proposed** | No `stavr-core` crate. Security-critical logic in Node. |
| 040 | Three-process architecture | **Partial** | Engine ✅; Steward subprocess scaffold ⚠️ (still in-process at runtime); Governor ❌ no Tauri wiring beyond `governor/` cargo. |
| 041 | Universal signal trace | **Partial** | Correlation_id + AsyncLocalStorage in `src/observability/logger.ts` ✅; event kinds enumerated ✅. LLM body capture toggle, auto-redaction, DB instrumentation not present. |
| 042 | Federation roles / discovery / identity / viz / worker polymorphism | **Partial** | `src/federation/` ✅; `src/security/webauthn*.ts` ✅; `src/dashboard/widgets/topology-*.ts` ✅; `src/workers/spawner-{mcp,protocol}.ts` ✅. Full role-on-event tagging, federation-key Option B, per-node metrics drill-down (UI dead per audit/09) all incomplete. |

## Summary table — by status

| Status | ADRs |
|---|---|
| Implemented | 001, 002, 003, 004, 005, 006, 007, 009, 012, 013, 014, 015, 016, 018, 019, 020, 021, 022, 023(×2), 024, 028, 030, 031 |
| Partial | 008, 032, 040, 041, 042 |
| Proposed | 017, 033, 035, 036, 037, 038, 039 |
| Accepted (positioning) | 034 |

## Cross-cutting observations

1. **The early stack (001–024) is consistently implemented.** Drift is concentrated in the v0.5+ proposals (032, 035–042).
2. **The substrate is honest about what's not built** — every Proposed ADR is correctly tagged in its frontmatter. Drift here is therefore not a *hidden* gap; it's a known roadmap.
3. **The two real drift risks:**
   - ADR-008 (write gating) is only partial — see audit/06 for the unenforced surfaces.
   - ADR-030 (retention) silently preserves uncategorised event kinds. The test run already logged one such case. Add a CI assertion that this warning's count is zero, or track the kind set in a checked-in fixture.
4. **ADR-032 / ADR-040 are coupled.** Cutting Steward over to the subprocess unblocks the Engine/Steward boundary in ADR-040. While both stay Partial, the two parallel codebases (`src/steward/` and `src/steward-agent/`) carry duplicate cost and drift risk.
5. **ADR-036 (audit integrity) blocks ADR-039 (Rust core)** — the Rust extraction is the natural home for hash-chain + Ed25519 signing. Sequencing matters here.
