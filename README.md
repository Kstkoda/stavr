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

If a given MCP client does not yet accept `type: "sse"` entries, run Cowire in stdio mode (`cowire start --stdio-only`) per session as a fallback while a stdio→SSE shim is developed.

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
| `cowire daemon start [--port=7777] [--db PATH] [--detach] [--force]` | Start the long-running daemon. |
| `cowire daemon stop` | Send SIGTERM (fallback SIGKILL after 10s). |
| `cowire daemon status` | Print running state, port, uptime, client/event counts. |
| `cowire daemon restart` | Restart with previous port/db. |
| `cowire connect-test [--url URL]` | Smoke test: connect via SSE, emit one event, print what came back. |
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

## GitHub adapter (read-only)

Switch exposes 14 read-only GitHub tools backed by the `gh` CLI on the host machine. Requires `gh auth login` to have been run; the tools inherit the authenticated user's permissions.

Available tools: `github.read_pr`, `github.list_prs`, `github.read_issue`, `github.list_issues`, `github.read_commit`, `github.list_commits`, `github.read_file`, `github.list_workflow_runs`, `github.read_workflow_run`, `github.read_pr_diff`, `github.list_pr_files`, `github.read_pr_review_comments`, `github.list_labels`, `github.list_branches`.

Write actions (comment, create issue, etc.) are not yet exposed. See spec 39 Phase B.

## Event taxonomy

See `src/event-types.ts`. Mirrors spec 37 §"Event taxonomy".

## Tests

```bash
npm test
```

## License

TBD — keeping mainstream-deps so this could be opened later.
