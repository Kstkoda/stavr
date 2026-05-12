# Cowire

**Cowire** is an MCP-native broker that sits between cooperating agents (Co, CC) and user channels. The broker process is called **Switch** — an MCP server that holds the event queue and decision state. Co and CC connect to Switch as MCP clients; future agents plug in by speaking MCP.

This repo is the reference implementation of Switch.

## Status

Phase A + B (MVP):
- Event emission, subscription, replay
- `await_decision` / `respond_to_decision` with timeout fallback
- Persistence in SQLite (`~/.cowire/cowire.db`)
- Two transports on one process: stdio (for CC) and HTTP/SSE (for Cowork dashboards, webhook receivers)

Spec 40 Phase 1 — daemon foundation:
- `cowire daemon start/stop/status/restart` — long-running Switch on `127.0.0.1:7777`
- Survives client disconnects; concurrent SSE clients share one Broker + SQLite store
- PID file at `~/.cowire/daemon.pid`, stale-PID detection, atomic writes
- `cowire connect-test` smoke command

See `..\privacy tracker\specs\37_cowork-cc-event-bridge.md` for the architecture.

## Install

```bash
npm install
npm run build
```

## Daemon mode (recommended)

`cowire daemon` is a long-running Switch process bound to `127.0.0.1:7777`. It survives MCP client disconnects, accepts concurrent SSE clients (one Co + N CCs), and shares a single SQLite store across all of them. This is the foundation for the v0.2 Co-orchestrates-N-CCs architecture (spec 40).

```powershell
# foreground (logs to stderr; Ctrl-C to stop)
npx cowire daemon start --port 7777

# detached (returns immediately with the PID)
npx cowire daemon start --port 7777 --detach

# inspect
npx cowire daemon status
# { "running": true, "pid": 12345, "port": 7777, "uptime_sec": 42,
#   "connected_clients": 1, "event_count": 17, "pending_decisions": 0 }

# graceful stop (SIGTERM, falls back to SIGKILL after 10s)
npx cowire daemon stop

# restart with the same port/db as the previous run
npx cowire daemon restart
```

PID file at `~/.cowire/daemon.pid` (JSON: `pid`, `port`, `started_at`, `db`). A stale PID file (process dead) is detected and overwritten automatically; a live PID requires `--force` to override.

### Connect Cowork to the daemon

In Cowork's `claude_desktop_config.json`, replace the spawn entry with a remote SSE entry:

```json
{
  "mcpServers": {
    "switch": {
      "type": "sse",
      "url": "http://127.0.0.1:7777/mcp/sse"
    }
  }
}
```

### If your MCP client doesn't support `type: "sse"`

Some MCP clients (e.g. current Cowork builds) silently ignore `type: "sse"` entries in their MCP config. For those, point the client at the **shim** instead — a small stdio↔SSE proxy that speaks stdio to the client and SSE to the daemon:

```json
{
  "mcpServers": {
    "switch": {
      "command": "node",
      "args": ["C:\\Users\\you\\path\\to\\cowire\\dist\\shim.js"],
      "env": { "COWIRE_DAEMON_URL": "http://127.0.0.1:7777/mcp/sse" }
    }
  }
}
```

The shim (`src/shim.ts` → `dist/shim.js`) is a byte-level forwarder: it does not parse messages, it just relays JSON-RPC between the two transports. From the client's perspective it's a normal stdio MCP server; from the daemon's perspective it's a normal SSE client. Cowork ends up talking to the same daemon as future CC sessions — shared event log, shared decision queue.

You can also run it interactively for ad-hoc testing:

```powershell
npx cowire shim --url http://127.0.0.1:7777/mcp/sse
```

### Smoke test

```powershell
# terminal 1
npx cowire daemon start --port 7777

# terminal 2
npx cowire daemon status
npx cowire connect-test
# { "ok": true, "connected_to": "...", "emitted_event_id": "...",
#   "subscribed_kinds": ["*"], "received_count": 1, "received_kinds": ["progress"] }
```

