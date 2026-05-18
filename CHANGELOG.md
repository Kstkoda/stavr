# Changelog

stavR ships incrementally — small, reviewable PRs that each pass `npm test` and `npm run build` independently. Release notes for major surface changes live in `docs/release-notes-v0.*.md`; this file is the project-level timeline.

## v0.6.6 — Worker status fidelity (in progress)

**Helm + Topology + Streams + Diagnostics stop lying about worker state.** Closes audit findings #1, #2, #3, #5, #7, #8, #11, #22 from the 2026-05-17 capture. The dashboard's biggest live lie ("6 active workers" while 0 were actually running, the 2026-05-17 E2E session) becomes structurally impossible because all four pages now read from a single source.

### Added

- **lifecycle_state derived classification** — 8 states (`starting` / `running` / `completed-clean` / `completed-error` / `killed-by-operator` / `killed-by-system` / `crashed` / `stale`) replace the old `status` enum's mixed semantics. Force-killed workers render visually distinct from cleanly-completed ones (BOM hard rule #6). `src/workers/lifecycle.ts` + additive `lifecycle_state TEXT` column on `workers` table.
- **Single-source counters + roster fetchers** — `src/dashboard/data/worker-counters.ts` (active / completed_clean / completed_error / killed_by_operator / killed_by_system / crashed / stale / total) and `worker-roster.ts` (active / historic / stale buckets) are the only places any page reads worker counts from now.
- **Per-page rendering** — Helm L2 chips filter to currently-active; level-desc summary reads "0 active · 7 completed · 1 crashed · 2 stale" style (BOM hard rule #5). Topology header reads "N active · M lifetime" when those diverge; canvas hides historic workers older than 24h with a "Show terminated (N)" toggle. Streams primary grid shows only active panes; historic collapses into a `<details>` block. Diagnostics Workers section reads from the same fetcher; each row's trailing column shows the lifecycle label.

### Out of scope (separate BOMs)

- AV-block detection + `killed-by-system` heuristic — v0.6.7 (Spawn hygiene)
- `worker_terminate` reason field — deferred (BOM open question §4)
- Streams page rename to "Workers" — bigger product question, ADR conversation pending

---

## v0.6.5.1 — Governor signing pipeline (in progress)

**Verifiable Governor binaries.** Closes ADR-038 §1+§2 for the Governor binary so Windows 11 Smart App Control (SAC) and macOS Gatekeeper will run a downloaded release without disabling OS-level safety. Driven by the 2026-05-17 ~21:00 incident where SAC killed the freshly-built MVP binary.

### Added

- **Sigstore keyless release workflow** — `.github/workflows/governor-release.yml` triggers on narrow `v0.6.5*` tag push. Builds per-target (win x86_64/aarch64, macos x86_64/aarch64, linux x86_64), signs the binary AND SBOM via `cosign sign-blob --yes` using GitHub Actions OIDC → Fulcio → Rekor. Pinned `sigstore/cosign-installer@v3` + `cosign-release: v2.4.1` so the signing infra itself doesn't float.
- **CycloneDX SBOM per platform target** — `cargo cyclonedx --format json` pinned to `cargo-cyclonedx 0.5.7`, shipped as `stavr-governor.sbom.cdx.json` alongside the binary. Required on every release (no opt-in path, per BOM open question §4).
- **Operator-side verify helpers** — `governor/scripts/verify-release.{ps1,sh}` wrap `cosign verify-blob` with the stavR identity regexp + GitHub Actions OIDC issuer.
- **Local-dev self-signing** — `governor/scripts/dev-sign.{ps1,sh}` for the operator's `cargo build --release` loop. Windows: self-signed cert in `CurrentUser\My` + SignTool + RFC 3161 timestamp. macOS: Developer ID if available, else ad-hoc. Linux: detached GPG. Trusted Root install is opt-in AND prompts (per BOM open question §3 — never silent).
- **Verify-then-trust installer** — `governor/scripts/install-from-release.{ps1,sh}` downloads release artifacts, cross-checks SHA256, runs verify-release, only then considers the binary installed.
- **Docs** — `docs/governor-install.md` (operator install guide) + `docs/governor-local-dev.md` (dev-build signing workflow).
- **Tests** — 40 new shape tests across `tests/release/` (signing-smoke, sbom-format, dev-sign-helpers, install-from-release). Pin cargo-cyclonedx version, cosign-installer version, identity-regexp guard, Trusted Root prompt, SBOM-skip prevention, narrow tag pattern.

### Out of scope (separate BOMs)

- Daemon binary signing (`src/*`) — v0.6.5.2+
- npm provenance attestations (ADR-038 §3) — v0.6.5.2+
- Renovate / Dependabot policy gates (ADR-038 §4) — v0.6.5.2+
- macOS notarization (`xcrun notarytool`) — v0.6.5.2+
- EV code-signing cert (BOM open question §1) — deferred; Sigstore + MS reputation is the v0.6.5.1 baseline

---

## v0.6.5 — Governor MVP (in progress, PR #34)

**Tray companion that supervises the daemon.** A small Rust + Tauri 2 sidecar (`governor/`) that runs in the system tray, polls `/healthz`, drives `pm2 start` with exponential backoff when the daemon falls over, and surfaces the daemon's state via the Raido-rune tray icon + tooltip. PM2 remains the actual process supervisor; Governor's job is detection, narrow-window auto-recovery, and status surface — per ADR-040.

### Added

- **State machine** — `Unknown / Healthy / Degraded / Down / Restarting / StoppedManually / GiveUp` with explicit transition tests, 5s health-poll cadence, 1/2/4/8/16/32/60s exponential backoff, 5-restarts-in-5-min → `GiveUp` cap. (`governor/src/state.rs`)
- **HTTP probe + restarter abstractions** — `HealthProbe` / `Restarter` / `Clock` traits so the supervisor is fully unit-testable without spawning real PM2. (`governor/src/{supervisor,restart}.rs`)
- **Tray icon + tooltip** — Iron-palette Raido glyph swaps state-driven variants (green / amber / red / gray); 2 Hz pulse for `Restarting` / `GiveUp` / pre-probe. Tooltip format: `stavR · <state> · uptime <duration> · last check <N>s ago`. (`governor/src/{icons,tray}.rs`)

### Fix-PR amendments to PR #34 (v0.6.5 fix BOM)

Closes 4 bugs surfaced during the 2026-05-17 21:00 GST smoke test:

- **Dual tray-icon registration** → consolidated to a single `TrayIcon` instance. `tauri.conf.json`'s `app.trayIcon` block was duplicating the code-side `TrayIconBuilder::with_id("main")`; removed the config side. Tray id + menu-item ids promoted to `TRAY_ID` / `MENU_ID_*` constants so the registration and runtime lookup can never drift. (`governor/src/tray.rs`, `governor/tauri.conf.json`)
- **GiveUp tooltip operator hint** → format_tooltip appends `"needs operator action — right-click for Reset & Restart"` in GiveUp, so the operator gets BOTH the alert AND the recovery path on the same tray (no second "needs operator" overlay icon).
- **Orphan-Node cleanup before `pm2 start`** → new `port_check` module + `ProcessKiller` trait + `OrphanAwareRestarter` wrapper. On a restart failure, Governor probes port 7777 (Windows: `netstat -ano`, Linux: `ss -tlnp` → fall back to `lsof -i :PORT -t`, macOS: `lsof -i :PORT -t`); if a PID is listening it gets `taskkill /F` (or `kill -9` on Unix) and the restart is retried up to 3 iterations. Handles the Windows scenario where `pm2 stop` leaves the Node process alive holding the daemon port. (`governor/src/port_check.rs`, `governor/src/restart.rs`, `governor/src/main.rs`)
- **Settle window prevents false-positive Down during cold-boot** → default 60s settle window after every fresh boot or restart, during which Unreachable probes stay in Degraded instead of flipping to Down. Once the daemon has been Healthy at least once after that boot/restart, the window closes and the normal Degraded→Down rules apply. The cold-boot daemon takes ~40s; pre-fix it was being misread as a crash. Tooltip surfaces `Ns into settle window` so the operator can see Governor is patiently waiting rather than flapping. (`governor/src/state.rs`, `governor/src/tray.rs`)
- **Reset & Restart menu item** → from `GiveUp` (or any state), one operator click clears the 5-in-5-min counter, resets the settle window, and invokes `restart_with_orphan_kill` against port 7777. Wired via Tauri managed state so `tray::build` stays `Runtime`-generic; main.rs `app.manage(supervisor.clone())` makes the handle resolvable in the click handler. "Pause supervision" wired the same way. (`governor/src/{tray,supervisor,main}.rs`)

### Tests

- 69 governor cargo tests pass (28 → 39 after P1, 39 → 55 after P2, 55 → 69 after P3). Cross-platform parsers (`netstat -ano`, `ss -tlnp`, `lsof -t`) validated via fixture strings so a Linux CI run still exercises the Windows parser. Orphan-kill flow covered with mocked PortChecker + ProcessKiller for the clean-restart, orphan-killed-and-retried, clean-port-original-error, kill-failed, and exhaustion paths.

---

## v0.6 — Notifications fabric (in progress)

**Out-of-band operator loop.** The daemon can now pull the operator's attention when needed — and the operator can respond from anywhere. Replies log the same audit events as dashboard clicks; Lex Insculpta posture preserved.

### Added

- **Notifier core** — Notifier + 3 channels (`ntfy.sh`, SMTP email, Telegram bot). HMAC-signed correlation_ids with 5-min default TTL. Fire-and-forget outbound; channel failures never propagate to the caller. (`src/notify/{types,correlation,notifier}.ts`, `src/notify/channels/*`)
- **Schema (additive)** — `notifications` + `notification_channels` tables in the main daemon DB, inline in `src/persistence.ts`.
- **Emit hooks** — single broker.onEvent tap translates `decision_request`, `trust_scope_revoked`, `trust_scope_completed`, and `worker_terminated` (filtered to crashed / user-terminated) into notifications. (`src/notify/wiring.ts`)
- **Daily digest** — 60s-tick scheduler fires once at configured hour:minute (default 09:00 local TZ). Counts decisions, scopes, workers, errors over 24h. Last-fire timestamp persisted in `meta` table. (`src/notify/digest.ts`)
- **Inbound replies** — `GET /notify/reply` HTTP handler with HMAC verify → row lookup → one-shot consume → reply-router dispatch → operator-friendly HTML response. (`src/notify/inbound.ts`)
- **Telegram poller** — 30s long-poll of `/getUpdates` with inline-keyboard `callback_query` handling. Prefix-lookup → full HMAC verify → same consume + route path as webhook. (`src/notify/telegram-poller.ts`)
- **Reply router** — translates `(notification, action_id)` into `store.respondToDecision` / `TrustStore.extend` / no-op. Publishes `decision_response` or `trust_scope_extended` event with `source_agent='notify:webhook'` (or `notify:telegram`). (`src/notify/reply-router.ts`)
- **Rate limit** — `RateLimiter` 30 req/min/IP on `/notify/reply`. (`src/notify/rate-limit.ts`)
- **Settings UI** — "Notification channels" panel mirroring F2 pending-scopes pattern. CONFIGURED / CONFIGURED · STALE / NOT SET status pills + [Test] / [Help] actions. NO secret display. (`src/dashboard/pages/settings.ts`, `src/dashboard/data/channels.ts`)
- **Helm digest row** — small row in the L4 intent band: time + Edit/Disable toggle. (`src/dashboard/pages/helm.ts`)
- **HTTP endpoints** — `POST /dashboard/settings/channels/:id/test`, `GET|POST /dashboard/settings/digest`, `GET /dashboard/settings/notifications-help`. (`src/transports.ts`)
- **Operator setup guide** — per-channel walkthroughs + threat model + audit-trail reference. (`docs/notifications.md`)

### Threat model (replies)

A stolen correlation_id buys: one consumed reply, within 5-min window, of a pre-defined action shape, still subject to existing TrustStore / respondToDecision checks. Reply endpoint is loopback-only by default; non-loopback bind requires the daemon's existing auth gate.

### Dependencies

- Adds `nodemailer` + `@types/nodemailer` (BOM hard rule #3 — only allowed third-party for the daemon hot path; everything else uses Node stdlib `https`).

### Known follow-ups (v0.6.1 candidates)

- Slack / Discord channels (channel registry already accepts new entries without core changes).
- "Do not disturb" window (`info` severity only; `warn` and `crit` always page).
- Notification history page at `/dashboard/notifications` — the `notifications` table is queryable today; UI is purely additive.

---

## v0.5 — Steward portability

- Subprocess Steward with three-layer state stores (working memory / lessons / prefs).
- Model Runtime abstraction (Anthropic / Ollama / Claude Code) for portable planning.
- Autonomy levels: reactive / scheduled / proactive.

See `docs/release-notes-v0.2.0.md` and earlier for full history.
