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