### Troubleshooting

- **`daemon already running (pid ...)`** — another daemon owns the PID file. Either `cowire daemon stop` or `cowire daemon start --force`.
- **Port in use but no PID file** — another process owns `:7777`. `netstat -ano | findstr 7777` to find it, or pick a different `--port`.
- **Client can't connect** — the daemon binds `127.0.0.1` explicitly. Use that literal host (not `localhost`, which may resolve to IPv6 `::1` first on Windows).
- **Stale PID file** — if the daemon was killed forcibly, the PID file is left behind. `cowire daemon start` detects a dead PID and overwrites; if you see a "stale PID file" warning, that's expected.

---

## Operations

Spec 44 added a watchdog process and deepened health checks so the daemon is effectively self-healing. The default install is *not* enabled — opt in with `cowire daemon install` when you want auto-restart-on-host-boot behavior.

### Install the watchdog

```powershell
# register the watchdog with the OS scheduler (idempotent)
npx cowire daemon install

# inspect — is it registered? running? how many restarts has it done?
npx cowire daemon watchdog-status

# remove
npx cowire daemon uninstall
```

Per-platform under the hood:

- **Windows**: two scheduled tasks — `CowireWatchdog` (`/SC ONSTART`) and `CowireWatchdogLogon` (`/SC ONLOGON`) — both running `node dist/watchdog.js` as the current user.
- **macOS**: `~/Library/LaunchAgents/com.cowire.watchdog.plist` with `RunAtLoad=true` and `KeepAlive=true`, loaded via `launchctl load -w`.
- **Linux**: `~/.config/systemd/user/cowire-watchdog.service`, enabled with `systemctl --user enable --now`. The watchdog stops on logout unless you `loginctl enable-linger $USER`.

See [ADR-020](./adr/020-daemon-watchdog.md) for the design rationale.

### Inspect logs and crash dumps

```powershell
# JSON-formatted daemon logs (only if --log-format=json)
npx cowire daemon start --detach --log-format json
Get-Content $env:USERPROFILE\.cowire\daemon.pid

# watchdog log — newline-delimited JSON
Get-Content $env:USERPROFILE\.cowire\watchdog.log -Tail 20

# crash dumps (one per uncaught exception / unhandled rejection)
Get-ChildItem $env:USERPROFILE\.cowire\crash-*.json
```

`/healthz` is deep — it now returns 503 if the SQLite DB becomes unreachable or read-only, which is the signal the watchdog uses to trigger a restart:

```powershell
Invoke-RestMethod http://127.0.0.1:7777/healthz | ConvertTo-Json -Depth 4
```

```json
{
  "ok": true,
  "version": "0.1.0",
  "started_at": "2026-05-12T...",
  "uptime_sec": 1234,
  "db": { "reachable": true, "writable": true },
  "broker": { "connected_sessions": 2, "active_subscriptions": 3 },
  "decisions": { "open_count": 0, "responded_last_hour": 4 }
}
```

### Resilience troubleshooting

- **Watchdog says "registered" but not "running"** — the OS scheduler hasn't fired the trigger yet. On Windows, `schtasks /Run /TN CowireWatchdog`. On macOS/Linux, the agent is loaded but possibly errored out — check `~/.cowire/watchdog.log`.
- **Daemon restarts in a loop** — open `~/.cowire/crash-<latest>.json` and `~/.cowire/watchdog.log`. The crash dump includes the last 100 events; the watchdog log shows the restart cadence. The 60s cooldown means at most one restart per minute.
- **DB was rebuilt unexpectedly** — look for `cowire.db.corrupt.<ts>` next to `cowire.db`. That's the original file, quarantined by `EventStore.init` after `PRAGMA integrity_check` failed. The daemon also emits an `error` event with `attempted_recovery` describing the rename. See [ADR-021](./adr/021-graceful-degradation-vs-crash.md).
- **Shim reconnects "silently"** — every reconnect emits a `progress` event with body `shim_reconnected after Xms`. Query `cowire events --kind progress | findstr shim_reconnected` to inspect the history.

