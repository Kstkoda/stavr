# Cowire

**A local-first orchestrator for AI agent work. Plans you can review, models routed by cost, anything pluggable as a connector — running on your machine, not someone else's.**

Cowire is a small daemon that runs on your machine and sits between any AI assistant (Claude Code, Cowork chat, future tools) and the systems on your computer it's allowed to touch — your code, your shell, your GitHub, your files, your home automation, anything you wire in. It takes a goal, produces a reviewable plan, routes each step to the right model under your cost budget, and runs the plan end-to-end while you do something else.

Four things you get that cloud-hosted agent platforms don't:

- **Plans you can read like a food label.** Cowire's planner turns a goal into a structured Bill of Materials — numbered steps, each tagged with what kind of thinking it needs, which model handles it, and what it costs. You approve the whole plan with one click. The system runs to completion including retries and re-plans; it only interrupts you for explicitly destructive actions you've ear-marked.
- **Local AI is a first-class peer.** Per-step routing is multi-model by design. Llama on your machine handles cheap classifications. Claude or GPT handles hard reasoning. You pick the mix per profile — Turbo for quality, Balanced for the middle, Eco for "local first, no paid spend without my nod." Cost stays under a daily cap regardless.
- **Anything is a connector.** MCP servers, REST APIs, OAuth services, LAN-only controllers (Unifi), home automation (Wiser, Hue), game platforms (Roblox, Unity), webhooks, cron, SMTP — they all become orange bricks in the toolkit, each with its own config form. The interface is open; anyone can add a new one.
- **Many agents, one mission control.** Spawn parallel Claude Code workers, each in an isolated git worktree on its own branch. Watch them all in a single live dashboard at `http://127.0.0.1:7777/dashboard`. Stop, steer, or tail any of them from one place.

Cowire binds to `127.0.0.1` only. No cloud, no telemetry, no third-party server. Your data, your machine, your audit log. The architecture is fully described in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the [`adr/`](adr/) decision records.

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

The client now sees Cowire's tools: `worker_spawn`, `propose_plan`, `trust_scope_propose`, `github_create_pr`, the full set listed in [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

## Installation (until v0.1.0 hits npm)

```sh
git clone https://github.com/Kstkoda/cowire
cd cowire
npm install
npm run build
node dist/cli.js daemon start
```

Node 20+ required. Developed and tested on Windows, macOS, and Linux equally.

## What's in v0.1

Currently shipping:

- **Daemon + broker + append-only event log** (SQLite WAL, single file at `~/.cowire/cowire.db`).
- **Trust scopes** — pre-approved bundles of actions with time and action-count caps. Spec 46. Lives in `src/trust/`. *Under the hood; not the headline.*
- **Worker orchestration via git worktrees.** Each spawned Claude Code worker gets its own branch, its own working tree, its own MCP session. Parallel workers in the same repo never collide.
- **GitHub write adapters** — `github_create_pr`, `github_merge_pr`, `github_create_issue`, `github_add_labels`, and the rest. Gated by tier-and-scope. See [`docs/tool-cards/`](docs/tool-cards/).
- **Audit dashboard** at `http://127.0.0.1:7777/dashboard` — live event tail, worker drill-in, inline decision approval, JSON/CSV export.
- **`cowire tail` CLI** for terminal-pane live monitoring with filter chips for kind, worker, source-agent. Color-coded, exponential-backoff reconnect.
- **Stuck-worker watchdog** — daemon emits `worker_stuck` events when a worker goes silent past a configurable threshold.
- **Machine-readable contracts** — JSON Schemas for every tool, an event taxonomy doc at [`docs/event-taxonomy.md`](docs/event-taxonomy.md), and a regenerable tool catalogue at [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

## What's coming in v0.2

Active development. See [`proposed/`](proposed/) for the design artifacts:

- **BOM planning loop** — the steward proposes a structured plan; you review it; it runs end-to-end. Replaces the current "every action is its own decision" pattern for multi-step work. [`proposed/steward-planner.ts`](proposed/steward-planner.ts), [`proposed/001_bom_schema.sql`](proposed/001_bom_schema.sql).
- **Connector adapter interface** — uniform interface for wrapping any external service as an orange brick. Wiser, Unifi, Roblox, Unity, webhooks, custom scripts — all the same shape. [`proposed/connector.ts`](proposed/connector.ts).
- **Profile modes** — Turbo / Balanced / Eco. Per-capability model preference lists, daily budget caps, failure policies. Balanced is the boot default. [`proposed/types.ts`](proposed/types.ts).
- **Risk class taxonomy** — orthogonal-to-action-class abstraction for the no-go list and trust scopes. Eight classes covering read-only through destructive. [`proposed/types.ts`](proposed/types.ts).
- **SSE stability fix** — heartbeat plus disabled body-timeout on the shim side. Kills the 5-minute reconnect cycle. [`proposed/sse-heartbeat-fix.md`](proposed/sse-heartbeat-fix.md).
- **Visual toolkit page** — DUPLO-style canvas showing the cowire bus with external services above and local capabilities below, each brick clickable to configure. Mock-up in `proposed/`; implementation follows the backend.

Land order, scope, and open questions in [`proposed/README.md`](proposed/README.md).

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the topology and component map, and the [`adr/`](adr/) directory for the architecture decision records that explain *why* each major choice was made.

The four-role design (User → Operator → Workers → Daemon) and the five-layer approval pipeline (tier → trust scope → user decision → no-go list → execution + audit) are documented in [`docs/release-notes-v0.1.0.md`](docs/release-notes-v0.1.0.md). The pipeline is plumbing — the headline is what cowire lets you *do*, not how it stays safe.

## Prior art

Cowire's trust-scope-plus-audit substrate is structurally similar to [Tessera Protocol](https://tessera-protocol.github.io/tessera/), which shipped a runtime authority guard first. The two systems converge on the same primitive because rejecting ambient authority pushes any thoughtful design to the same shape. Cowire is a broader orchestration system that happens to use that shape underneath; Tessera is a focused authority layer. Different products, overlapping substrate.

If you're looking specifically for "scoped, revocable permissions for AI agent actions enforced at runtime" with no opinions about planning, routing, or connectors — Tessera is the right place.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for repo layout, development setup, testing philosophy, and the patterns for adding new event kinds, tool adapters, and worker spawners. PRs welcome.

## Security

If you find a security issue, please email **stenlund@gmail.com** rather than opening a public issue. Details in [`SECURITY.md`](SECURITY.md).

## License

Cowire is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
