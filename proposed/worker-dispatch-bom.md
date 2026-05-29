# BOM: stavR Worker-Dispatch — invoke + job + the federated job-flow

**Owner:** CC
**Sensitivity:** `careful`, escalating to `high` for Phase 3 (the worker-subsystem cutover) and Phase 4 (scope-aware enforcement — a security primitive). Operator approval gate between those phases.
**Verification window:** `targeted` per phase; `full` for Phase 3 (cutover) and Phase 4 (enforcement).
**Branch:** `feat/worker-dispatch`.
**Base:** `main`.
**Estimated scope:** 6 phases (0-5), 5 PRs, multi-week — a core-subsystem migration, not a polish run.

---

## Why this BOM exists

stavR today wraps task delegation in a bespoke "worker" subsystem — `src/workers/*` (orchestrator, lifecycle, spawner-mcp, spawner-protocol, spawners-registry, cc, shell, watchdog, emitter, av-detector, script-writer, unity, tools, types, mcp-workers-config), ~6 `worker_*` MCP tools, a dashboard workers page, worker-retention observability. A 2026-05-24 operator 10-3-1 retired that model. The decision — Option B — drops the word "worker": stand up two primitives, `invoke` and `job`, and decouple the job from a small set of pluggable **executor bindings**. This BOM migrates the bespoke runtime onto invoke+job, then extends the job model across federation so a peer can dispatch a job under a grant (the federated job-flow, designed 2026-05-24).

## Decisions already locked (do not re-litigate)

- **Two primitives.** `invoke` — a synchronous call (one MCP tool call, or a short CLI exec): request → response. `job` — an asynchronous long-running execution with a lifecycle (dispatched → running → heartbeating → terminal → result), a budget, crash recovery, an audit trail. The job record is **owned by stavR**.
- **The job is only the lifecycle / bookkeeping record** — decoupled from the **executor binding** (how the actual work is reached). One job model; a small, fixed set of binding kinds — keep it to ~4. If the bindings regrow into a sprawling "executor type" taxonomy, the bespoke worker runtime has been quietly rebuilt.
  - **MCP-call** — to a genuine MCP server (e.g. a git MCP). A short one is just an `invoke`.
  - **HTTP** — local Ollama, or a remote endpoint.
  - **process-spawn** — a legacy CLI tool, or headless `claude -p` for a CC job.
  - **CC-session-attach** — attach to an already-running Claude Code session (no spawn, no lifecycle ownership).
- **CC binding specifics.** `claude mcp serve` is NOT the CC delegation primitive — it only exposes CC's own tools to an MCP client. A CC job is reached by `claude -p` (process-spawn) or session-attach. **Prefer attach over spawn** — spawn makes stavR own the CC lifecycle, the crash surface that took down the operator's PC (2026-05-20). From 2026-06-15, `claude -p` / Agent-SDK usage on subscription plans draws a separate monthly credit pool; the job budget must record which pool a CC job spends against.
- **Remote = a binding pointed at a peer.** The job record stays local so stavR keeps authority + audit.
- **The federated job-flow** (designed 2026-05-24 — inlined here so this BOM is self-contained):
  - Capability-based: a requester holds a signed **grant** (a trust-scope — resource + features + budget + expiry), never a credential. Resource credentials never cross the wire.
  - The resource owner's stavR is the **single policy enforcement point** — every job step checked against the grant, remaining budget, the no-go list, and the 4-tier action gate.
  - Two-plane data model: control plane = JSON-RPC (job requests / status / result-metadata, signed); data plane = content-addressed blobs (SHA-256; `{hash, size, content-type, data-class}` references; fetched out-of-band).
  - Script invariant: a script never executes on a device whose owner did not authorize it.

## Reference reading (CC, at Phase 0)

- `CLAUDE.md` — invariants.
- The worker subsystem to be migrated: `src/workers/*` (incl. `types.ts`, `spawner-protocol.ts`, `lifecycle.ts`, `orchestrator.ts`), the `worker_*` MCP tool registrations, `src/dashboard/pages/workers.ts` + `src/dashboard/data/worker-{roster,counters}.ts`, `src/observability/worker-retention.ts`.
- Persistence — how worker state is persisted today; the job record is a new persisted entity (Phase 1 designs its schema + a migration).
- The federation peer plumbing (for Phase 5).
- Prior worker BOMs for context: `proposed/v0_6_6-worker-status-fidelity-bom.md`, `proposed/v0_6_7-worker-spawn-hygiene-bom.md`, `proposed/v0_7-workers-console-bom.md`.

## Scope / don't-touch