---

## stdio mode (legacy / per-spawn)

```bash
# both transports (default)
npx cowire start --port=7777

# stdio only (for embedding under CC)
npx cowire start --stdio-only
```

CLI:

| Command | Description |
|---|---|
| `cowire daemon start [--port=7777] [--db PATH] [--detach] [--force] [--log-format=text\|json]` | Start the long-running daemon. |
| `cowire daemon stop` | Send SIGTERM (fallback SIGKILL after 10s). |
| `cowire daemon status` | Print running state, port, uptime, client/event counts. |
| `cowire daemon restart` | Restart with previous port/db. |
| `cowire daemon install` | Register the watchdog with the OS scheduler (idempotent). |
| `cowire daemon uninstall` | Remove the watchdog from the OS scheduler. |
| `cowire daemon watchdog-status` | Show whether the watchdog is registered, running, last log lines, restart count. |
| `cowire connect-test [--url URL]` | Smoke test: connect via SSE, emit one event, print what came back. |
| `cowire shim [--url URL]` | Stdio↔SSE proxy — for MCP clients that don't accept `type: "sse"`. |
| `cowire start [--port=7777] [--stdio-only]` | Per-spawn stdio (+optional HTTP) — legacy / dev-only. |
| `cowire status` | DB stats and recent decisions. |
| `cowire events [--kind=K] [--since=ISO] [--limit=N]` | Query the event log. |

## Connect from CC (stdio)

Add Switch as a stdio MCP server in CC's `.mcp.json`:

```json
{
  "mcpServers": {
    "cowire": {
      "command": "npx",
      "args": ["cowire", "start", "--stdio-only"]
    }
  }
}
```

## Raw HTTP/SSE endpoints (daemon)

```
GET  http://127.0.0.1:7777/mcp/sse        # open SSE stream
POST http://127.0.0.1:7777/mcp/messages   # send messages back
GET  http://127.0.0.1:7777/healthz        # liveness
GET  http://127.0.0.1:7777/status         # live counts (sse_sessions, events, pending_decisions)
```

## Tools registered

| Tool | Purpose |
|---|---|
| `emit_event` | Fire-and-forget event publish (Pattern C). |
| `subscribe_to_events` | Register a session for notifications (Pattern B). |
| `unsubscribe` | Remove subscription. |
| `get_events` | Query historical events. |
| `await_decision` | Block until response (Pattern A). 30-min cap. |
| `respond_to_decision` | Resolve a pending decision. |
| `worker_list_types` | List registered worker types. |
| `worker_spawn` | Spawn a worker (cc / shell / …). |
| `worker_list` | List workers. |
| `worker_status` | One worker's state. |
| `worker_dispatch` | Send an instruction to a worker. |
| `worker_terminate` | Stop a worker. |
| `trust_scope_propose` | Propose a trust scope (auto-tier). |
| `trust_scope_grant` | Activate a proposed scope (gates on `await_decision`). |
| `trust_scope_revoke` | Revoke an active scope (auto-tier escape hatch). |
| `trust_scope_list` | List scopes with time/action remaining. |
| `trust_scope_status` | One scope's full state + action history. |
| `trust_scope_extend` | Extend a scope's deadline or cap (gates on `await_decision`). |

## Trust scopes (spec 46)

A **trust scope** is a typed, time-bounded, action-bounded permission grant.
While a scope is active, CONFIRM-tier actions matching its `allowed_actions`
auto-execute without per-call `await_decision`. Out-of-scope actions still
gate normally. NEVER-tier (ADR-018) is never overridable.

The lifecycle is: `trust_scope_propose` → `trust_scope_grant` (the ONE
approval) → covered tool calls auto-execute → reports stream at the configured
cadence → completion when the action cap is hit, time expires, or `trust_scope_revoke` fires.

Example scope:

