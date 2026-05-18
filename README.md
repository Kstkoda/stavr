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

**5. Local-first dashboard.** An eleven-page operations dashboard at `http://127.0.0.1:7777/dashboard` — **Helm**, Topology, Streams, Plans, Decide, Toolkit, **MCPs**, **Tools**, Capabilities, **Diagnostics**, Settings. Your data, your event log, your hardware. Binds to `127.0.0.1` only. No cloud, no telemetry, no third-party server.

**6. Out-of-band notifications.** Optional notification fabric — ntfy.sh, SMTP email, Telegram — pulls the operator's attention when the daemon needs a decision. Replies (button taps from phone/watch) record the same audit events as dashboard clicks: out-of-band consent is consent. HMAC-signed, one-shot, 5-minute TTL. See [`docs/notifications.md`](docs/notifications.md) for the setup guide.

**7. Tray supervisor.** The **Governor** is a small Rust + Tauri 2 sidecar (`governor/`) that runs in the system tray. It polls `/healthz`, drives `pm2 start` with exponential backoff when the daemon falls over, surfaces state via the Raido-rune tray icon + tooltip, and gives the operator a Pause/Resume/Reset & Restart menu. Releases are Sigstore-signed via GitHub Actions OIDC (see [`docs/governor-install.md`](docs/governor-install.md)).

## Architecture (three processes)

Per [ADR-040](adr/040-three-process-architecture.md):

- **Engine** = the stavR daemon. Transports, broker, event store, audit. The smallest possible thing; sole source of truth for the event log. Binds `127.0.0.1:7777`.
- **Steward** = subprocess (`stavr-steward-agent` in PM2). Planning + Model Runtime abstraction. Talks to engine via MCP. Three-layer state (working memory / lessons / prefs).
- **Governor** = Tauri 2 tray binary (Rust). Daemon supervision + state-driven icon + Pause/Resume/Restart menu. PM2 stays as the actual process manager; Governor is detection + narrow-window auto-recovery.

## Authority model (five layers)

In increasing operator authority:

1. **Trust scopes** — time-boxed, action-capped permission envelopes ("for the next hour, you may merge PRs in `Kstkoda/stavr` up to 10 times"). Approving a BOM creates the scope that runs it.
2. **Per-actor permission tier** — AUTO / CONFIRM / EXPLICIT / NO_GO per (actor, tool). Matrix at `/dashboard/permissions`.
3. **Layer 0 capability master switch** — operator-runtime per-tool hard gate. Disabled = no actor can call regardless of scope or tier.
4. **No-go list** — source-code allowlist exclusions (e.g. `rm -rf`, destructive admin verbs).
5. **Lex Insculpta** — source-code-only invariants. Operator-sovereign; only changeable via PR.