This is a **core-subsystem migration** — it explicitly OPENS `src/workers/*`, the `worker_*` MCP tools, `src/persistence.ts` + `migrations/`, `src/types/`, and the dashboard workers page. The don't-touch defaults for those paths are lifted *for this BOM*. It must still be careful: persistence changes get a migration + a `full` verification window; security primitives (Phase 4) get an operator approval gate.

## Phase 0 — Recon

CC produces `proposed/worker-dispatch-recon.md` — the migration map: every `src/workers/*` module and its role, the full `worker_*` MCP tool surface and each tool's callers, how worker state is persisted today, what the dashboard workers page + data fetchers + retention observability consume, and the federation peer plumbing. It classifies each piece — becomes `invoke`, becomes `job`, becomes an executor binding, or is deleted. No code changes. STOP for operator review.

## Phase 1 — The job record + `invoke` + the binding interface

- Define the `job` lifecycle record (dispatched → running → heartbeating → terminal → result), the budget, crash recovery, the audit trail — stavR-owned, persisted (schema + migration).
- Define `invoke` — the synchronous primitive.
- Define the **executor binding interface** — the free axis. Phase 1 ships the model end-to-end with **one** binding (process-spawn) so the lifecycle is exercised whole.

## Phase 2 — The remaining executor bindings

MCP-call, HTTP, CC-session-attach. Prefer attach for CC. Each binding is small and conforms to the Phase 1 interface; resist a fifth kind.

## Phase 3 — Migrate the bespoke worker subsystem (the cutover)

Re-point the `worker_*` MCP tools onto invoke+job (rename where the 10-3-1 retired the "worker" terminology); migrate `src/workers/*` consumers; migrate the dashboard workers page + data fetchers + retention observability. Delete what the recon marked dead. `high` sensitivity — operator approval gate, `full` verification window, a migration for any persistence change.

### Phase 3 split — 3a / 3b / 3c (added 2026-05-28)

Phase 3 is the largest single phase in this BOM — recon §1 counts 15 modules + 3,773 LOC of `src/workers/*` alone, plus ~25 test files, the broker event taxonomy, the dashboard pages + data layer, retention observability, the watchdog, env-var-named operator knobs, the spawner-mcp design call, and the Unity decision. Shipping that as one commit risks:
  - Context exhaustion mid-cutover, leaving a partial migration the next session has to reconstruct.
  - Rushed test rewrites that mask real regressions because the diff is too large to review carefully.
  - A single revert button — if any sub-area regresses on `main`, the whole cutover backs out, including the parts that were correct.