```json
{
  "title": "Migrate BUGS.md to GitHub Issues",
  "description": "Create 10 issues from BUGS.md (B-001..B-010).",
  "allowed_actions": [
    { "tool": "github.create_issue", "param_constraints": { "repo": "Kstkoda/privacy-tracker" } },
    { "tool": "github.add_labels",   "param_constraints": { "repo": "Kstkoda/privacy-tracker" } }
  ],
  "expires_after_actions": 20,
  "reporting": { "cadence": "every-5-actions", "channels": ["chat", "event-log"] }
}
```

Param matching: exact value by default, regex if the value starts with `^`
(ADR-023). Multiple matchers OR together; `forbidden_actions` always veto.

See [`docs/writing-a-spec-with-trust-scope.md`](./docs/writing-a-spec-with-trust-scope.md)
for a worked example, and [ADR-022](./adr/022-trust-scopes-supersede-per-action-confirm.md),
[ADR-023](./adr/023-param-constraint-matching-syntax.md),
[ADR-024](./adr/024-reporting-cadences-and-channels.md) for the design.

## Workers (Spec 42 — event-driven orchestration)

Switch is also a generic orchestrator for spawnable workloads — Claude Code sessions, shell commands, and (in follow-ups) Unity Hub, Roblox Studio, Python scripts. Each worker type plugs in as a single file under `src/workers/<type>.ts` implementing the `WorkerSpawner` interface (see `src/workers/types.ts`). Two non-negotiable invariants:

1. **Event-driven, never polling.** Process exits use `child_process` `'exit'` events. Filesystem changes use `chokidar`. The only bounded one-shot timer is the per-worker idle marker (5 min), reset on every activity.
2. **Pluggable.** Adding a new worker type is one file in `src/workers/` plus one line in `src/workers/spawners-registry.ts`. No edits to `server.ts`, persistence, or future dashboard code.

v1 ships two spawners:

- **`cc`** — Claude Code sessions in dedicated `git worktree` directories (ADR-016). Each spawn creates `<repo>/.cowire-worktrees/<worker-name>` and opens a visible `cmd` window running `claude --mcp-config .cowire-mcp.json …`. Git state inside the worktree is observed via `chokidar` on `.git/HEAD`, `.git/refs/heads/<branch>`, `.git/index` — `worker_metadata_changed` events fire within ~50ms of any git operation.
- **`shell`** — `cmd` / `powershell` / `bash` commands. `interactive: false` pipes stdout+stderr through `readline`, emitting one `worker_progress` event per line. `interactive: true` opens a visible window the user can type into.

Six type-agnostic MCP tools:

