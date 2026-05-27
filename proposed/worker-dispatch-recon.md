# Worker-Dispatch — Phase 0 Recon

**Reads:** `proposed/worker-dispatch-bom.md`, `CLAUDE.md`.
**Branch:** `feat/worker-dispatch` (off `main`).
**Status:** recon only, no code changes.

This document is the **migration map**. Every `src/workers/*` module, every `worker_*` MCP tool, every persistence column, every dashboard surface, every observability hook, and the federation peer plumbing is classified by its target in the invoke + job + executor-binding world:

- **→ invoke** — folds into the synchronous primitive (`request → response`, one MCP/HTTP/CLI call).
- **→ job** — folds into the stavR-owned async lifecycle record (dispatched → running → heartbeating → terminal → result, with budget + crash recovery + audit).
- **→ binding** — folds into one of the four executor bindings (MCP-call / HTTP / process-spawn / CC-session-attach).
- **→ delete** — duplicate or scaffolding that does not survive the cutover.
- **→ keep / generalize** — adjacent infrastructure (admission control, retention, watchdog) that retains its purpose but is re-pointed onto the job record.

The taxonomy is the BOM's; if a row below contradicts the BOM, the BOM wins.

---

## 1. The `src/workers/*` modules

Read top-to-bottom. The first column is the file; the second is its current role; the third is the recon classification + the target shape in invoke+job.

