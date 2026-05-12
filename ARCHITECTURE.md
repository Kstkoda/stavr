# Architecture

This document explains how Cowire is put together. It targets a contributor who has read the [README](./README.md) and now wants to extend, debug, or reason about the system. Read it once end-to-end (~20 minutes) and you should be able to find your way around any file in `src/`.

For each component we name the file path so you can jump to the canonical implementation.

---

## What is Cowire?

**Cowire** is an MCP-native broker — a single process that sits between cooperating agents (Co, CC, future agents) and the human user, and that turns every interesting moment of their work into a typed, persisted event.

The broker process is called **Switch**. Switch is an [MCP server](https://modelcontextprotocol.io/) that speaks two transports at once: stdio (for clients embedded as child processes) and HTTP/SSE (for long-lived remote clients like Cowork dashboards and other agents). It owns:

- an append-only event log (SQLite)
- a decision queue (the `await_decision` ↔ `respond_to_decision` rendezvous)
- a set of tool *adapters* (read GitHub via `gh`, more to come)

This repository is the reference implementation of Switch. Agents are *clients*; Switch is the server they all share.

---

## The big picture

```
┌──────────┐                ┌────────────────────┐                ┌──────────┐
│  Cowork  │◀──── MCP ─────▶│                    │◀──── MCP ─────▶│   CC-1   │
│  (Co)    │   (SSE/HTTP)   │                    │   (SSE/HTTP)   │ branch:  │
└──────────┘                │   Switch daemon    │                │ feat/B007│
                            │                    │                └──────────┘
┌──────────┐                │   - broker         │                ┌──────────┐
│   CC-N   │◀──── MCP ─────▶│   - event store    │◀──── MCP ─────▶│   CC-2   │
│ branch:  │   (SSE/HTTP)   │   - decision queue │   (SSE/HTTP)   │ branch:  │
│ fix/B008 │                │   - adapter regis. │                │ feat/B010│
└──────────┘                │                    │                └──────────┘
                            │   :7777 MCP        │
                            │   :7777/dashboard  │  (v0.2)
                            │   :7777/api/...    │  (v0.2)
                            └────────────────────┘
                                     ▲
                                     │ HTTP (browser)
                                     │
                            ┌────────────────────┐
                            │   User's browser   │  (v0.2)
                            │   (audit / approve)│
                            └────────────────────┘
```

One daemon per host. Binds `127.0.0.1:7777` (local-only). All remote MCP clients connect via SSE; one process can also accept a stdio client for legacy / per-spawn use. The dashboard at `:7777/dashboard` is planned for v0.2 (spec 40 Phase 2).

The picture above is the **daemon topology** — see `cowire daemon start` in the README. There is also a legacy *per-spawn* mode (`cowire start --stdio-only`) where each MCP client gets its own Switch process and SQLite store; this is what an MCP client like CC uses today when configured to launch Switch as a child process. The per-spawn model is documented in [ADR-005](./adr/005-per-spawn-architecture-v01.md); the daemon model is documented in [ADR-006](./adr/006-daemon-binds-127001-only.md).

---

## Component map

### Broker — `src/broker.ts`

The broker is the in-memory router. It owns the set of *subscriptions* (which MCP session wants which event kinds) and, on every published event, fans the event out to every matching subscriber as an MCP notification on the method `notifications/event/published`.

Public surface: `class Broker` with `registerSession`, `removeSession`, `subscribe`, `unsubscribe`, `publish`, `fanout`, `replayTo`. It also holds a reference to the `EventStore` (`broker.store`) so other code can read history without going through the broker.

The broker is intentionally thin. All durability lives in the event store; all transport state lives in `transports.ts`. The broker just decides "who hears about this event next?"

### Event store — `src/persistence.ts`

A single SQLite database at `~/.cowire/cowire.db` (configurable via `--db`). Four tables:

- `events` — every event ever published. Append-only. Indexed by `kind`, `correlation_id`, and a monotonic `seq` cursor.
- `decisions` — pending and resolved decisions, keyed by `correlation_id`. Status is one of `open | responded | expired`.
- `sessions` — per-session metadata (handoff path, branch, PRs, event counts) — currently used by future tooling, not the runtime.
- `meta` — key/value bag for future runtime config.

`EventStore` is also where `await_decision` blocks: it owns a `node:events` `EventEmitter` keyed by `correlation_id`, and `awaitDecisionResponse(id, timeoutMs)` returns a `Promise` that resolves when `respondToDecision(...)` is called, or rejects with `DecisionTimeoutError` after the timeout.

Append-only semantics are a hard rule: there is no `UPDATE` on the `events` table, ever. Corrections happen by appending a follow-up event.

### Transports — `src/transports.ts`

`mountTransports(broker, opts)` brings up one or two MCP transports against the same broker:

- **stdio** — handed to a `StdioServerTransport`. One MCP session per stdio pair; created in modes `'stdio'` and `'both'`.
- **HTTP/SSE** — `express` app with `GET /mcp/sse` to open a stream, `POST /mcp/messages?sessionId=...` to send messages back, and `GET /healthz` + `GET /status` for liveness. Each SSE connection becomes its own MCP session, sharing the broker. Created in modes `'daemon'` and `'both'` (when `opts.port` is set).

Mode resolution:

- `'stdio'` — stdio only.
- `'daemon'` — HTTP/SSE only; bind failure is fatal.
- `'both'` — stdio plus optional HTTP/SSE; on `EADDRINUSE`, falls back to stdio-only with a warning. This is the legacy `cowire start` behavior and is what makes simultaneous per-spawn MCP sessions tolerable. See [ADR-007](./adr/007-eaddrinuse-graceful-fallback.md).

On startup, transports also run `startupDecisionSweep(broker)` to expire any decisions whose deadlines elapsed while Switch was down (see [Decision flow](#decision-flow-walkthrough)).

### Adapters — `src/adapters/`

Adapters expose external systems as MCP tools. The current adapter is **GitHub**, split across two files:

- **Read-only** (`src/adapters/github.ts`): 14 tools (`github.read_pr`, `github.list_prs`, `github.read_issue`, ...) backed by the locally-installed `gh` CLI.
- **Write actions** (`src/adapters/github-writes.ts`): 10 tools (`github.create_pr`, `github.merge_pr`, `github.create_issue`, `github.create_issue_comment`, `github.create_pr_comment`, `github.close_issue`, `github.reopen_issue`, `github.add_labels`, `github.remove_labels`, `github.request_pr_review`). Each is gated by `await_decision` — see paragraph below.

Auth is inherited from the host's `gh auth login` — Switch never sees a token. See [ADR-003](./adr/003-gh-cli-not-octokit.md) and the [adapter-authoring guide](./docs/writing-an-adapter.md).

Write actions are gated at the spawner level by `await_decision`. Co (or any other MCP client) invokes them, the broker emits a `decision_request`, a human approves via Cowork or the dashboard, then the underlying `gh` invocation happens. Rejection (or 30-min timeout via the fail-safe `default_option_id='reject'`) results in a no-op with `{ ok: false, reason: 'rejected_by_user' }`. The pattern is encapsulated in `src/tools/gated-action.ts` so future write adapters (Azure, Linear, etc.) reuse the same rendezvous machinery. See [ADR-008](./adr/008-write-actions-await-decision.md) and [ADR-018](./adr/018-destructive-operations-stay-manual.md) for what stays manual forever.

Adapters register with the MCP server via `registerXxxTools(server, opts?)` and are wired into the boot sequence in `src/server.ts`. Each adapter is responsible for input validation (Zod), external-command wrapping (`execFile`/`fetch`), and a stable error shape.

### Decisions — `src/tools/decisions.ts`

The two MCP tools that implement the interactive rendezvous: `await_decision` and `respond_to_decision`. They sit on top of `EventStore.createDecision` / `awaitDecisionResponse` / `respondToDecision` and also publish `decision_request` / `decision_response` / `decision_late_response` events to the broker so dashboards and audit logs see every transition.

### Server — `src/server.ts`

`createSwitchServer(broker)` builds an `McpServer`, attaches the core event tools (`emit_event`, `subscribe_to_events`, `unsubscribe`, `get_events`), wires in `registerDecisionTools` and `registerGithubTools`, and returns a `{ server, sessionId }` handle. One handle per MCP session; multiple handles share one broker.

### CLI and daemon — `src/cli.ts`, `src/daemon.ts`, `src/connect-test.ts`

Thin wrappers over the components above:

- `cowire start` — legacy per-spawn launcher (`mode: 'both'`).
- `cowire daemon start/stop/status/restart` — manages the long-running daemon via a PID file at `~/.cowire/daemon.pid`.
- `cowire connect-test` — open an SSE session to a running daemon, emit one event, subscribe, print what came back. The minimal end-to-end smoke check.
- `cowire status` / `cowire events` — read-only views over the SQLite store.

---

## Event taxonomy summary

Every event has the same envelope: `kind`, `at` (ISO timestamp), `correlation_id?`, `tenant_id?`, `source_agent`, `payload`. Payloads are typed per-kind by Zod schemas in `src/event-types.ts` — that file is the canonical source. A future build step will export the JSON Schema form (`dist/schemas/events.json`, planned in spec 41 Wave B).

| Kind | Purpose |
|---|---|
| `session_started` / `session_ended` | Bookends for an agent session (handoff path, model, exit reason, PRs). |
| `phase_started` / `phase_completed` | Coarse milestones inside a session. |
| `file_written` | A file was edited (path, lines added/removed). |
| `command_run` | A shell command finished (exit code, duration). |
| `verification` | A check (tests, lint, type) passed or failed. |
| `commit_pushed` | A git commit landed on a branch. |
| `pr_opened` | A pull request was opened. |
| `progress` | Free-form narrative line for dashboards. |
| `decision_request` | A blocking decision was opened (see below). |
| `decision_response` | The decision was resolved. |
| `decision_late_response` | A response arrived after the decision already closed via fallback. |
| `error` | An agent hit an error (recoverable or not). |
| `checkpoint` | Snapshot of branch + last commit + dirty files + next step. |

Three patterns of use:

- **Pattern A — `await_decision`**: blocking. The caller waits for a response. See below.
- **Pattern B — `subscribe_to_events`**: long-lived. The subscriber receives notifications as events are published.
- **Pattern C — `emit_event`**: fire-and-forget. The publisher does not wait for anyone.

---

## Decision flow walkthrough

`await_decision` is the most subtle piece of Switch. Here is the full path of one decision, end-to-end:

```mermaid
sequenceDiagram
    participant CC as CC (client)
    participant Sv as Switch server.ts
    participant Br as Broker
    participant DB as EventStore (SQLite)
    participant Sub as Cowork (subscriber)

    CC->>Sv: await_decision { question, options, timeout_sec, default_option_id? }
    Sv->>DB: createDecision(corr_id, ..., status='open')
    Sv->>Br: publish(decision_request)
    Br->>DB: appendEvent
    Br-->>Sub: notifications/event/published (decision_request)
    Note over CC,Sv: caller is now blocked on awaitDecisionResponse(corr_id, timeoutMs)

    Sub->>Sv: respond_to_decision { corr_id, chosen_option_id, responder }
    Sv->>DB: respondToDecision(corr_id, ...) → status='responded' + emit on EventEmitter
    DB-->>Sv: result delivered to the blocked Promise
    Sv->>Br: publish(decision_response)
    Br-->>Sub: notifications/event/published (decision_response)
    Sv-->>CC: { chosen_option_id, responder, timed_out: false }
```

The blocking primitive is in `EventStore.awaitDecisionResponse`: it installs a one-shot listener on a `node:events` `EventEmitter` keyed by `correlation_id`, and `respondToDecision` `emit`s on that same key. The `setTimeout` for the deadline is cleared on response.

**Timeout fallback**: if `default_option_id` was supplied and the timeout fires before a response arrives, Switch writes the default through `respondToDecision('switch-default')` and emits a `decision_response` event with `responder='switch-default'`. The caller returns `{ chosen_option_id: <default>, timed_out: true }`. If no default was supplied, the caller errors.

**Late responses**: if a human (or other agent) responds *after* the fallback already closed the decision, `respondToDecision` returns `{ ok: false, error: 'already_responded' }` and Switch emits a `decision_late_response` event so the dashboard can show "the answer arrived 4 seconds too late, here's what they would have chosen." The fallback choice stands.

**Crash recovery**: on every startup, `startupDecisionSweep` looks for `open` decisions whose `expires_at` already passed and marks them `expired`, emitting `decision_late_response` events with `responder='switch-startup-sweep'`. This keeps the dashboard honest after a daemon restart.

Cap: `timeout_sec` is hard-capped at 1800 (30 minutes) by the Zod schema in `event-types.ts`.

---

## Transports — when each is used

| Transport | Used by | Code path |
|---|---|---|
| stdio | An MCP client that spawns Switch as a child process (today: CC's `.mcp.json` entry running `npx cowire start --stdio-only`). One session per process. | `transports.ts` modes `'stdio'` and `'both'`. |
| HTTP/SSE | Long-lived remote clients connecting to the daemon (today: `cowire connect-test`, future: Cowork, future: dashboard). Many sessions per process. | `transports.ts` modes `'daemon'` and `'both'` when `--port` is set. |

In `'both'` mode, both run on the same process against the same broker. In daemon mode, HTTP/SSE is the only transport and bind failure is fatal — there is no point continuing if the port is taken. See [ADR-001](./adr/001-stdio-and-sse-dual-transport.md) for why we kept both.

**Shim mode** (`src/shim.ts`, `dist/shim.js`, `cowire shim`) is a thin client that speaks stdio downward (to an MCP client that requires stdio) and SSE upward (to the daemon). It exists because some MCP clients — Cowork at the time of writing — do not recognize `type: "sse"` entries in their config, so the daemon's HTTP/SSE transport is unreachable from them directly. The shim is the bridge until that gap closes. It is byte-level: it forwards JSON-RPC messages without inspection. See [ADR-009](./adr/009-stdio-sse-shim.md).

---

## Persistence

SQLite via `better-sqlite3`. WAL mode. Single file, default location `~/.cowire/cowire.db` (override with `--db`). Use `:memory:` in tests.

Why SQLite and not Postgres: Switch is a single-process local broker. We never want a "is the database server up?" question between the user and their tools. The whole datastore travels in one file you can `cp` or attach a debugger to. See [ADR-002](./adr/002-sqlite-not-postgres.md).

Schema is created idempotently in `EventStore.init` — no migrations system yet, additive changes are made by `CREATE TABLE IF NOT EXISTS` plus new `CREATE INDEX IF NOT EXISTS`. The day we need to alter an existing column, we will add a migrations table; not before.

Append-only invariant: `appendEvent` is the only writer for the `events` table. The schema has no `UPDATE` paths for that table. Corrections are new events, not edits to old ones — this is what lets the event log double as an audit log.

---

## Adapters

An *adapter* is a file in `src/adapters/<name>.ts` that exports a `registerXxxTools(server, opts?)` function. The function calls `server.registerTool(...)` for each MCP tool the adapter contributes, and the function is invoked once from `createSwitchServer` in `src/server.ts`.

The canonical adapter is `src/adapters/github.ts`. It demonstrates the patterns the [adapter-authoring guide](./docs/writing-an-adapter.md) describes in full:

- One Zod-validated input schema per tool.
- One outbound wrapper (`ghExec`) that handles the external command, error normalization, and timeouts.
- One typed error class (`GhExecError`) and one tool-error shape (`ghErrorToTool`) so failures look the same across all 14 tools.
- A test-friendly seam (`opts.exec`) for stubbing the subprocess in unit tests.

Write actions (`gh pr comment`, `gh issue create`, `gh pr merge`, ...) are now exposed in `src/adapters/github-writes.ts`. Every write call goes through `gatedAction` in `src/tools/gated-action.ts`, which opens an `await_decision` rendezvous before invoking `gh`. See spec 39 §"Tiered authorization", [ADR-008](./adr/008-write-actions-await-decision.md), and [ADR-018](./adr/018-destructive-operations-stay-manual.md) (which lists what we will *never* expose: force-push, branch delete, repo-settings changes).

To add a new adapter, see [`docs/writing-an-adapter.md`](./docs/writing-an-adapter.md) which walks through a fully-runnable weather example in `examples/weather/`.

---

## Cross-references

Cowire is the reference implementation; the design docs that drove it live in the sibling `privacy tracker/specs/` directory. This repo is self-contained — you do not need those specs to contribute. They are useful when you want the *why*:

- `../privacy tracker/specs/37_cowork-cc-event-bridge.md` — the original event-bridge architecture; the source of the event taxonomy.
- `../privacy tracker/specs/39_co-actions-and-tiered-authorization.md` — the AUTO/CONFIRM/NEVER tier model that informs tool cards (see also `docs/writing-an-adapter.md`).
- `../privacy tracker/specs/40_cowire_v0.2_daemon_multi_agent_dashboard.md` — the v0.2 vision: daemon, multi-CC orchestration, dashboard. Phase 1 (the daemon) has landed; Phase 2+ (dashboard, Co-as-orchestrator, git-aware sessions) are pending.
- `../privacy tracker/specs/41_cowire_docs_and_machine_readable_contracts.md` — the spec that produced this document and the ADRs.

Decision rationale lives in [`adr/`](./adr/). Each ADR captures one decision, its context, and its alternatives. Start with [`adr/README.md`](./adr/README.md).
