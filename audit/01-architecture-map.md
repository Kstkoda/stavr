# Audit 01 — Architecture Map

> Actual module structure of `src/`, how subsystems connect, a representative request flow, and where the ADRs disagree with the code.

## 1. Module structure of `src/`

198 TypeScript files, ~52,300 LOC, organised around 17 subsystems plus 23 root entry/glue files.

### Root entry / glue (23 files in `src/`)

| File | Purpose |
|---|---|
| `cli.ts` | Main CLI router: `daemon`, `start`, `tail`, `pair`, `usage`. |
| `daemon.ts` | Boot sequence: load config → init EventStore → create Broker → mount transports → wire steward/workers/federation/observability → listen. Owns PID at `~/.stavr/daemon.pid`. |
| `server.ts` | `createSwitchServer()` — per-session MCP server. Registers every tool subsystem. Wraps server for tool registry + Layer 0 capability gate. WeakMap by broker for daemon-scoped singletons (orchestrator, trustStore, stewardStore, credentialStore, notifier, toolRegistry, capabilityOverrides, actorPermissions, identityStore, WebAuthn, federation). |
| `broker.ts` | Event fan-out: SQLite append → MCP subscribers → SSE taps. `Broker.publish()` is the central join point. |
| `persistence.ts` | `EventStore`: better-sqlite3, schema migration, tables `events`/`workers`/`decisions`/`trust_scopes`/`actor_permissions`/`trust_scope_actions`. Graceful degradation (rename + rebuild on corruption). `pruneEvents()` is the retention entry. |
| `transports.ts` | Mounts Streamable HTTP MCP transport + stdio + dashboard routes. Houses the SSE session map, janitor (5-min), digest, decision-response endpoints. |
| `shim.ts` | Stdio→Streamable-HTTP shim (~150 LOC). Exponential backoff per ADR-019: 1s→5min, 30s clean reset, 1h give-up. |
| `config.ts`, `paths.ts`, `log.ts` | Config loader, path resolver, pino logger. |
| `event-types.ts` | Zod enum + payload schemas for all event kinds (50+). `validatePayloadForKind()`. |
| `pairing.ts`, `devices-storage.ts` | Device pairing + persistent token store. |
| `usage.ts`, `usage-cli.ts` | Token/cost accounting + CLI. |
| `tail.ts` | `stavr tail` — stream events to stdout. |
| `watchdog.ts`, `watchdog-install.ts` | Daemon supervisor — pings `/healthz` every 30s, restarts on failure (ADR-020). |
| `connect-test.ts` | Connectivity probe to a running daemon. |
| `steward-ask-tool.ts`, `steward-ask-cli.ts`, `steward-bug-fix.ts`, `steward-bug-fix-cli.ts` | Steward helper tools (operator-driven). |

### Subsystems

| Dir | Files | Role |
|---|---|---|
| `broker.ts` (root) | 1 | Event fan-out, subscriber registry, taps |
| `transports.ts` (root) | 1 | Express mount: MCP /mcp + dashboard + SSE |
| `persistence.ts` (root) | 1 | SQLite event store + retention entrypoint |
| `steward/` | 16 | In-process planner+executor (v0.3), provider abstraction (`providers/anthropic|openai|claude-code|ollama.ts`), IPC scaffold (`ipc.ts`), v0.2 wiring shim |
| `steward-agent/` | 17 | Subprocess agent scaffolding (v0.5 target). `main.ts`, `loop.ts`, `autonomy/{proactive,reactive,scheduled,probation}.ts`, `runtimes/{anthropic,openai,ollama,retry,schemas,_drain}.ts`, `db/{init,types}.ts`. **Most files exist but the subprocess is not yet cut over** — daemon still uses in-process `src/steward/loop.ts` |
| `workers/` | 15 | Orchestrator + spawners (cc, shell, unity, av-detector), MCP-backed spawner (`spawner-mcp.ts` + `spawner-protocol.ts`), static registry (`spawners-registry.ts`), lifecycle, watchdog, emitter, tools |
| `trust/` | 6 | TrustStore, matcher, no-go list, reporter, tool registrations, types |
| `security/` | 13 | Layer 0 capability overrides, Layer 1 actor permissions, host-exec (allowlist/config/runner/tool), identity store, WebAuthn + routes, tier3 gate, policies, script signing |
| `credentials/` | 5 | Vault (AES-256-GCM via libsodium), store, tools, CLI, types |
| `federation/` | 7 | createFederation, peers.yaml loader, registry, mDNS coordinator, peer client, reporter, routes |
| `observability/` | 12 | Prometheus metrics, OTel SDK, pino logger, retention, memory/perf/RSS pollers, event-loop monitor, worker-retention, debug endpoints |
| `notify/` | 13 | Notifier + channels (email/ntfy/telegram), reply-router, telegram poller + directives, digest scheduler, rate-limit, correlation, inbound, wiring |
| `dashboard/` | 52 | Index + shell + tokens + memo, 18 pages, 13 components, 9 data snapshot factories, 3 adapters, 5 topology widgets |
| `tools/` | 7 | Registry, categories (tier system), decisions, gated-action helper, propose-plan, capture, catalogue-data |
| `connectors/` | 3 | Connector base, webhook receiver |
| `adapters/` | 2 | github (read), github-writes (write — gated via `gatedAction()`) |
| `bricks/` | 3 | Module/toolkit installer + manifest + registry |
| `policy/` | 1 | Family/team policy presets |
| `types/` | 2 | Shared types (BOM, federation) |
| `util/` | 1 | `safeWrite()` atomic temp+rename |

