# Cowire

**Cowire** is an MCP-native broker that sits between cooperating agents (Co, CC) and user channels. The broker process is called **Switch** — an MCP server that holds the event queue and decision state. Co and CC connect to Switch as MCP clients; future agents plug in by speaking MCP.

This repo is the reference implementation of Switch.

## Status

Phase A + B (MVP):
- Event emission, subscription, replay
- `await_decision` / `respond_to_decision` with timeout fallback
- Persistence in SQLite (`~/.cowire/cowire.db`)
- Two transports on one process: stdio (for CC) and HTTP/SSE (for Cowork dashboards, webhook receivers)

See `..\privacy tracker\specs\37_cowork-cc-event-bridge.md` for the architecture.

## Install

```bash
npm install
npm run build
```

## Run Switch

```bash
# both transports (default)
npx cowire start --port=7777

# stdio only (for embedding under CC)
npx cowire start --stdio-only
```

CLI:

| Command | Description |
|---|---|
| `cowire start [--port=7777] [--stdio-only]` | Start Switch. |
| `cowire status` | Print DB stats and recent decisions. |
| `cowire events [--kind=K] [--since=ISO] [--limit=N]` | Query the event log. |

## Connect from CC

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

## Connect from Cowork (HTTP/SSE)

```
GET  http://localhost:7777/mcp/sse        # open SSE stream
POST http://localhost:7777/mcp/messages   # send messages back
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
