# Cowire

**The trust layer for AI agents — local-first, audit-first, single operator.**

Cowire is a small daemon that runs on your machine and sits between any AI assistant (Claude Code, Cowork chat, future tools) and the systems on your computer it's allowed to touch — your code, your shell, your GitHub. It gives you three things you do not get from cloud-hosted agent platforms:

- **One human approves the plan, not every action.** Pre-grant a time-bounded, action-capped scope ("for the next hour, you may merge PRs in `Kstkoda/cowire` up to 10 times"), and the AI runs without asking again. Anything outside the scope still prompts. Anything on the no-go list always prompts, regardless of scope.
- **Every action lives in an audit log you own.** Append-only SQLite database on your disk. Replayable, exportable, queryable, never leaves your machine. If you ever need to answer "what did the AI do at 3 p.m. on Tuesday?", the answer is one query away.
- **Many agents, one mission control.** Spawn parallel Claude Code workers, each in an isolated git worktree on its own branch. Watch them all in a single live dashboard at `http://127.0.0.1:7777/dashboard`. Stop or steer any of them from one place.

Cowire binds to `127.0.0.1` only. No cloud, no telemetry, no third-party server. The architecture is fully described in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the [`adr/`](adr/) decision records.

---

## Quick start

```sh
# Install (once published to npm — see Installation below until then)
npm install -g cowire

# Start the daemon (binds 127.0.0.1:7777)
cowire daemon start

# Confirm it's running
cowire daemon status

# Watch events live in another terminal
cowire tail
```

Then point any MCP-aware client at the daemon by adding this to its `.mcp.json` (or equivalent):

```json
{
  "mcpServers": {
    "cowire": {
      "type": "sse",
      "url": "http://127.0.0.1:7777/mcp/sse"
    }
  }
}
```

The client now sees Cowire's tools: `worker_spawn`, `trust_scope_propose`, `github_create_pr`, `github_merge_pr`, the full set listed in [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

## Installation (until v0.1.0 hits npm)

```sh
git clone https://github.com/Kstkoda/cowire
cd cowire
npm install
npm run build
node dist/cli.js daemon start
```

Node 20+ required. Currently developed and tested on Windows, macOS, and Linux equally.

## What's in v0.1

- **Daemon + broker + append-only event log** (SQLite WAL, single file at `~/.cowire/cowire.db`).
- **Trust scopes** — pre-approved bundles of actions with time and action-count caps. The pattern is in spec 46 (in the parent project's `specs/` directory) and lives in `src/trust/`.
- **Worker orchestration via git worktrees.** Each spawned Claude Code worker gets its own branch, its own working tree, its own MCP session. Parallel workers in the same repo never collide.
- **GitHub write adapters** — `github_create_pr`, `github_merge_pr`, `github_create_issue`, `github_add_labels`, and the rest. Gated by tier-and-scope. See [`docs/tool-cards/`](docs/tool-cards/).
- **Audit dashboard** at `http://127.0.0.1:7777/dashboard` — live event tail, worker drill-in, inline decision approval, JSON/CSV export.
- **`cowire tail` CLI** for terminal-pane live monitoring with filter chips for kind, worker, source-agent. Color-coded, exponential-backoff reconnect.
- **Stuck-worker watchdog** — daemon emits `worker_stuck` events when a worker goes silent past a configurable threshold.
- **Machine-readable contracts** — JSON Schemas for every tool, an event taxonomy doc at [`docs/event-taxonomy.md`](docs/event-taxonomy.md), and a regenerable tool catalogue at [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the topology and component map, and the [`adr/`](adr/) directory for the architecture decision records that explain *why* each major choice was made.

The four-role design (User → Operator → Workers → Daemon) and the five-layer approval pipeline (tier → trust scope → user decision → no-go list → execution + audit) are documented in [`docs/release-notes-v0.1.0.md`](docs/release-notes-v0.1.0.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for repo layout, development setup, testing philosophy, and the patterns for adding new event kinds, tool adapters, and worker spawners. We welcome PRs.

## Security

If you find a security issue, please email **stenlund@gmail.com** rather than opening a public issue. Details in [`SECURITY.md`](SECURITY.md).

## License

Cowire is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