## 2. Representative request flow — `worker_spawn` over MCP

End-to-end trace from MCP client to event fan-out:

1. **Transport decode** — Client POSTs JSON-RPC to `/mcp`. `src/transports.ts` mounts `StreamableHTTPServerTransport`. The SDK validates + dispatches by tool name.
2. **Handler invocation** — `src/workers/tools.ts:38` `registerWorkerSpawn` handler:
   ```
   const params = normalizeUnknownArg(args.params, 'params');
   const result = await orch.spawn(args.type, args.name, params);
   return toolJson({ worker: serializeWorker(result.worker), gated: result.gated });
   ```
3. **Tier gating** — `src/workers/orchestrator.ts:120` checks spawner tier. If `confirm` and the operator has not granted a covering trust scope, calls `broker.createDecision()` → SQLite `decisions` row → broker event → SSE → dashboard Decide page.
4. **Trust scope short-circuit** — `src/trust/store.ts findActiveScopeFor()` checks for a matching `TrustScope`. If matched, auto-approve, record action in `trust_scope_actions`, emit `trust_scope_action_authorized` (no decision opened).
5. **Spawner.spawn** — built-in (e.g., `src/workers/cc.ts`) forks a child process; MCP-backed (`spawner-mcp.ts`) opens StdioClientTransport to an external MCP server and calls `worker_init` → `worker_step` (long-poll loop) → `worker_finalize`.
6. **Event emission** — `src/workers/emitter.ts WorkerEventBus` forwards `worker_spawned` / `worker_progress` to `broker.publish()`.
7. **Broker fan-out** — `src/broker.ts:90` `publish()`:
   - appends to SQLite (`events` table) — single transaction
   - sends `notifications/event/published` MCP message to every subscriber session
   - calls every SSE tap (dashboard listeners)
   - increments Prometheus counter via `recordBrokerEvent()`
8. **Tool response** — handler returns `toolJson({...})` → SDK marshals JSON-RPC → transport returns.

Audit property: each step carries the same `correlation_id`. A backward walk by correlation_id reconstructs the full chain (request → decision → scope authorisation → spawn → progress events).

## 3. Cross-process boundaries

### Daemon ↔ Steward subprocess (ADR-032, PARTIAL)
- `src/steward/ipc.ts` defines the channel: `child_process.fork()` JSON messages.
- Envelope types `IpcDaemonMessage` / `IpcStewardMessage`.
- 30s heartbeat (daemon ping, steward pong). Missing pong → restart steward.
- **Today (v0.3):** in-process loop in `src/steward/loop.ts` runs in daemon. Subprocess scaffolding exists in `src/steward-agent/` but is not the live path. Cutover is the v0.5 target.

### Daemon ↔ Workers
- **Built-ins (shell, cc, unity, av-detector):** stdio or `child_process.fork()`. WorkerEventBus forwards subprocess events to broker.
- **MCP-backed (`spawner-mcp.ts`):** spawns external MCP server over StdioClientTransport. Spawner calls `worker_init`/`worker_step`/`worker_finalize` MCP tools. This is the polymorphic-worker shape from ADR-042 Decision 5.

### Daemon ↔ Governor (ADR-040, NOT STARTED)
- Designed: Tauri 2 tray app supervises engine; transport is Unix domain socket / Windows named pipe at `~/.stavr/governor.sock` + HTTP loopback to `/dashboard`.
- Today: PM2 is the supervisor. `governor/` Rust crate exists (Cargo target compiles), but is not wired into the operator-visible runtime.