| Tool | Tier | Purpose |
|---|---|---|
| `worker_list_types` | auto | Registry of available spawners + their param schemas. |
| `worker_spawn` | per-spawner (default confirm) | Spawn a worker of any registered type. |
| `worker_list` | auto | List workers, filter by type/status. |
| `worker_status` | auto | Full state of one worker by id or name. |
| `worker_dispatch` | per-spawner | Deliver an instruction (errors if the spawner doesn't support dispatch). |
| `worker_terminate` | confirm | Stop a worker, force-killable. |

Adding a new worker type: see [`docs/writing-a-worker.md`](./docs/writing-a-worker.md).

## GitHub adapter

Switch exposes **14 read-only tools + 10 write tools** backed by the `gh` CLI on the host machine. Requires `gh auth login` to have been run; the tools inherit the authenticated user's permissions.

### Read-only (always safe)

`github.read_pr`, `github.list_prs`, `github.read_issue`, `github.list_issues`, `github.read_commit`, `github.list_commits`, `github.read_file`, `github.list_workflow_runs`, `github.read_workflow_run`, `github.read_pr_diff`, `github.list_pr_files`, `github.read_pr_review_comments`, `github.list_labels`, `github.list_branches`.

### Write actions (gated by `await_decision`)

Every write call opens a `decision_request` first. A human approves via Cowork (or any other MCP client that calls `respond_to_decision`); the underlying `gh` invocation only runs on approve. On reject or timeout the tool returns `{ ok: false, reason: 'rejected_by_user' }` and emits no success event. See [ADR-008](./adr/008-write-actions-await-decision.md).

| Tool | Tier | What it does |
|---|---|---|
| `github.create_pr` | confirm | Open a PR (`--head` → `--base`, body via stdin, optional `--draft`). |
| `github.merge_pr` | confirm | Squash-merge + delete branch. |
| `github.create_issue` | confirm | Open an issue with optional labels. |
| `github.create_issue_comment` | confirm | Post a comment on an issue. |
| `github.create_pr_comment` | confirm | Post a comment on a PR. |
| `github.close_issue` | confirm | Close an issue (optional closing comment). |
| `github.reopen_issue` | confirm | Reopen a closed issue. |
| `github.add_labels` | confirm | Add labels to an issue or PR. |
| `github.remove_labels` | confirm | Remove labels from an issue or PR. |
| `github.request_pr_review` | confirm | Request review from one or more reviewers. |

What is **NEVER tier** and stays manual: force-push, branch delete, `merge_pr --force`, repo-settings changes. See [ADR-018](./adr/018-destructive-operations-stay-manual.md).

## Event taxonomy

See [`docs/event-taxonomy.md`](./docs/event-taxonomy.md) for the full
human-readable contract (envelope, every `EventKind`, payload shape, typical
subscribers, the stream-json sub-taxonomy for CC workers, and the reserved
`worker_stuck` kind from spec 47). The Zod source of truth lives in
[`src/event-types.ts`](./src/event-types.ts).

## Machine-readable contracts

Every Cowire MCP tool is self-describing:

- [`docs/tool-catalogue.json`](./docs/tool-catalogue.json) — machine-readable
  index of every registered tool with tier, category, since, stability,
  JSON Schema for input + output, side effects, error modes, and `see_also`
  links. Generated; do not hand-edit.
- [`docs/tool-cards/`](./docs/tool-cards/) — one markdown card per tool
  (e.g. [`await_decision.md`](./docs/tool-cards/await_decision.md),
  [`github_create_pr.md`](./docs/tool-cards/github_create_pr.md),
  [`worker_spawn.md`](./docs/tool-cards/worker_spawn.md)). Generated; do not
  hand-edit.
- [`docs/event-taxonomy.md`](./docs/event-taxonomy.md) — the event contract
  Switch emits and Co/CC subscribe to.

Source of truth: [`src/tools/catalogue-data.ts`](./src/tools/catalogue-data.ts).
Regenerate everything with:

```bash
npm run docs:tools
```

**Sync invariant:** `npm run docs:tools` must produce no git diff against a
clean checkout. CI enforces it via
[`tests/tool-catalogue.test.ts`](./tests/tool-catalogue.test.ts), which asserts
the catalogue parses, references real registered tools, and is reproducible
from the script. When adding or modifying a tool, edit `catalogue-data.ts`
and re-run the generator — never hand-edit the generated files.

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components (broker, event store, transports, adapters, decisions), the decision-flow walkthrough, and how the pieces fit together.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — repo layout, dev setup, testing philosophy, code style, commit conventions.
- [`adr/README.md`](./adr/README.md) — index of architecture decision records (the "why" behind structural choices).
- [`docs/writing-an-adapter.md`](./docs/writing-an-adapter.md) — end-to-end guide for adding a new adapter, with a runnable [`examples/weather/`](./examples/weather/) reference adapter.

## Tests

```bash
npm test
```

Run the full local gate (the same checks CI runs):

```bash
npm run check
```

## CI

GitHub Actions runs `tsc --noEmit` + `vitest run` + `npm run build` on every push to `main` and every PR. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

Recommended branch protection: require the **Build and test** check on `main`. Configure via Settings → Branches → Add rule (require status checks to pass, require branches to be up to date before merging, disallow force-push and deletion).

## License

TBD — keeping mainstream-deps so this could be opened later.
