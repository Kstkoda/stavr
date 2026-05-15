<p align="center">
  <img src="memory/stavr-header-wordmark.svg" alt="stavR" width="540" />
</p>

# stavR

**Local-first agent broker.** Plans the work, dispatches it across MCP connectors, routes it to the right model under your cost budget, and ships it on your machine.

`LOCAL-FIRST · MCP-NATIVE · YOUR MACHINE`

---

stavR is a small daemon that runs on `127.0.0.1:7777` and sits between any AI assistant (Claude Code, Cowork, future MCP clients) and the systems it's allowed to touch — your code, your shell, your GitHub. The product is a planner-plus-dispatcher: you describe an outcome, stavR produces a structured plan, you approve it once, and the daemon executes end-to-end across one or more workers.

## What stavR actually does

**1. BOM-driven planning.** Describe an outcome. stavR produces a **Bill of Materials** — a structured plan listing every tool call, model invocation, and side-effect required to ship it. You approve the BOM once. Execution runs end-to-end including retries and fixes, with no further prompts. The BOM is the noun the rest of the system is built around.

**2. Worker dispatch.** stavR spawns Claude Code workers in isolated git worktrees — sequential or parallel, opus or sonnet, with per-worker budgets. Each worker has its own branch, its own MCP session, and reports through an event broker the Steward is watching.

**3. Cost routing.** Three profile modes — **Turbo** (Opus everywhere), **Balanced** (Sonnet with Opus on hard steps, default), **Eco** (Haiku/Sonnet, fail-fast). The same BOM costs differently per profile; budgets are enforced before the spend, not after.

**4. MCP-native connector surface.** Every external system — GitHub, scheduling, search, your own services — is a registered MCP connector. stavR is the only thing your AI talks to; stavR is the thing that talks to the world. Bricks are pluggable adapters loaded from disk via a manifest.

**5. Local-first dashboard.** An eight-page operations dashboard at `http://127.0.0.1:7777/dashboard` — Home, Topology, Streams, Plans, Decide, Toolkit, Capabilities, Settings. Your data, your event log, your hardware. Binds to `127.0.0.1` only. No cloud, no telemetry, no third-party server.

## The plumbing (architecture, not the headline)

Under the planner sits a scope primitive: **trust scopes** are time-boxed, action-capped permission envelopes ("for the next hour, you may merge PRs in `Kstkoda/stavr` up to 10 times"). Anything outside a scope prompts; anything on the **no-go list** prompts regardless of scope. Approving a BOM creates the scope that runs it.

This authority layer is plumbing, not the product. It is conceptually compatible with the [Tessera Protocol](https://github.com/tessera-protocol/tessera), which defines a capability-based authority layer for AI agents; if Tessera's wire format becomes the standard, stavR will adopt it as the serialization for its scopes. See [`NOTICE`](NOTICE) and the *Affiliations and prior art* section below.

Architecture details live in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the [`adr/`](adr/) decision records.

---

## Quick start

```sh
git clone https://github.com/Kstkoda/stavr
cd stavr
npm install
npm run build
npm start
```

The daemon binds `127.0.0.1:7777`. Confirm it's up and watch events:

```sh
node dist/cli.js daemon status
node dist/cli.js tail
```

Point any MCP-aware client at the daemon by adding this to its `.mcp.json` (or equivalent):

```json
{
  "mcpServers": {
    "stavr": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

Transport is **Streamable HTTP** (MCP spec 2025-06-18+) — a single `/mcp` endpoint handling POST/GET/DELETE with a session-id header. The legacy SSE endpoints (`/mcp/sse` + `/mcp/messages`) were retired in v0.2.

The client now sees stavR's MCP tools: `worker_spawn`, `trust_scope_propose`, `github_create_pr`, `github_merge_pr`, and the full set listed in [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

Node 20+ required. Developed and tested on Windows, macOS, and Linux. Persistence is a single SQLite file at `~/.stavr/runestone.db`.

## What's shipped

**v0.1.0** — released. Daemon, broker, append-only event log, trust scopes, worker orchestration via git worktrees, GitHub write adapters, `tail` CLI, stuck-worker watchdog, machine-readable contracts for every tool. JSON Schemas, an event taxonomy at [`docs/event-taxonomy.md`](docs/event-taxonomy.md), and a regenerable tool catalogue at [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

**v0.2 audit fixes** — on `main`, unreleased. Streamable HTTP migration (replaced legacy SSE), `trust_scope_granted` event emission, Windows 8.3 path handling for the brick installer, undici Agent for outbound HTTP.

**v0.3 dashboard** — on `main`, unreleased. The eight-page operations dashboard: Home (daemon health + active BOMs + recent decisions), Topology (SVG ops control center with time scrubber), Streams (multi-pane terminal view), Plans (food-label approval cards), Decide (decision cards with countdown), Toolkit (ESB bus + brick editor), Capabilities (Lego baseplate per profile mode), Settings (profile / scopes / no-go / bricks). See [`docs/dashboard.md`](docs/dashboard.md).

**v0.4 scheduler** — proposed at [`proposed/v0.4-scheduler-bom.md`](proposed/v0.4-scheduler-bom.md). Promotes the Steward from reactive (subscribes to events) to scheduler with backlog, priority, capacity, and dedupe. ~10-14 hours of autonomous execution.

## CLI

```sh
node dist/cli.js daemon start      # start the daemon
node dist/cli.js daemon status     # check health
node dist/cli.js daemon stop       # shut it down
node dist/cli.js tail              # live event stream with filter chips
node dist/cli.js config show       # current configuration
node dist/cli.js status            # daemon + recent events summary
node dist/cli.js events            # query the event log
node dist/cli.js pair bootstrap    # pair a remote device (spec 52)
node dist/cli.js devices list      # paired devices
```

The full command surface lives in [`src/cli.ts`](src/cli.ts). Once `stavr` is published to npm, the prefix `node dist/cli.js` collapses to `stavr`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for repo layout, development setup, testing philosophy, and the patterns for adding new event kinds, tool adapters, and worker spawners. Contributions require [DCO sign-off](https://developercertificate.org/) — commit with `git commit -s`. PRs welcome.

## Security

If you find a security issue, please email **stenlund@gmail.com** rather than opening a public issue. Details in [`SECURITY.md`](SECURITY.md).

## License

stavR is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Affiliations and prior art

stavR is an independent personal project. It is **not affiliated with, endorsed by, or sponsored by** Anthropic, the LEGO Group, the STAVR Team blockchain validator operation at [stavr.tech](https://stavr.tech), the [Tessera Protocol](https://github.com/tessera-protocol/tessera) project, Ubiquiti / Unifi, FlightRadar24, or any other entity sharing similar names or operating in adjacent domains.

The **trust-scope primitive** in stavR was developed independently and shares conceptual ground with the Apache-2.0 [Tessera Protocol](https://github.com/tessera-protocol/tessera), which describes a capability-based authority layer for AI agents. stavR's positioning is broader (BOM-driven planning, MCP connector surface, cost routing, worker dispatch); trust scopes are one primitive among many. If Tessera's wire format becomes a standard, stavR will adopt it as the serialization for its scopes — overlap, not competition. See [`NOTICE`](NOTICE) for the full prior-art and design-influence acknowledgments.

The name **"stavR"** is a mixed-case rendering of the Old Swedish/Old Norse *stafr* (staff or rune-stave) — the final capital R reflecting the Younger Futhark transliteration convention for the ᛦ rune. Used here for its evocative meaning, not as a claim of exclusive use. The icon glyph is the ᚱ Raido rune; the [brand assets](memory/) live in `memory/stavr-*.svg`.