So Phase 3 splits into three operator-gated sub-phases, each a standalone commit per CLAUDE.md §4 (one commit, independently passing `npm test` + `npm run build`, DCO sign-off, push at end). High-sensitivity ceremony applies to each — operator approval gate before each commit, full diff dump, status check.

  - **Phase 3a — substrate.** Admission control wiring on `JobOrchestrator` (per-actor concurrency, host-ceiling, budget shape check); job-watchdog with `job_stuck` + `worker_stuck` dual-emit; retention env-var rename (`STAVR_WORKER_*` → `STAVR_JOB_*`) with backwards-compat reader + boot warning; broker-event dual-emit policy (`DEPRECATION_WINDOW_RELEASES = 1` constant; every `job_*` event shadowed as the legacy `worker_*` equivalent via `src/jobs/dual-emit.ts`). No MCP tool rename, no dashboard touch, no Unity decision, no spawner-mcp design call.
  - **Phase 3b — MCP tool surface.** Add `job_*` tools (`job_dispatch`, `job_list_bindings`, `job_list`, `job_status`, `job_inject`, `job_terminate`) as the canonical surface, registered against `JobOrchestrator`. Keep the legacy `worker_*` tools registered against `WorkerOrchestrator` with a deprecation-log wrapper per call. **Parallel-surface aliasing** at three layers only: wire-name (both registrations coexist), tier-classification (operator grants referencing legacy IDs resolve identically to their job_* counterparts via `WORKER_TO_JOB_TOOL_ID_ALIAS` + alias-aware fallback in `actor-permissions.resolve()`), and deprecation log (each legacy call emits one `[deprecated]` line citing `DEPRECATION_WINDOW_RELEASES`). Handler unification (a single shared backend the way the BOM's Phase 1 intent suggested) is deferred to 3c when the binding-target catalogue exists and `WorkerOrchestrator` is deleted — attempting handler-sharing in 3b would create a consistency hazard (legacy `worker_spawn`→`worker_dispatch` flow breaks across orchestrators with different backing tables) AND require the spawner-mcp consumer migration that is explicitly 3c scope. Update tool-cards (`deprecatedAliasOf` field), the categories registry, and the security policy presets to mirror tier choices for both names; rewrite the affected `tests/security/*` + `tests/tools/*` assertions in the same commit (CLAUDE.md §1). The legacy `tests/workers/*` and `tests/security/*` tests exercising the legacy `worker_*` path stay green — that path is still live until 3c.
  - **Phase 3c — dashboard cutover + deletes.** Split into two sub-commits when the pre-flight came in at ~7,500 LOC churn (above the operator's 2,000 LOC ceiling for a single Phase 3 commit):
    - **Phase 3c.1 — dashboard cutover + shedJob + metrics** (shipped 2026-05-28 as `ceb8a38`). Renamed `src/dashboard/pages/workers.ts` → `jobs.ts` + adapters/data fetchers (`worker-roster.ts` → `job-roster.ts`, `worker-counters.ts` → `job-counters.ts`); re-pointed Helm + Topology + Diagnostics at JobRecord (sourced from `listJobs`); legacy `/dashboard/workers` thin-alias to the same renderer; `shedJob` payload slot rename (`worker_id`/`worker_name`/`worker_type` → `job_id`/`job_name`/`binding_kind`/`binding_target`); metrics subscription re-pointed to `job_started`/`job_terminated` + `stavrWorkersAlive` → `stavrJobsAlive`. Dual-emit + legacy worker_* event kinds + notify/transports/tail/retention consumers UNCHANGED — deferred to 3d cleanup. `src/workers/*` + `tests/workers/*` + the 5 coordinated deletions stayed alive for 3c.2.
    - **Phase 3c.2 — bespoke worker subsystem deletion + carve-outs + docs.** Delete `src/workers/*` (13 files, ~2,800 LOC) except `av-detector.ts` + `script-writer.ts` which moved to `src/jobs/` (av-detector wired into `binding-process-spawn`'s failure path; script-writer keeps its `STAVR_WORKER_SCRIPT_*` env-var names — operator surface). **Delete the bespoke `worker_init` / `worker_step` / `worker_finalize` long-poll protocol** (whole of `src/workers/spawner-mcp.ts` + `spawner-protocol.ts` + `mcp-workers-config.ts`). Delete Unity per operator 2026-05-27. Five coordinated deletions: categories alias tables + `aliasCounterpartFor`, actor-permissions alias-aware fallback branch, 3b parity fixtures in `tests/security/`, `deprecation-log` module + tests, WorkerOrchestrator wiring in `src/server.ts`. Catalogue + policies cleanup; `cli.ts` example string. Docs rename: `tool-cards/worker_*.md` → `tool-cards/job_*.md` (regenerated from `catalogue-data.ts`), `writing-a-worker.md` → `writing-a-job-binding.md`, `unity-worker.md` deleted. `worker-spawn.md` kept as the operator-facing script-writer doc (env-var-name lock).

> **Locked design call — long-running MCP-as-worker (operator homefleet audit, 2026-05-28, option #10).** The bespoke `worker_init` / `worker_step` / `worker_finalize` protocol is **deleted, not migrated** in 3c. The spec-defined replacement is the MCP 2026-07-28 **Tasks** extension, which is scoped in a separate BOM at `proposed/mcp-long-running-primitives-bom.md` (queued behind worker-dispatch + claude-execute). 3c does NOT build `binding-mcp-worker.ts`. 3c does NOT touch `claude-execute-mcp-tool-bom.md` territory. The mcp-call binding shipped in Phase 2 covers the synchronous + short-running MCP surface; long-running MCP work waits for the Tasks-extension BOM.

The sub-phases are linear — 3b consumes 3a's dual-emit substrate (the legacy `worker_*` events still fire so dashboard subscribers keep working until 3c re-points them); 3c consumes the renamed MCP surface from 3b. Each commits and ships before the next dispatch.

## Phase 4 — Scope-aware enforcement (hard prerequisite for federation)

Today the enforcement chokepoint checks an actor's *tier* but not their *grant scope* (trust scopes only gate the `gatedAction` subset). Phase 4 lands **grant-scope-aware enforcement at the `JobOrchestrator.dispatch` path** — every job dispatch is validated against a specific grant (actor binding + tool coverage + target coverage + budget + expiry) before it runs. This MUST land before Phase 5. `high` sensitivity — it is a security primitive; operator approval gate.

### Locked composition (operator 10-3-1, 2026-05-29 — option C)

  - **peer:\* actors:** dispatch MUST include an explicit `grant_id`. No auto-resolve. Missing → reason `'grant_required'`.
  - **Operator-shape actors** (`loopback:*`, `unstamped-loopback`, KNOWN_ACTORS — operator / cowork-claude / cc / steward): `JobOrchestrator` auto-resolves the most-permissive active grant covering (tool, target). No covering grant → internal `'sentinel'` shape (always covers, never budgeted, **never persisted as `grant_id`** on the JobRecord, no `grant_consumed` audit event fires). Operator's local hot path stays uncluttered.
  - **Per-actor association** (operator's lock #1): nullable `actor_id` column on `trust_scopes`. NULL = global capability (back-compat). Set = grant is bound to one actor; resolution-time mismatch → `'grant_not_for_actor'`.
  - **Coverage check** (locked): two independent set-membership checks. `grant.covered_tools` must include the MCP tool name AND `grant.covered_targets` must include the requested `binding_target`. NULL covered_* (back-compat) → wildcard. Explicit `'*'` membership → wildcard. **Empty array `[]` → covers nothing (fail-closed)** per operator's lock #2.
  - **Budget** (operator's lock #6): NEW column `budget_remaining` distinct from `expires_after_actions` (the gated-action cap stays untouched). NULL = unbudgeted / infinite. Decremented atomically per successful dispatch via better-sqlite3 transaction. Exhausted → `'budget_exhausted'`.
  - **Expiry / lifecycle:** `grant.expires_at <= now` → `'grant_expired'` (with lazy-promotion to `status='expired'`). Any non-`active` status → `'grant_revoked'`.
  - **Matrix tier remains the upstream gate.** `buildChokepointGate` is unchanged; NO_GO from the matrix denies before JobOrchestrator is even reached. The grant gate is ADDITIVE, not a replacement.
  - **Phase 4 gates ONLY `JobOrchestrator.dispatch`** (operator's lock #3). `job_inject` + `job_terminate` pass through unchanged at the orchestrator layer — chokepoint CONFIRM-tier matrix still gates them independently.
  - **All denials carry structured `reason`** (a `GrantDenialReason` enum: `grant_required` | `grant_not_found` | `grant_not_for_actor` | `tool_not_covered` | `target_not_covered` | `budget_exhausted` | `grant_expired` | `grant_revoked`).
  - **New audit events** (no dual-emit shadows): `grant_consumed { actor_id, grant_id, tool, binding_target, budget_before, budget_after }` and `grant_denied { actor_id, grant_id?, tool, binding_target, budget_before?, reason }`. Retention class `audit`.

### Deferred (NOT built in Phase 4)

  - **General chokepoint scope-awareness** ("Option B" — `buildChokepointGate` itself becoming scope-aware for the whole gated-action subset). Phase 4 narrows scope-awareness to JobOrchestrator only; the chokepoint stays unchanged.
  - **Federation cluster-global metering** (an actor hitting N daemons shouldn't get N times the budget) — deferred to Phase 5.
  - **Dashboard exposure of new fields** (`covered_tools`, `covered_targets`, `budget_remaining`, `actor_id`) — `trust_scope_status` MCP tool surfaces them in Phase 4 so operators can query via tool; full dashboard pages defer to a follow-up cycle.
  - **`job_inject` / `job_terminate` grant gating** — chokepoint matrix tier still gates these.

## Phase 5 — The federated job-flow

- A `job` dispatched by a peer: the binding is "remote → a peer"; the job record stays local.
- The capability check at dispatch and per-step (Phase 4's scope-aware enforcement).
- The two-plane data model: job inputs / outputs as content-addressed blobs, each carrying a data-class; control messages as signed JSON-RPC.
- Durability: cross-node job messages use the outbox pattern — write-to-own-log-first, async delivery with retry, acks + offsets, idempotent at-least-once — so a job survives the link going down.

## PR grouping

- PR 1 — Phase 0 (recon doc).
- PR 2 — Phases 1-2 (job model + bindings).
- PR 3 — Phase 3a + 3b + 3c (the worker-subsystem cutover, three commits inside one PR — each commit lands and ships clean; the PR opens after 3c is in).
- PR 4 — Phase 4 (scope-aware enforcement).
- PR 5 — Phase 5 (federated job-flow).

## Definition of done

1. `invoke` + `job` exist; the job is a stavR-owned, persisted lifecycle record with budget + crash recovery + audit.
2. Four executor bindings — MCP-call, HTTP, process-spawn, CC-session-attach — conform to one interface; no fifth.
3. The bespoke `src/workers/*` runtime and the `worker_*` tool surface are migrated or deleted; the dashboard reflects invoke+job.
4. The enforcement chokepoint is grant-scope-aware.
5. A peer can dispatch a job under a grant; credentials never cross the wire; job inputs / outputs are content-addressed; cross-node job messages survive a link outage.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/worker-dispatch-bom.md. Execute Phase 0 (recon) ONLY — produce proposed/worker-dispatch-recon.md, the migration map for the src/workers/* subsystem and the worker_* tools onto the invoke + job model. No code changes. Then STOP for operator review.

Sensitivity: careful. Skärp och hängslen: git status --short + git symbolic-ref HEAD before every mutating git op. Branch feat/worker-dispatch off main. One commit, DCO sign-off (-s).

Go — Phase 0 only.
```

---

## End of BOM