The trust-scope primitive is conceptually compatible with the [Tessera Protocol](https://github.com/tessera-protocol/tessera), which defines a capability-based authority layer for AI agents; if Tessera's wire format becomes the standard, stavR will adopt it as the serialization for its scopes. See [`NOTICE`](NOTICE) and the *Affiliations and prior art* section below.

Full architecture details live in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the [`adr/`](adr/) decision records.

---

## Quick start

```sh
git clone https://github.com/Kstkoda/stavr
cd stavr
npm install
npm run build
```

Run under PM2 (recommended — restart policy, log rotation, env var capture):

```sh
pm2 start ecosystem.config.cjs
pm2 logs stavr --lines 30
pm2 status
```

Or run the daemon directly (no supervisor):

```sh
node dist/cli.js daemon start
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

The client now sees stavR's MCP tools — browse the full catalog at `/dashboard/tools` or in [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

Node 20+ required. Developed and tested on Windows, macOS, and Linux. Persistence is a single SQLite file at `~/.stavr/runestone.db`.

## What's shipped

**v0.1.0** — released. Daemon, broker, append-only event log, trust scopes, worker orchestration via git worktrees, GitHub write adapters, `tail` CLI, stuck-worker watchdog, machine-readable contracts for every tool. JSON Schemas, an event taxonomy at [`docs/event-taxonomy.md`](docs/event-taxonomy.md), and a regenerable tool catalogue at [`docs/tool-catalogue.json`](docs/tool-catalogue.json).

**v0.2 audit fixes** — on `main`. Streamable HTTP migration (replaced legacy SSE), `trust_scope_granted` event emission, Windows 8.3 path handling for the brick installer, undici Agent for outbound HTTP.

**v0.3 dashboard** — on `main`. Eleven-page operations dashboard: **Helm** (daemon health + 5-tier band layout), Topology (SVG ops control center with time scrubber), Streams (multi-pane terminal view), Plans (food-label approval cards), Decide (decision cards with countdown), Toolkit (ESB bus + brick editor), **MCPs** (registered connector list), **Tools** (full tool catalog with category + tier), Capabilities (Lego baseplate per profile mode), **Diagnostics** (engine room), Settings. See [`docs/dashboard.md`](docs/dashboard.md).

**v0.4 scheduler** — on `main`. Steward promoted from reactive (subscribes to events) to scheduled-and-proactive with backlog, priority, capacity, and dedupe.

**v0.5 Steward portability** — on `main` (PR #31). Subprocess Steward (ADR-032) with three-layer state stores (working memory / lessons / prefs) and Model Runtime abstraction (Anthropic / Ollama / Claude Code). Autonomy levels: reactive / scheduled / proactive.

**v0.6 notifications fabric** — on `main` (PR #32, PR #33). Bidirectional notifications — ntfy.sh + SMTP + Telegram. Outbound from daemon, inbound replies via inline buttons. HMAC-signed correlation_ids, 5-min TTL, audit-logged. Daily digest. Dashboard channel-status panel.

**v0.6.5 Governor MVP** — on `main` (PR #34). Tauri 2 tray companion that supervises the daemon. State machine (Healthy / Degraded / Down / Restarting / GiveUp), iron-palette Raido tray icon with state-driven variants, orphan-Node cleanup before `pm2 start`, settle window for cold-boot, Reset & Restart menu item.

**v0.6.5.1 release signing** — on `main` (PR #35). Sigstore keyless signing of Governor binaries via GitHub Actions OIDC → Fulcio → Rekor. CycloneDX SBOM per platform. `cosign verify-blob` operator-side helpers. See [`docs/governor-install.md`](docs/governor-install.md).

**v0.6.6 worker-status fidelity** — on `main` (PR #36). Single-source counters + roster fetchers across Helm / Topology / Streams / Diagnostics. `lifecycle_state` derived classification (8 states). Force-killed workers visually distinct from cleanly-completed ones.

**v0.6.9 PR #1 tool catalog** — on `main` (PR #37). Central daemon-scoped registry of every MCP tool with category + default tier + reversibility + description. New `/dashboard/tools` browse page.

**v0.6-baseline (in flight)** — PR [#41](https://github.com/Kstkoda/stavr/pull/41) bundles the rest of the v0.6 chain:
- Layer 0 capability master switch + per-actor permissions matrix + `/dashboard/permissions` page
- Telegram operator directives (`/steward` + `/scope` + `/status` + `/ask` commands routing into Steward)
- Worker spawn hygiene (script-file pattern + Ed25519 signing + AV-block detection)
- 10-section diagnostics engine room (Section 0 — Build & Versions panel)
- Named policies + YAML import/export + `stavr permissions` CLI + Topology side-drawer
- Governor PR #2: SSE multiplexer + native OS toast + Pause/Resume/Restart tray menu + autostart on login

**v0.7 Workers Console** — proposed at [`proposed/v0_7-workers-console-bom.md`](proposed/v0_7-workers-console-bom.md). Streams page renamed to Workers + command injection + Steward Q&A. Ships after v0.6-baseline lands.

## CLI

```sh
node dist/cli.js daemon start
node dist/cli.js daemon status
node dist/cli.js daemon stop
node dist/cli.js tail
node dist/cli.js config show
node dist/cli.js status
node dist/cli.js events
node dist/cli.js pair bootstrap
node dist/cli.js devices list
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
