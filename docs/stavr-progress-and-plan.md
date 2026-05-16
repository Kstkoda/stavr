# Stavr — Progress, Plan, Lessons (2026-05-16)

> Living document. Read this first when picking up stavr work. Reflects state as of 2026-05-16 ~08:30 UTC (Sat morning).
>
> Companion files: `adr/` for individual architectural decisions, `proposed/` for the BOM backlog, `CLAUDE.md` (gitignored — Kenneth's personal context) for chat conventions.

## TL;DR — what stavr is right now

Local-first authority + audit layer for AI agents. Runs as a daemon on `127.0.0.1:7777` (HTTP/SSE + stdio MCP transport). SQLite-backed event log (`runestone.db`) is the system-of-record. Spawns Claude Code workers in isolated git worktrees against a BOM (Bill of Materials) approval model. Dashboard at `/dashboard/{home,topology,streams,plans,decide,toolkit,capabilities,settings}` (Dark 2.0 design tokens).

Repo about to flip public. Public-facing posture: durable + observable + lego-principle (wrap MCP servers when available, build connectors only when not).

---

## What shipped 2026-05-15 → 2026-05-16

In chronological merge order:

| PR | Title | What it lands |
|---|---|---|
| #15 | `feat(observability): emergency heap snapshot + memory polling for OOM leak hunt` | `POST /debug/heap-snapshot` (loopback-only), `daemon_memory` event every 60s, SSE session lifecycle events (`sse_session_opened`/`closed`/`force_removed`), `scripts/leak-repro.ts`, evidence doc. **BOM oom-leak-hunt Checkpoint 1.** |
| #16 | `fix(persistence): events table retention + dashboard fetch memoization` | Kind-aware retention (`OPERATIONAL_KINDS` 7d/100k rows, `AUDIT_KINDS` 90d/no row cap, unknown preserved + warned), `created_at` migration backfilled from `persisted_at`, dashboard memoize 2s TTL, Streams limit 500→100, **`DELETE /mcp` synchronous handler** + 30s defensive `onclose` timeout + 5min janitor, soak test (`STAVR_RUN_SOAK=1`), weekly GHA soak workflow, ADR-030. **BOM oom-leak-hunt Checkpoint 2.** |
| #17 | `chore: PM2 ecosystem config + ignore memory/.claude-memory-seed` | `ecosystem.config.cjs` for window-free daemon (uses `args: ['daemon', 'start']`, not bare `start`), `.gitignore` adds `memory/` and `.claude-memory-seed/`. |
| #18 | `feat(observability): Prometheus /metrics endpoint + pino structured logging` | `prom-client` registry + 5 custom metrics with bounded-cardinality `normalizeSourceAgent`/`normalizeRoute` helpers, `recordBrokerEvent` tap, `pino` JSON logger, `AsyncLocalStorage` + `runWithCorrelation`, correlation_id HTTP middleware, broker.publish auto-tagged. **Diagnostics-2026 Checkpoint 1.** |
| #19 | `fix(cli): unify "stavr start" with "stavr daemon start" — close OOM-fix footgun` | `stavr start` (non-stdio) now delegates to `startDaemonForeground` so memory poller + retention + steward + watchdog all wire up. `--stdio-only` keeps the light path. `package.json` `start` script explicit. Closes the 2026-05-16 architectural footgun that hid the leak fix. **BOM cli-start-unify.** |
| #20 | `feat(observability): /debug heap+cpu profile endpoints + cross-platform Diagnostic Reports` | `mountDebugEndpoints(app)` module — `POST /debug/heap-snapshot` (polished from PR #15), `POST /debug/cpu-profile?duration=N`, `POST /debug/diagnostic-report`. All loopback-only + `STAVR_DEBUG_ENABLED` gate (returns 404 not 403 when locked) + 1/min per-endpoint rate limit. `docs/observability.md` operator runbook. **Diagnostics-2026 Checkpoint 3.** |
| #21 (PENDING — see In-flight below) | `feat(observability): OpenTelemetry traces + event-loop lag/ELU monitor` | OTel NodeSDK + OTLP HTTP exporter, GenAI MCP semconv spans (`invoke_agent` → `execute_tool` two-tier), event-loop lag histogram + ELU gauge, docker-compose Jaeger+Prometheus example. **Diagnostics-2026 Checkpoint 2.** |

7 PRs (6 merged + 1 pending). All on Kstkoda/stavr `main`.

---

## In flight

**PR #21** (OTel + event-loop monitor) — **CONFLICTING with main**. Both PR #20 and PR #21 add `docs/observability.md` from scratch. Rebase resolution: combine sections (PR #20's `/debug` operator runbook first, then PR #21's OTel quick start + span catalog + docker-compose pointers). Same pattern as PR #16's earlier rebase. Awaiting Kenneth's rebase + force-push, CI re-run, then merge.

---

## Architecture decisions

Long-form rationale lives in `adr/`:

- **ADR-030** — event-table retention (kind-aware, operational vs audit) + dashboard fetch memoization. The 2026-05-15 OOM fix.
- **ADR-031** — observability architecture: OTel (traces) + Prometheus (metrics) + pino (logs) + on-demand profiling endpoints. **Event log stays as system-of-record; OTel is an adapter, not replacement.**

Historical ADRs worth knowing about: ADR-006 (daemon binds 127.0.0.1 only), ADR-016 (cc worker uses git worktree isolation), ADR-022 (trust scopes supersede per-action confirm), ADR-028 (dashboard architecture).

---

## Testing strategy

### Unit + integration (in `tests/`)
- Default `npm run check` = `tsc --noEmit && vitest run && npm run build`.
- ~470+ tests as of PR #21 (growing per checkpoint).
- Notable test directories: `tests/observability/`, `tests/dashboard/`, `tests/trust/`, `tests/workers/`, `tests/federation/`, `tests/cli/`.
- **Test seams**: `startMemoryPoller`, `startEventLoopMonitor`, and the OTel SDK init all accept injected `scheduler` / `memoryUsage` / OTLP-receiver objects so tests don't need real network/timers.

### Soak (`tests/soak/leak-soak.test.ts`)
- **Skipped by default.** Enable with `STAVR_RUN_SOAK=1` (short, ~5 min) or `STAVR_RUN_SOAK=long` (100k events + 1000 dashboard fetches, ~30 min).
- Asserts `rss_max < 600 MB` and retention keeps `eventCount` bounded.
- Writes heap snapshots at start + end to `tmp/heap-snapshots/`.
- **Weekly GitHub Actions workflow** (`.github/workflows/soak.yml`) runs `long` mode on Ubuntu every Sunday 04:00 UTC; uploads snapshots on failure.

### Manual smoke
- `scripts/smoke/` has PowerShell + bash variants for federation/bind, pairing, and steward bug-fix flows.
- Daemon-up sanity: `curl -X POST http://127.0.0.1:7777/debug/heap-snapshot` (with `STAVR_DEBUG_ENABLED=1`) → JSON with file path; `curl http://127.0.0.1:7777/metrics | head -50` → Prometheus text format.
- OTel end-to-end: `cd examples/observability-stack && docker compose up -d` + `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm start` → traces visible in Jaeger UI at http://localhost:16686.

### CI matrix
- Two jobs per workflow: ubuntu-latest + windows-latest, both on Node 22.
- Kenneth dev-local: Node 24 / npm 11 (cross-version lockfile sometimes needs `npm install --package-lock-only` regen).

---

## Debugging + operational procedures

### Run the daemon (the right way)
```powershell
cd C:\dev\cowire
pm2 delete stavr 2>$null
pm2 start ecosystem.config.cjs    # uses args: ['daemon', 'start'] — full daemon, not light start
pm2 logs stavr -f                 # live tail; Ctrl-C exits view without killing daemon
pm2 restart stavr                 # WARNING: keeps OLD config; for config changes use `pm2 start ecosystem.config.cjs --update-env`
```

`npm start` is now also correct post-PR #19 — script in `package.json` invokes `daemon start`.

### Diagnostic procedures (`docs/observability.md`)
- **Daemon feels slow** → `POST /debug/cpu-profile?duration=30`, open `.cpuprofile` in Chrome DevTools Performance.
- **Daemon memory growing** → `POST /debug/heap-snapshot` at baseline + after load, compare in DevTools Memory tab (Comparison view → Objects Allocated Between Snapshots).
- **Daemon crashed** → check `tmp/diag-reports/` for `--report-on-fatalerror`-written Diagnostic Reports.
- **Need full state dump** → `POST /debug/diagnostic-report` (manual trigger when daemon is still alive).
- **Pre-OOM auto-snapshot** → daemon's start script has `--heapsnapshot-near-heap-limit=2`, so it dumps up to 2 snapshots to `tmp/heap-snapshots/` before the next OOM. Free leak evidence if it happens.

### Operational endpoints (loopback-only)
| Endpoint | What it returns | Auth |
|---|---|---|
| `GET /healthz` | Liveness: db reachable/writable, broker session count, decision counts | none |
| `GET /metrics` | Prometheus text format — process + Node runtime + `stavr_*` custom metrics | none |
| `POST /debug/heap-snapshot` | Writes `.heapsnapshot` to `tmp/heap-snapshots/`, returns path + size | loopback + `STAVR_DEBUG_ENABLED=1` + 1/min rate limit |
| `POST /debug/cpu-profile?duration=N` | Writes `.cpuprofile` after N seconds (capped at 120), returns path | loopback + gate + rate limit |
| `POST /debug/diagnostic-report` | Writes `process.report` JSON, returns path | loopback + gate |
| `POST /mcp` / `GET /mcp` / `DELETE /mcp` | MCP Streamable HTTP. DELETE is synchronous teardown — preserve handler order if touching. | (loopback for now) |

### Retention model
| Class | Examples | Default policy | Env override |
|---|---|---|---|
| Operational | `daemon_memory`, `daemon_eventloop`, `worker_progress`, `worker_log`, `sse_session_*`, `mcp_session_deleted`, `retention_swept` | 7 days OR 100k rows, whichever fires first | `STAVR_EVENTS_OP_RETENTION_DAYS`, `STAVR_EVENTS_OP_MAX_ROWS` |
| Audit | `trust_scope_*`, `decision_*`, `bom_*`, `worker_spawned`/`terminated`, `brick_*`, `steward_*`, `credential_*`, `no_go_*`, `pr_opened`, `commit_pushed`, session boundaries, profile mode switches | 90 days, no row cap | `STAVR_EVENTS_AUDIT_RETENTION_DAYS` |
| Unknown | (anything not in either set) | **Never deleted; logged with a warning** so the operator extends `src/observability/retention.ts` | n/a |

Boot retention sweep runs once on startup + every 60 min. Emits `retention_swept` event with `{ trigger, deleted_operational, deleted_audit, before_count, after_count, duration_ms, policy }`.

---

## BOM backlog (in `proposed/`)

Pending (in priority order):
1. **`bom-bridges-to.md`** — add `bridges_to` field to brick manifest for sunset policy (when an official MCP server ships). Small, surgical.
2. **`bom-health-endpoints.md`** — `/healthz` enrichment with brick + worker counts, new `/readyz` and `/version` endpoints. Partially obsoleted by PR #18's `/metrics`; reconsider scope before dispatching.
3. **`v0.4-scheduler-bom.md`** — Steward becomes a scheduler with explicit backlog, priority queue, capacity gate, dedupe window. Multi-checkpoint. Architectural.
4. **`v0.5-steward-portability-bom.md`** — Steward provider abstraction for swappable LLMs.
5. **`v0.6-stavr-watch-bom.md`** — file/repo watch primitive.
6. **`v0.6-oauth21-trust-scopes-bom.md`** — OAuth 2.1 as trust-scope auth.
7. **`v0.7-a2a-endpoint-bom.md`** — Agent-to-Agent protocol endpoint.
8. **`v0.8-stavr-spawn-bom.md`** — refined spawn semantics.
9. **`v0.9-fleet-model-registry-bom.md`** — multi-instance fleet registry.
10. **`v0.3-shared-memory-bom.md`** + **`v0.2.1-forefront-pass-bom.md`** — older proposed items, check relevance before scheduling.

Already executed (don't re-run): `bom-oom-leak-hunt.md` (→ PR #15, #16), `bom-diagnostics-2026.md` (→ PR #18, #20, #21), `bom-cli-start-unify.md` (→ PR #19), `v0.2-foundation-bom.md` (→ historical v0.2 substrate), `v0.3-dashboard-bom.md` (→ historical v0.3 dashboard).

---

## Architectural lessons / footguns (read these before doing anything risky)

1. **`stavr start` vs `stavr daemon start` were not equivalent until PR #19.** The lighter `start` skipped `startDaemonForeground` (memory poller, retention, steward, watchdog). Verify any new entry point invokes the full wire-up. Test: `daemon ready` log line + `retention_swept` event within 5s of boot.

2. **Stacked-PR + squash-merge cascade.** When two PRs add the same new file (e.g., both adding `docs/observability.md`), GitHub can't auto-merge the second after the first squashes onto main — needs rebase + manual conflict combine. Pattern: keep new-file additions inside a single PR when possible; if not, plan the merge order and budget for one rebase.

3. **PM2 `restart` doesn't reload `ecosystem.config.cjs`.** It keeps the prior args. To pick up config changes: `pm2 delete stavr; pm2 start ecosystem.config.cjs` OR `pm2 start ecosystem.config.cjs --update-env`.

4. **PowerShell strips `--` separator before PM2.** `pm2 start npm --name stavr -- start` doesn't work on Windows PowerShell — PM2 treats `start` as a separate script. Use ecosystem.config.cjs (this repo's solution) or PowerShell stop-parsing token `--%`.

5. **Windows: signal-based triggers (SIGUSR2) for Diagnostic Reports don't work.** Cross-platform path is `--report-on-fatalerror` flag + HTTP `POST /debug/diagnostic-report` endpoint.

6. **Windows: `claude.cmd` shim needs `cmd.exe` wrapping.** Per ADR-016 / src/workers/cc.ts: Node 22+ won't `CreateProcess` a `.cmd` directly (CVE-2024-27980 fix). Workers spawn via `cmd.exe /d /s /c claude ...` with `shell: false, windowsHide: true`.

7. **Windows: GitHub Actions runner exposes 8.3 short paths** (`C:\Users\RUNNER~1\...`). Always use `fs.realpathSync.native()` before constructing file URLs.

8. **`String.raw` doesn't nest cleanly** in template literals. Use plain string concatenation when embedding JS in HTML strings.

9. **DCO sign-off required on every commit** (`git commit -s`). Repo policy from PR #14 onward.

10. **prom-client `collectDefaultMetrics()` registers `nodejs_eventloop_lag_seconds`** and a family of percentile gauges. Custom histograms must use a different name (e.g., `stavr_eventloop_lag_seconds`) to avoid the "observe is not a function" collision (caught in PR #21).

11. **Cross-version lockfile rejection.** Kenneth local Node 24/npm 11; CI Node 22/npm 10. Sometimes lockfile gets rejected with "lockfileVersion ≥ 1" — fix is `npm install --package-lock-only`.

12. **Cowork harness virtualized filesystem** (Claude tool side) doesn't always persist file writes across sessions. Writing to `C:\dev\cowire\proposed\bom-*.md` then leaving — files may get pruned. Persist by either committing to git ASAP or accepting that drafts in `proposed/` need to be re-written if a future session can't find them.

13. **OTel GenAI semconv is experimental as of March 2026.** Set `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` in the daemon env. Use `gen_ai.*` and `gen_ai.mcp.*` namespaces as-is; stavr-specific attributes get the `stavr.*` prefix, never `gen_ai.stavr.*`.

14. **Don't collapse `invoke_agent` and `execute_tool` into one span level.** Two-tier shape is what trace consumers (LangSmith, Braintrust, Jaeger GenAI plugin) recognize.

15. **Don't propose alternative observability stacks.** OTel + Prometheus + pino + on-demand profiling endpoints is the 2026 baseline. Validated against MCP server + agentic-AI 2026 practice (memory `project_stavr_mcp_agentic_verification_2026_05_15.md`).

---

## Open follow-ups (small, queued; not blocking)

- `stavr_eventloop_lag_seconds` vs prom-client's default `nodejs_eventloop_lag_*` percentile gauges — reconsider whether the custom histogram adds anything. The defaults give p50/p90/p99 already.
- `transports.ts` janitor uses `t?._writable?.destroyed` — undocumented `StreamableHTTPServerTransport` internal. File a follow-up to either request a public `isClosed()` getter upstream or check via a more stable signal.
- `worker_progress` is OPERATIONAL (7d cap). For SOC 2 / forensic reconstruction of agent stdout, consider a `STAVR_COMPLIANCE_MODE` env that promotes it to audit class.
- PR #20 added rate-limiting to `/debug/*`; the original PR #15 `/debug/heap-snapshot` route still works the same way through the new `mountDebugEndpoints()` module. Verify the route registration order didn't break anything in real ops use.

---

## How to dispatch new work

Two patterns:

**A. Stavr's own cc worker spawn** (requires the daemon to be running + the stavr MCP tools available to your Claude session):
```text
worker_spawn type=cc, name=<short-id>, params={
  repo_path: "C:\\dev\\cowire",
  branch: "feature/<name>",
  approval_mode: "auto-accept",
  prompt: "Read C:\\dev\\cowire\\proposed\\<bom-file>.md and execute. DCO sign-off. Stop on CI red."
}
```
Decision gate fires on the dashboard; approve once and CC runs autonomously.

**B. Direct Claude Code prompt** (works without stavr's daemon — useful when daemon is down or for trivial work). Just open `claude` in the repo root and paste a prompt that references the BOM file by absolute path + lists stop conditions.

Both produce the same shape: feature branch off main, single PR per checkpoint, DCO sign-off, stop on CI red.

---

## Glossary

- **BOM** — Bill of Materials. A structured plan in `proposed/<name>-bom.md` with checkpoints + acceptance criteria + risk envelope. Approving a BOM creates a trust scope; CC executes inside that scope. See ADR-022.
- **Trust scope** — pre-authorized work envelope with budget + time window + action class allow-list. See `project_cowire_approval_architecture` memory + ADR-022.
- **Operational vs Audit events** — retention class distinction. Operational = high-volume telemetry, aggressive prune. Audit = policy/decision lifecycle, long retention.
- **Steward** — the planner/orchestrator process. Reads BOMs, dispatches workers, surfaces decisions. NOT a per-call router; plans once per job. See `project_cowire_dashboard_modes` memory.
- **Brick** — installable connector/MCP server wrapper. Manifest at `stavr-brick.json`. Installer at `src/bricks/installer.ts`. Future `bridges_to` field declares sunset target.

---

*This document is intended to be updated as work lands. When you ship something significant, add a row to the "What shipped" table and update the "In flight" / "Backlog" sections. Lessons go in the footguns list — additions only; old entries stay so the next person doesn't re-learn them.*
