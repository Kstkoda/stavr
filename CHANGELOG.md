# Changelog

stavR ships incrementally — small, reviewable PRs that each pass `npm test` and `npm run build` independently. Release notes for major surface changes live in `docs/release-notes-v0.*.md`; this file is the project-level timeline.

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