| File | Current role | → Target |
|---|---|---|
| `src/workers/types.ts` (85 LOC) | `WorkerSpawner`, `WorkerInstance`, `WorkerSpawnerContext`, `WorkerEventEmitter` shapes; re-exports `WorkerRecord`/`WorkerStatusT` from persistence. | → **binding interface**. The `WorkerSpawner` interface IS the prototype for the Phase 1 `ExecutorBinding` interface — its `spawn(params, ctx) → WorkerInstance` shape is what Phase 1 generalizes (rename `type` → `binding kind`, drop `dispatch?` as a binding method and lift it onto the orchestrator using the binding's I/O channel). The event-emitter axis (activity/progress/metadata/log/exit/error) becomes the **job runtime channel** — the events the binding feeds into the job record. |
| `src/workers/orchestrator.ts` (758 LOC) | The single chokepoint that today: validates params, runs admission control (host-ceiling), runs the tier gate (auto/confirm/never + trust-scope short-circuit + `await_decision`), spawns the `WorkerInstance`, wires its events into the broker, owns the in-process `live` map, runs the idle timer, owns `shedWorker` (Phase 5 load-shed), `shutdownAll`, and the `getCeilingStatus` accessor. | → **job orchestrator**. Becomes the **JobOrchestrator**: it owns the lifecycle record (Phase 1 schema), invokes the chosen binding, drives the runtime channel into job-events, enforces budget + idle + admission. The tier-gate path moves into the structural chokepoint (decision-gate) so jobs and invokes share one gate; Phase 4 turns that into grant-scope-aware enforcement. `shedWorker` survives as `shedJob`. `getCeilingStatus` survives unchanged (load-shedding is per-host, not per-job-shape). |
| `src/workers/spawner-protocol.ts` (219 LOC) | ADR-042 contract for MCP-server-as-worker types: `worker_init`/`worker_step`/`worker_finalize` (required), `worker_inject`/`worker_inspect`/`worker_pause`/`worker_resume` (optional); `WorkerInitInput/Result`, `WorkerStepResult` discriminated union, federation-role tag, `WorkerMcpManifestEntry` schema. | → **MCP-call binding contract**. Renames to `mcp_binding_protocol.ts` (or merges into the MCP-call binding module). The init/step/finalize triple IS the long-poll shape of the MCP-call binding for long-running work. The optional inject/inspect/pause/resume become **binding capabilities** advertised in the binding result — the orchestrator's job dispatch path uses `inject` to deliver mid-flight instructions instead of carrying its own bespoke `dispatch()` method on the binding. |
| `src/workers/spawner-mcp.ts` (388 LOC) | The adapter that wraps an external MCP child as a `WorkerSpawner` — `StdioClientTransport`, MCP handshake, `worker_init` → session, long-poll loop calling `worker_step` and fanning into `WorkerEventBus`, `worker_finalize` on terminate. | → **MCP-call binding** (Phase 2). The structure is already right; what changes is the surface — instead of returning a `WorkerSpawner` it returns an `ExecutorBinding`, and the events fan into the job runtime channel rather than the bespoke event-bus. |
| `src/workers/mcp-workers-config.ts` (102 LOC) | Loads `~/.stavr/worker-mcp-servers.yaml`, validates against `WorkerMcpManifestSchema`, translates each entry into a `WorkerSpawner` via `createMcpSpawner`. | → **MCP-call binding registry** (Phase 2). Becomes the loader for the **MCP-call binding catalogue** — operator-declared MCP endpoints the job system can dispatch to. The shape stays, the naming moves from "worker types" to "binding targets". |
| `src/workers/spawners-registry.ts` (42 LOC) | Static list of built-in spawners (`cc`, `shell`, `unity`) + `resolveAllSpawners()` merging MCP-backed types. ADR-014 ("no auto-discovery"). | → **binding catalogue** (Phase 2). The four binding kinds are not a registry of "types" — they are a closed enum. What survives is the catalogue of **named binding targets** (cc-process, the operator's local Ollama, the python MCP server, a specific peer). ADR-014's "explicit, no FS scan" stays as a structural invariant. |
| `src/workers/cc.ts` (382 LOC) | In-process CC spawner — creates a git worktree, writes `.stavr-mcp.json`, spawns `claude --print --output-format stream-json` as a child, parses stream-json lines, emits progress/log/metadata/exit. Owns worktree cleanup on terminate. | → **process-spawn binding consumer** (Phase 2 + Phase 3). The CC-specific logic (worktree setup, MCP-config write, stream-json parsing) is **NOT in the binding** — it's a thin caller that constructs the process-spawn binding's params (command, args, cwd, env, stdout parser) and consumes the binding's job-events. The follow-up `claude-execute-mcp-tool` BOM is what registers this specific named binding target (`claude-code-subprocess`). This BOM stops at the generic substrate. **Note:** the BOM's CC-binding posture is "**prefer attach over spawn**" because spawn made stavR own the CC crash surface (2026-05-20 PC crash). The `cc.ts` spawn path stays available but is no longer the recommended way to reach a CC job — the CC-session-attach binding (Phase 2) is. |
| `src/workers/shell.ts` (251 LOC) | In-process shell spawner — writes a signed `.ps1`/`.cmd`/`.sh` script to `~/.stavr/worker-scripts/<id>.<ext>`, verifies sidecar signature, spawns the shell with `-File`, parses stdout/stderr, emits log events. | → **process-spawn binding consumer**. Like `cc.ts` — the script-writer + signature-verifier are job-input pre-conditions on the operator side; the binding only sees a command + args + env. The script-writer stays as a helper module the caller uses to build the binding's params. |
| `src/workers/unity.ts` (507 LOC) | Watches `<UnityProject>/Logs/stavr-events.jsonl` via chokidar, optionally launches Unity with `-projectPath`. | → **HTTP / file-tail binding consumer + process-spawn binding consumer**. Two distinct surfaces conflated today: (a) the chokidar JSONL tail is closer to an **HTTP-style polling binding** (the Editor bridge writes a stream; the binding consumes it); (b) the optional `-projectPath` launch is process-spawn. Phase 3 splits these — but Unity is operator-specific and may not survive the cutover if no one is exercising it; flag for operator review at the Phase 3 gate. |
| `src/workers/av-detector.ts` (202 LOC) | Queries the Windows Event Log for AV/EDR block events (Defender 1116/1117/5007 + CrowdStrike/SentinelOne/Symantec/Sophos channels) when a worker spawn fails with EPERM. Pure module — takes a command shape + clock + transport. | → **keep, generalize**. This is a diagnostic adapter, not a worker primitive. It survives unchanged but is wired into the **process-spawn binding's failure path**, not the orchestrator's. Module-internal; no public-API change. |
| `src/workers/script-writer.ts` (291 LOC) | v0.6.7 P1 — writes the worker script with audit header to `~/.stavr/worker-scripts/<id>.<ext>` with owner-only perms, signs the sidecar. AV-avoidance + audit. | → **keep, owned by shell-binding caller**. Stays as a helper the shell caller uses to materialise the binding's `command` argument. Not a binding primitive. |
| `src/workers/emitter.ts` (52 LOC) | `WorkerEventBus` — an `EventEmitter` wrapper conforming to the `WorkerEventEmitter` shape. Internal to in-process spawners. | → **delete or absorb into binding helpers**. Once the binding interface owns the runtime channel, each in-process binding has its own ad-hoc emitter pattern. This file is small enough to inline at the two remaining call sites (CC + shell) and then drop. |
| `src/workers/watchdog.ts` (100 LOC) | Periodic ticker that emits `worker_stuck` events when `now - last_activity_at > stuckThresholdSec` (default 300s), with per-worker idempotency and re-emit windowing. | → **keep, rename → `job-watchdog.ts`**. The behaviour is exactly right for the job model — stuck-detection on `last_activity_at` is a job-level property. Rename the emitted event from `worker_stuck` → `job_stuck` (Phase 3 event taxonomy migration). |
| `src/workers/lifecycle.ts` (210 LOC) | Derived `LifecycleState` enum (`starting`/`running`/`completed-clean`/`completed-error`/`killed-by-operator`/`killed-by-system`/`crashed`/`stale`) computed from `WorkerRecord` columns; `STALE_THRESHOLD_MS = 1h`; `isCurrentlyActive` / `isHistoric`; halo + label helpers. | → **job lifecycle states**. The eight-state enum IS the job lifecycle — keep verbatim, rename to `JobLifecycleState`. The derivation function (read-time from legacy columns) becomes a forwards-compat shim during the Phase 3 migration window and is removed once `lifecycle_state` is written authoritatively. |
| `src/workers/tools.ts` (184 LOC) | Registers six `worker_*` MCP tools (`list_types`, `spawn`, `list`, `status`, `dispatch`, `terminate`) on the MCP server, plus `normalizeUnknownArg` (legacy Cowork JSON-string-encoded-args shim) and `serializeWorker`. | → **rename + repurpose** (Phase 3 cutover). Five-tool surface in invoke+job world (see §3). `normalizeUnknownArg` is per-client legacy; carry forward unchanged. `serializeWorker` becomes `serializeJob`. |

### Total surface

- 15 modules, 3,773 LOC.
- Of those: **9 fold cleanly** into the binding interface + job orchestrator (`types`, `orchestrator`, `spawner-protocol`, `spawner-mcp`, `mcp-workers-config`, `spawners-registry`, `cc`, `shell`, `unity` — though `unity` is operator-flag).
- **3 keep** their behaviour, possibly renamed (`av-detector`, `script-writer`, `watchdog`).
- **2 rename in place** (`lifecycle` → job lifecycle; nothing structurally changes).
- **1 deletes** (`emitter` — inlinable).

---

## 2. Persistence — the `workers` table and `WorkerRecord`

### Today

**Table `workers`** (`src/persistence.ts:274`):

```
id TEXT PRIMARY KEY
name TEXT NOT NULL
type TEXT NOT NULL
cwd TEXT NOT NULL
pid INTEGER
status TEXT NOT NULL                       -- WorkerStatusT enum
started_at TEXT NOT NULL
ended_at TEXT
last_activity_at TEXT
metadata_json TEXT NOT NULL
spawn_params_hash TEXT NOT NULL
termination_reason TEXT                    -- 'completed' | 'crashed' | 'terminated_by_user'
exit_code INTEGER
lifecycle_state TEXT                       -- finer-grained (v0.6.6); NULL on legacy rows
```

Indexes: `idx_workers_status`, `idx_workers_type`, `idx_workers_name_active` (partial), `idx_workers_lifecycle_state`.

Helper methods on `EventStore`: `upsertWorker`, `getWorker`, `listWorkers`, `updateWorkerMetadata`, `markWorkerTerminated`, `updateWorkerStatus`, `listWorkersForWatchdog`, `nameIsAvailable`.

### Phase 1 target — `jobs` table

The job record is a new entity. The BOM is explicit: "the job record is **owned by stavR**, persisted (schema + migration)." Proposed shape (Phase 1 will refine):

```
id TEXT PRIMARY KEY
name TEXT NOT NULL
binding_kind TEXT NOT NULL                 -- 'mcp-call' | 'http' | 'process-spawn' | 'cc-session-attach'
binding_target TEXT NOT NULL               -- the named target within the kind (e.g., 'claude-code-subprocess')
params_json TEXT NOT NULL                  -- binding-specific params
params_hash TEXT NOT NULL                  -- for crash-recovery idempotency
lifecycle_state TEXT NOT NULL              -- enum from lifecycle.ts, authoritative now
started_at TEXT NOT NULL
ended_at TEXT
last_activity_at TEXT
metadata_json TEXT NOT NULL
termination_reason TEXT                    -- 'completed' | 'crashed' | 'terminated_by_user' | 'budget_exceeded' | 'shed_by_host'
exit_code INTEGER
result_json TEXT                           -- terminal result
budget_json TEXT                           -- max_runtime_ms / max_steps / credit-pool (the 2026-06-15 CC pool!) etc
audit_correlation_id TEXT                  -- ties job to the originating decision (trust-scope or chokepoint)
federation_role TEXT                       -- 'originator' | 'participant' | 'convener' | NULL for local
originator_peer TEXT                       -- peer id when dispatched by a peer (Phase 5)
grant_id TEXT                              -- trust-scope id this job runs under (Phase 4)
```

**Migration shape (Phase 1):** new `jobs` table, additive. The `workers` table stays during the Phase 3 cutover and is dropped only when the dashboard + tools no longer reference it. CC's BOM rule #2 (write-verify-commit-same-turn) applies: migrations land in the same commit as the code that consumes them.

**`WorkerRecord` → `JobRecord`:** the columns map almost 1:1. The new entries are `binding_kind`/`binding_target`/`params_json` (replacing the conflated `type` + `metadata_json.cwd`), `budget_json`, `grant_id`, `federation_role`, `originator_peer`, `result_json`. `pid` moves into `metadata_json` (only the process-spawn binding has one). `spawn_params_hash` → `params_hash`. `cwd` moves into `metadata_json`.

**`WorkerStatusT` → drop.** The legacy five-value status (`starting`/`running`/`idle`/`terminated`/`crashed`) was already conflating outcomes; the eight-state lifecycle from `workers/lifecycle.ts` becomes authoritative. Phase 3 deletes the column once nothing reads it.

---

## 3. The `worker_*` MCP tool surface

Six tools registered in `src/workers/tools.ts`, categorised in `src/tools/categories.ts` as `category: 'worker'`, tiers `AUTO` (list/status/list_types) + `CONFIRM` (spawn/dispatch/terminate), classes `reversible` (list/status/list_types) + `irreversible` (spawn/dispatch/terminate). Each has a tool card under `docs/tool-cards/worker_*.md`.

| Tool | Today | → Target |
|---|---|---|
| `worker_list_types` | Returns registered spawner types + their param schemas (`WorkerTypeDescriptor`). Tier `AUTO`. | → **`job_list_bindings`**. Returns the four binding kinds + their named targets (cc-process, ollama, the operator's python MCP, registered peers as remote targets). Auto tier. The four-kind enum is the closed taxonomy; the targets are the open catalogue. |
| `worker_spawn` | Validates params, runs admission control, runs tier gate, spawns a `WorkerInstance`, persists a `WorkerRecord`, returns `{worker, gated}`. Tier `CONFIRM`. | → **`job_dispatch`** (the BOM names this — it is the *job-level* dispatch, distinct from the today-`worker_dispatch` per-message thing). Input: `{ binding_kind, binding_target, params, budget?, grant_id? }`. Persists a `JobRecord` in `dispatched` state, hands to the chosen binding, transitions to `running`. CONFIRM-tier; Phase 4 makes it grant-scope-aware. |
| `worker_list` | Lists `WorkerRecord` rows with optional type/status filter. AUTO. | → **`job_list`**. Same shape over the new `jobs` table; filter by `binding_kind` / `lifecycle_state`. |
| `worker_status` | Full state of one worker by id or name. AUTO. | → **`job_status`**. Same shape over the job record. |
| `worker_dispatch` | Delivers an instruction to a *running* worker (in-flight injection). Tier `CONFIRM`. | → **`job_inject`**. Renamed to clarify it is mid-flight injection — the BOM's "dispatch" word is taken by the new job-level dispatch. The MCP-call binding routes it via the protocol's optional `worker_inject` (advertised in capabilities). The process-spawn binding routes it via stdin or a named pipe (binding-specific). CONFIRM-tier. |
| `worker_terminate` | Terminates a worker (always CONFIRM regardless of spawner tier). | → **`job_terminate`**. Unchanged behaviour; always CONFIRM; renamed. |

**Renames are NOT cosmetic** — the 10-3-1 retired the "worker" word. The cutover renames every call site, every event kind, every tool-cards file, every dashboard URL fragment.

**One-tool consolidation candidate flagged for Phase 3 review:** `job_status` and `job_list` could fold into a single tool with optional filter, mirroring the BOM's discipline about not regrowing the surface. Leaving as separate for now to preserve the AUTO-vs-AUTO categorisation that already works.

**`normalizeUnknownArg`** (the JSON-string-encoded-args shim for Cowork's legacy MCP serializer) carries forward verbatim — it is per-client legacy, unrelated to invoke+job.

---

## 4. Event taxonomy

In `src/event-types.ts`, eleven `worker_*` event kinds today:

| Event | Today | → Target |
|---|---|---|
| `worker_spawned` | Emitted when a worker enters `running`. | → `job_started`. |
| `worker_progress` | Per-step progress (message + optional payload). | → `job_progress`. |
| `worker_metadata_changed` | Patch of metadata mid-flight. | → `job_metadata_changed`. |
| `worker_activity` | "Touch" event when the worker shows any sign of life. | → `job_heartbeat`. (The BOM names the lifecycle bucket `heartbeating` — this is the event that drives it.) |
| `worker_dispatch_request` | When an operator injects an instruction. | → `job_inject_request`. |
| `worker_terminated` | Terminal — `{id, reason, exit_code}`. | → `job_terminated`. |
| `worker_error` | Mid-flight recoverable / non-recoverable error. | → `job_error`. |
| `worker_log` | One stdout/stderr line (raw or stream-json). | → `job_log`. |
| `worker_stuck` | Watchdog-emitted, `last_activity_at > threshold`. | → `job_stuck`. |
| `worker_dispatch_failed` | AV-attributed dispatch failure (rich payload). | → `job_dispatch_failed`. (Process-spawn binding only — keep the AV attribution payload.) |
| `worker_blocked_by_av` | AV blocked a spawn. | → `job_blocked_by_av`. |
| `worker_blocked_by_signature` | Worker script signature verification failed. | → `job_blocked_by_signature`. |
| `host_ceiling_refused` | Admission denied. Already neutral on `worker_` vs `job_`. | → keep verbatim. |
| `host_ceiling_shed` | Load-shed fired. Already neutral. | → keep verbatim. |

**Event taxonomy migration is a Phase 3 deliverable** (the cutover) — the events are part of the public broker surface, so renaming is a breaking change for any external subscriber. The strategy is dual-emission for one release window: emit both `worker_*` and `job_*` so the dashboard + external consumers migrate at their own pace, then drop the legacy emitters in the next release.

---

## 5. Dashboard surface

### Pages

- **`src/dashboard/pages/workers.ts`** — the dedicated multi-pane terminal view (one pane per running worker, capped at 20, 4-wide responsive grid). Reads `WorkersData = { workers: WorkerRecord[]; recent: Record<string, StoredEvent[]> }`. **→ rename to `jobs.ts`** + URL move `/dashboard/workers` → `/dashboard/jobs`, with a 301-equivalent shim from `/workers` for one release window (mirrors the existing `streams → workers` legacy alias pattern at `src/dashboard/shell.ts:104`).
- **`src/dashboard/pages/helm.ts`** — references `/dashboard/workers` for the workers band (`band[data-slot="workers"]`), the active-counter chip, the "view N historic →" link. Reads `worker-counters` + `worker-roster`. **→ re-point** at `/dashboard/jobs` + the renamed data modules. The band label "Workers" becomes "Jobs" but the chip computation stays.
- **`src/dashboard/pages/topology.ts`** — feeds the constellation from worker records (graph nodes are workers + tools + peers). **→ re-point** at job records; visually identical.
- **`src/dashboard/pages/diagnostics.ts`** + **`diagnostics-details.ts`** — display per-worker rows in the engine-room view. **→ re-point** at job records.
- **`src/dashboard/pages/history.ts`** — already excludes the live `/workers` surface ("§4 live mode: explicit NOT in v0.8"). **→ re-point** label only; structure unchanged.

### Data fetchers

- **`src/dashboard/data/worker-counters.ts`** — `WorkerCounters` + `WorkerCountersByState` over the `LifecycleState` enum; `fetchWorkerCounters`, `fetchActiveWorkerCount`, `formatCounterSummary`. **→ rename `job-counters.ts`**, swap `WorkerRecord` for `JobRecord`. The lifecycle-driven counting model is exactly right — the BOM v0.6.6 invariant ("single source of truth, no page-specific definition of active") is preserved verbatim.
- **`src/dashboard/data/worker-roster.ts`** — `RosterEntry`, `fetchActiveWorkers`, `fetchHistoricWorkers`, `fetchStaleWorkers`, `fetchFullRoster`, retention windows. **→ rename `job-roster.ts`**, same semantics.

### Shell + nav

- `src/dashboard/shell.ts:48` — `'workers'` page id, `:71` Workers nav entry, `:100-104` legacy `Streams` alias. **→** the page id becomes `'jobs'`; the Workers alias becomes the **second** legacy alias (alongside Streams) for one release window, then deleted.

---

## 6. Observability

- **`src/observability/worker-retention.ts`** (resolves env-driven retention: `STAVR_WORKER_RETENTION_HOURS` archival window 4h, `STAVR_WORKER_HARD_DELETE_DAYS` hard-delete 30d). **→ rename `job-retention.ts`**. Env vars rename to `STAVR_JOB_RETENTION_HOURS` / `STAVR_JOB_HARD_DELETE_DAYS` with backwards-compat readers for the old names during the cutover window (operators set these in their `.env`; silent breakage at boot is the worst outcome).
- **Watchdog** (`src/workers/watchdog.ts`) → see §1, renamed to `job-watchdog.ts`.
- **Admission control** (host-ceiling) lives in the orchestrator. → unchanged behaviour, the four checks (`max_concurrent_workers`, `min_free_ram_gb`, `max_host_ram_pct`, `max_sustained_cpu_pct`) all become `max_concurrent_jobs` etc. The knob *names* in `stavr.yaml` rename; the values are operator-tuned, so the migration must read both names for one release.
- **Load shedding** (`orchestrator.shedWorker` / `liveCount` / `liveWorkerIdsInSpawnOrder`) → renamed to `shedJob` etc. The shed-victim picker (Phase 5 of host-resource-ceiling BOM, separate from this BOM's Phase 5) reads `liveJobIdsInSpawnOrder`.
- **Metrics** — `tests/observability/metrics.test.ts` exists; Phase 3 reads it and migrates any `worker_*` gauges to `job_*`. Out of scope to enumerate at recon time.

---

## 7. Federation peer plumbing — the Phase 5 substrate

`src/federation/*` today (7 modules):

| File | Role |
|---|---|
| `peers.ts` | Loads `~/.stavr/peers.yaml` — operator-affirmed peer list. Returns `PeersYaml`. |
| `peer-registry.ts` | In-memory registry of known peers, populated from peers.yaml + mDNS. |
| `peer-client.ts` | HTTP client for inter-peer traffic (`GET /api/federation/health`, walk-candidates with last-working cache, multi-IP peer support). |
| `routes.ts` | Receiving side — mounts `GET /api/federation/health` + `GET /api/federation/peers`. Phase 3 of *that* roadmap adds `POST /api/federation/event` + `POST /api/federation/bom`. |
| `mdns.ts` | mDNS discovery + `STAVR_PROTOCOL_VERSION`. |
| `index.ts` + `reporter.ts` | Subsystem init + broker-event mirroring of peer-joined/peer-left. |

**None of the federation files reference workers today** — verified by grep. The federation substrate is intentionally agnostic.

**Phase 5 surface to add (NOT in this recon's scope to implement):**

- `POST /api/federation/job/dispatch` — peer-to-peer job dispatch. Body is a signed JSON-RPC envelope carrying `{ job_id, binding_kind, binding_target, params (refs only), grant_id, budget, ... }`. The resource owner's stavR checks the grant + opens a `JobRecord` locally. Credentials never cross the wire.
- `POST /api/federation/job/status` — peer-side status push, the control plane.
- Content-addressed blob exchange — separate data plane endpoint(s), `{ hash, size, content-type, data-class }` references in the control envelope, blobs fetched out-of-band.
- Outbox pattern for cross-node messages — write-to-own-log-first, async delivery with retry, idempotent at-least-once. The existing broker is the obvious base for this — Phase 5 layers an outbox table on top.

**Federation role attribution** is already in the spawner-protocol's `worker_init` input schema (`federation_role: 'originator' | 'participant' | 'convener'`, plus `originator_peer`). That schema carries forward into the job record's `federation_role` + `originator_peer` columns.

---

## 8. The scope-aware enforcement gap (Phase 4)

Today's enforcement (`src/security/decision-gate.ts` + `src/workers/orchestrator.ts::gate`):

1. **Per-actor tier matrix** — every (actor, tool) maps to AUTO / CONFIRM / EXPLICIT. The structural chokepoint reads this matrix and either short-circuits (AUTO) or opens an `await_decision` (CONFIRM/EXPLICIT, with `tier3-gate.ts` layering passkey-freshness on EXPLICIT).
2. **Trust scopes** — `TrustStore.findActiveScopeFor({tool, args})` short-circuits CONFIRM-tier calls *when an active scope covers the call*. The orchestrator wires this in `gate()` (orchestrator.ts:497-515).
3. **Recorded under scope** — successful in-scope actions increment `actions_executed` and append to `scope_actions` (orchestrator.ts:524-527, store.recordScopeAction).

**The gap.** Today's check is "does *any* active scope cover this call." That is sufficient for the single-operator local case (the operator IS the only principal). For federation:

- A *federated principal* dispatches a job under a *specific grant* (carried in the request).
- The resource owner's stavR must validate against **that specific grant** — resource + features + budget + expiry — not just "any active scope."
- The grant ID must be persisted on the job record (column `grant_id` in §2) and re-checked **per step**, not just at dispatch.

Phase 4's change-set, summarised: (a) the chokepoint accepts a `grant_id` from a federated request envelope and passes it down; (b) `findActiveScopeFor` gains a `grant_id` filter so a scope must match BOTH the tool/args AND the grant the requester is using; (c) every job step (each `job_inject`, each binding callback that issues a downstream tool call) re-checks against the grant; (d) budget is decremented per step on the grant, not just at dispatch; (e) expiry/cap exhaustion fires before the step runs, not after.

This is a security primitive — the BOM's `high` sensitivity + operator approval gate is the right posture.

---

## 9. Tests inventory (what the cutover will touch)

`tests/workers/*` — 13 files, 1 admission-control + 1 watchdog + 1 orchestrator + 10 spawner-specific (cc, shell, unity, av-detector, lifecycle, mcp-workers-config, script-writer, spawner-mcp, spawner-protocol, cc-log).

`tests/integration/host-resource-ceiling.test.ts` — wires the real `WorkerOrchestrator` with a real broker + persistence. Will require a JobOrchestrator counterpart at Phase 3.

`tests/dashboard/topology.test.ts`, `tests/dashboard/topology-data.test.ts`, `tests/dashboard/tools-page.test.ts`, `tests/dashboard/permissions-page.test.ts` — reference worker types / counters / roster. Cutover renames.

`tests/observability/metrics.test.ts` — gauges referencing worker counts. Cutover renames.

`tests/security/chokepoint.test.ts`, `tests/security/actor-permissions.test.ts`, `tests/security/capability-overrides.test.ts`, `tests/security/policies.test.ts`, `tests/security/policies-yaml.test.ts` — reference worker_spawn / worker_dispatch / worker_terminate in tier matrices and capability strings. Cutover renames.

`tests/federation/phase5-bind-and-fence.test.ts` — already exists; **Phase 4 + 5 will extend, not rename**.

`tests/tools/categories.test.ts`, `tests/tools/registry.test.ts`, `tests/tools/registry-gate.test.ts` — tool registration shape; cutover renames.

**Test-mutation policy** (per CLAUDE.md §1): assertions that pin legacy `worker_*` tool names / event names / column names are **legacy-contract assertions** and are deleted/rewritten *in the same commit* as the cutover. Load-bearing assertions (data shape, runtime behaviour) are preserved.

---

## 10. Docs to update at cutover

- `docs/writing-a-worker.md` → `docs/writing-a-job-binding.md` (and the contents change substantially — the audience is "implementing a new binding kind" or "registering a new binding target," not "implementing a worker type from scratch").
- `docs/worker-spawn.md` → `docs/job-dispatch.md`.
- `docs/unity-worker.md` → folds into the HTTP-binding doc if Unity survives the cutover; otherwise archived.
- `docs/tool-cards/worker_*.md` → `docs/tool-cards/job_*.md`.
- `docs/tool-catalogue.json` references `category: 'worker'` (`src/tools/catalogue-data.ts:758-866`) — rename to `category: 'job'`.
- `ARCHITECTURE.md:400` references `WorkerOrchestrator` in a mermaid sequence diagram — update at Phase 3.
- `CONTRIBUTING.md:181` references `WorkerOrchestrator.gate` helper — update at Phase 4.
- `adr/014-spawner-static-registry.md` — supersede with a new ADR ("binding catalogue is closed-kind + open-target; ADR-014's no-FS-scan invariant carries forward").
- `adr/015-federation-readiness-design-constraint.md` — explicitly authored "the worker model is independent of in-process `WorkerInstance`" — that constraint is satisfied by the job-record-decoupled-from-binding split. The ADR stays but its language updates to the new vocabulary at Phase 3.

---

## 11. What is NOT in this BOM (clear scope boundary)

- The specific `claude-code-subprocess` binding target and the `claude.execute` MCP tool — a separate downstream BOM (`proposed/claude-execute-mcp-tool-bom.md`). This BOM stops at the generic substrate.
- Replacing the WebRTC transport (ADR-042 §Decision 2) — deferred to v1.0, federation runs over the existing HTTP surface.
- The typed-friction-string ceremony for EXPLICIT — separate `v0_7-tier-3-explicit-consent` BOM. Phase 4 uses passkey freshness + grant scope; the friction string is out of scope.
- Any change to who the operator IS (Lex Insculpta — the operator is sovereign). Federation extends the principal model to "federated principal with a grant," but the local operator remains the policy ground.

---

## 12. Open questions for the operator (before Phase 1)

1. **Unity binding fate.** Is anyone currently exercising the Unity worker, or is it dormant scaffolding? If dormant, the Phase 3 cutover deletes it rather than rename + split. (Recommend: delete unless the operator confirms active use.)
2. **`worker_dispatch` → `job_inject` rename — is "inject" the right verb?** It is more specific than "dispatch" (which is now the job-level word) but slightly aggressive in connotation. Alternatives: `job_steer`, `job_message`. Recommend: `job_inject` (matches the existing optional MCP tool name in `spawner-protocol.ts::OPTIONAL_TOOLS`).
3. **Dual-event-emission window length.** Phase 3 emits both `worker_*` and `job_*` events for one release window before dropping the legacy emitters. How long is one release window? (Recommend: one minor — 0.7.x to 0.8.0.)
4. **Retention env-var rename strategy.** `STAVR_WORKER_RETENTION_HOURS` → `STAVR_JOB_RETENTION_HOURS`. Read both during the window with the new one winning; warn-on-boot if only the old one is set. Confirm.
5. **The `claude-code-subprocess` follow-up BOM** — is it expected to land in the same release as Phase 3 (so the CC path migrates cleanly in one operator-visible step) or to follow a release later (so the substrate stabilises before the first concrete binding lands)? The BOM declares it "downstream context, not your concern in this BOM," so this is operator-judgement.

---

## 13. Summary of the migration map

| Surface | Today | → Phase | → Outcome |
|---|---|---|---|
| `src/workers/types.ts` `WorkerSpawner` | per-type interface | 1 | becomes `ExecutorBinding` interface (4 kinds) |
| `src/workers/orchestrator.ts` `WorkerOrchestrator` | spawner orchestrator | 1, 3 | becomes `JobOrchestrator`; tier-gate moves to chokepoint; admission/idle/shed survive |
| `src/workers/spawner-protocol.ts` | MCP-worker protocol | 2 | becomes `mcp-call-binding` protocol; optional `inject` → binding capability |
| `src/workers/spawner-mcp.ts` | MCP-worker adapter | 2 | becomes MCP-call binding implementation |
| `src/workers/mcp-workers-config.ts` | manifest loader | 2 | becomes binding-target catalogue loader |
| `src/workers/spawners-registry.ts` | static spawner list | 2 | becomes binding-target catalogue |
| `src/workers/cc.ts` | in-process CC spawner | 2, 3 | callers of process-spawn / cc-session-attach bindings; lifecycle ownership lifts out of stavR (prefer attach) |
| `src/workers/shell.ts` | in-process shell spawner | 3 | caller of process-spawn binding |
| `src/workers/unity.ts` | in-process Unity spawner | 3 | caller of HTTP + process-spawn bindings — OR deleted, operator confirms |
| `src/workers/av-detector.ts` | AV/EDR detection | 3 | unchanged; wired to process-spawn binding's failure path |
| `src/workers/script-writer.ts` | signed-script writer | 3 | unchanged; helper for shell-binding callers |
| `src/workers/emitter.ts` | `WorkerEventBus` | 3 | deleted (inlined) |
| `src/workers/watchdog.ts` | stuck-worker watchdog | 3 | rename `job-watchdog.ts`; emits `job_stuck` |
| `src/workers/lifecycle.ts` | lifecycle state derivation | 1, 3 | rename `JobLifecycleState`; 8-state enum becomes authoritative |
| `src/workers/tools.ts` | 6 MCP tools | 3 | becomes 6 `job_*` MCP tools (rename + repurpose) |
| `workers` table | sqlite schema | 1, 3 | new `jobs` table additive at Phase 1; `workers` table deleted at Phase 3 |
| `worker_*` event taxonomy | 13 event kinds | 3 | dual-emit `job_*` for one release window, then drop |
| `/dashboard/workers` page + data | 1 page + 2 fetchers | 3 | rename to `/dashboard/jobs`; legacy alias for one window |
| Helm + Topology + Diagnostics + History | reference workers | 3 | re-point at job records; visually identical |
| `src/observability/worker-retention.ts` | retention | 3 | rename `job-retention.ts`; env vars rename with backwards-compat |
| `src/security/decision-gate.ts` chokepoint | tier-matrix + scope short-circuit | 4 | grant-scope-aware: per-step, against specific grant id |
| `src/trust/store.ts::findActiveScopeFor` | scope lookup | 4 | adds `grant_id` filter |
| `src/federation/routes.ts` | health + peers endpoints | 5 | adds `/api/federation/job/dispatch` + `/status` + content-addressed blob plane + outbox |
| federation principal model | local operator only | 4, 5 | extends to federated principal holding a signed grant |

---

## End of recon