### Daemon ↔ Rust core (ADR-039, NOT STARTED)
- Designed: JSON-RPC 2.0 over stdin/stdout to a long-lived `stavr-core` binary that handles event signing, host-exec allowlist enforcement, scope cap accounting.
- Today: those concerns live in Node (`src/persistence.ts`, `src/security/host-exec-*.ts`, `src/trust/store.ts`).

## 4. ADR claims vs actual layout

| ADR | Status | Evidence |
|---|---|---|
| 028 Dashboard architecture | **IMPLEMENTED** | `src/dashboard/{tokens,shell,index}.ts` + `components/` + `pages/` + `adapters/` + `data/`. Server-rendered HTML + vanilla JS as specified. |
| 030 Event retention + dashboard caching | **IMPLEMENTED** | `src/observability/retention.ts` OPERATIONAL/AUDIT sets; `src/dashboard/memo.ts` single-slot TTL cache; streams capped at 100. Caveat: test run emitted `pruneEvents: uncategorized event kinds preserved` — implies the live system silently has uncategorised kinds; ADR-030 says these are "never deleted" but does not constrain growth. Borderline. |
| 031 Observability | **IMPLEMENTED** | `metrics.ts` (prom-client), `otel.ts` (OTel SDK + OTLP exporter, opt-in via env), `logger.ts` (pino + AsyncLocalStorage), `debug-endpoints.ts` (loopback + env-gate + rate-limit). |
| 032 Steward portable agent | **PARTIAL** | Subprocess scaffold present in `src/steward-agent/` + IPC in `src/steward/ipc.ts`. In-process loop in `src/steward/loop.ts` is still the live path. Cutover deferred. Three-store split (memory/lessons/prefs) is **not** wired. |
| 039 Polyglot core (Rust extraction) | **NOT STARTED** | No `stavr-core` Rust crate. Logic in Node. ADR explicitly Proposed. |
| 040 Three-process architecture | **PARTIAL** | Engine ✅; Steward subprocess scaffold ⚠️ shadow; Governor ❌ no Tauri wiring beyond `governor/` cargo project. |
| 041 Universal signal trace | **PARTIAL** | Correlation_id + AsyncLocalStorage ✅; event kinds enumerated ✅. LLM body capture toggle, auto-redaction, DB instrumentation not yet present. |
| 042 Federation roles / discovery / identity / viz / worker polymorphism | **PARTIAL** | `federation/{peers,peer-registry,mdns,peer-client}.ts` + `security/webauthn*.ts` + `dashboard/widgets/topology-*.ts` + `workers/spawner-{mcp,protocol}.ts`. Roles, federation-key derivation (Option B), full per-node metric drill-down (audit/09 lists this as DEAD) all incomplete. |

### Numerical claim vs reality summary

- ADRs marked **IMPLEMENTED**: 001–024 (the early stack), 028, 030, 031 — confirmed.
- ADRs marked **PARTIAL / PROPOSED in code**: 008 (write gating present but enforcement not universal — see audit/06), 032, 035, 036, 037, 038, 040, 041, 042.
- ADRs marked **NOT STARTED**: 033 (Tauri tray companion — superseded by 040), 039 (Rust polyglot).
- ADR-023 collision: `023-param-constraint-matching-syntax.md` (2026-05-12) and `023-shared-memory-on-stavr-daemon.md` (2026-05-14) **share the same number**. See audit/05.
- ADR gaps: 010, 011, 025, 026, 027, 029 are missing slots. Likely intentional (proposals that were abandoned) but worth a README note in `adr/`.

## Notable divergences flagged by inspection

1. **`src/steward-agent/`** carries the v0.5 architecture but the daemon doesn't fork it. Two parallel codebases for the same concern. Risk: drift between in-process loop (live) and subprocess loop (dormant). Mitigation: add a CI test that asserts subprocess parity once cutover is real.
2. **Federation mDNS** emits `ServiceConfig requires \`port\` property to be set` warnings ~40× during the test suite. Either tests leak real mDNS or the production config path is also incomplete. Cross-referenced in audit/03 (test warnings) and audit/06 (federation gaps).
3. **The dashboard data fetchers (`src/dashboard/data/*`)** are a layer not described in any ADR. They are the contract between substrate and UI, but no ADR defines their lifecycle/cache/retention semantics — this surface is governed implicitly by `src/dashboard/memo.ts` plus ad-hoc per-fetcher choices.
4. **`src/policy/` is 1 file** (presets). All other policy decisions live in `src/security/` and `src/trust/`. Renaming `policy/` away (or absorbing into `security/`) would reduce confusion.
