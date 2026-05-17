# stavR · v0.6 — Notifications & Out-of-Band Operator Loop

> Mid-size PR (split into 3). Adds a multi-channel notification fabric so the Steward, Cowork-Claude, and external workers can pull the operator's attention when needed — and so the operator can respond from anywhere (phone, watch, desk) without sitting in front of the dashboard. Designed Lex Insculpta-compliant: notifications fulfill the law's "I shall not act unseen" promise. Bidirectional channels let "the reply IS the consent."

**Estimated wall-clock**: 12–17 hours CC sequential across 3 PRs.

**Stop conditions**: end of any phase if `npm test` regresses (must stay ≥699 passing per current baseline), `npm run build` fails, or any negative-path test demonstrates that an inbound reply can be forged (no auth, replay window violated, correlation_id reuse).

**Do NOT pause for approval** between phases within a PR. Open PR at end of each phase-group (3 PRs total). Operator merges between PRs.

---

## Why this matters

Today the operator (Kenneth) is the only path to consent for any RED-tier action. The dashboard shows pending decisions, but only when the dashboard tab is open. Steward + Cowork-Claude run autonomously inside trust scopes and routinely hit moments where they should escalate (scope-expansion needed, no-go boundary touched, daemon health degraded, BOM ambiguity blocking phase) — but the operator has no out-of-band signal.

Pain points concrete examples from the last 7 days:
1. v0.5 Steward portability run paused at P2 because BOM referenced a non-existent `migrations/001_bom_schema.sql`. CC sat idle for 90+ minutes until operator checked progress.
2. PM2 corruption killed stavR twice mid-session. Operator was on the laptop both times by luck — could easily have been overnight.
3. PR #29 trust scope expired mid-execution. Cowork-Claude correctly halted, operator needed to grant extension from another room.
4. Cluster 0 dispatch finished in 50 min, but operator only learned via manually polling. Could have been notified instantly.

A notification fabric collapses all four into "operator gets a buzz on phone, taps approve/deny/ignore, work resumes."

**Lex Insculpta posture**: notifications are an extension of the "act unseen" prohibition, not a workaround. Every notification is a transparency event. Every bidirectional reply that grants something is the same as an operator click in the dashboard — same audit log, same scope-cap check, same revocability.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files + don't-touch defaults)
2. `storm-pass-2/lex-insculpta.md` (OneDrive personal) — the governance law this system serves
3. `src/steward/decisions.ts` (or equivalent) — current `await_decision` / `respond_to_decision` flow
4. `src/dashboard/pages/settings.ts` — the F2 pending-scopes panel pattern; channel config will live next to it
5. `adr/030-event-retention-and-dashboard-caching.md` — event model (notifications ride the event bus)
6. `adr/035-federated-stavr-a2a-oauth21.md` — future federation; notifications must be addressable per-spawn
7. `proposed/host-exec-curl-gh-expansion-bom.md` — recent BOM, mirror its commit/phase discipline
8. `proposed/v0_5-steward-portability-bom.md` — for cross-reference, since v0.5 + v0.6 ship in parallel

---

## Don't touch

- `src/security/host-exec-*` — notifications do not need shell access
- `src/security/trust-scopes.ts` — scope model is unchanged; notifications are a channel, not a scope kind
- `src/persistence.ts` schema except for the two additive tables in P1 (`notifications` + `notification_channels`)
- `src/worker/`, `src/mcp/` — notifications hook in via the event bus, not new worker types
- `src/dashboard/pages/*` except `settings.ts` (add Channels section in P3) and a single new row in `helm.ts` (toggle for "send me a daily digest")
- `ecosystem.config.cjs` — no new PM2 process; notifier runs inside daemon
- Any UI surface beyond what's in P3
- The `await_decision` MCP tool contract — notifications are an additional delivery path, the tool itself is unchanged

---

## Hard rules

1. **Tests are derivative** — if existing event-bus tests assert on the current event-type enum, extend the enum and update assertions in the same commit
2. **Never lose files** — bash `stat -c %s` + `tail -5` verify before commit for any file >15KB (the notifier module + tests will be borderline)
3. **No third-party SDKs in the daemon hot path** — Telegram bot polling, ntfy.sh publishing, email SMTP all go through narrow inline HTTP/SMTP wrappers using Node stdlib (`https`, `nodemailer` is the one allowed dep). Don't pull `telegraf`, `node-telegram-bot-api`, `gotify-client`, etc.
4. **Outbound is fire-and-forget; inbound is verified** — outbound notification failure must NOT crash the action that emitted it (Steward emits, notifier swallows network errors and logs them). Inbound reply must verify: HMAC signature on webhook, correlation_id check, replay window (5 min), one-shot consumption
5. **Correlation IDs are unforgeable** — generate via `crypto.randomUUID()` + sign with a per-channel secret derived from a master `stavR_notification_secret` env var. Operator rotates by changing env + restarting daemon. Old correlation IDs invalidate naturally
6. **Lex Insculpta compliance** — a reply that grants scope, approves a decision, or expands an allowlist MUST log the same `consent_recorded` event the dashboard click logs. Same audit trail, same revocability. No "phone replies bypass audit."
7. **Channel secrets never appear in the dashboard UI** — set/cleared via env or `stavr-cli` only. UI shows masked "configured: yes/no" + last-success timestamp + test-send button. Never the actual bot token or SMTP password
8. **DCO -s, per-phase commits, push at end of each phase. One PR per phase-group (3 PRs)**

---

## Phase-group structure (3 PRs)

| PR | Phases | Scope | Wall-clock |
|---|---|---|---|
| #1 — Outbound | P0, P1, P2 | Channels + outbound notifier + emit hooks | 6–8h |
| #2 — Inbound | P3, P4 | Inbound webhook + Telegram polling + reply→decision wiring | 4–6h |
| #3 — UI | P5, P6 | Settings UI for channel config + Helm digest toggle + docs | 2–3h |

Each PR is independently merge-able: PR #1 lands a working one-way notifier (operator sees but can't reply); PR #2 enables replies; PR #3 polishes the operator UX.

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~5 min. Operator confirms:

1. `git status` clean on `main`, current HEAD includes PR #29 (curl+gh) and the v0.5 Steward portability run is either merged or on a separate branch (don't conflict)
2. `npm test --run` baseline = 699+ passing
3. Decide on initial channel set — recommended minimum: **ntfy.sh** (anonymous push, no signup) + **email SMTP** (operator already has a relay). Telegram bot is optional but the highest-value reply channel; skip in PR #2 if signup friction blocks
4. Provision ntfy.sh topic name (e.g., `stavr-kst-prod-abc123` — pick a long random suffix; topic name IS the secret on ntfy.sh)
5. If using Telegram: create bot via @BotFather, get bot token, send the bot one message from operator's phone, note the chat_id
6. Add to `.env`:
   - `STAVR_NOTIFY_NTFY_TOPIC=...`
   - `STAVR_NOTIFY_EMAIL_FROM=...` / `_TO=...` / `_SMTP_HOST=...` / `_SMTP_USER=...` / `_SMTP_PASS=...`
   - `STAVR_NOTIFY_TELEGRAM_BOT_TOKEN=...` / `_CHAT_ID=...`
   - `STAVR_NOTIFY_SECRET=...` (generate via `openssl rand -hex 32` — used for correlation_id signing)
7. Dispatch CC with PR #1 brief

---

## P1 · Notifier module + outbound channels (PR #1, 3–4h)

**Files**:
- `src/notify/types.ts` — `Notification`, `NotificationChannel`, `NotificationSeverity`, `NotificationKind`
- `src/notify/notifier.ts` — main `Notifier` class, channel registry, `notify()` API
- `src/notify/channels/ntfy.ts` — ntfy.sh HTTP publisher
- `src/notify/channels/email.ts` — SMTP via `nodemailer`
- `src/notify/channels/telegram.ts` — Telegram Bot API `sendMessage` via `https`
- `src/notify/correlation.ts` — `mintCorrelationId()` + `verifyCorrelationId()` HMAC helpers
- `migrations/00X_notifications.sql` (next available number) — `notifications` table + `notification_channels` table
- `tests/notify/notifier.test.ts`
- `tests/notify/channels/*.test.ts` (one per channel)
- `tests/notify/correlation.test.ts`

### Schema (additive only)

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,          -- 'decision_required' | 'scope_expired' | 'health_alert' | 'work_complete' | 'digest'
  severity TEXT NOT NULL,      -- 'info' | 'warn' | 'crit'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_event_id TEXT,        -- if emitted by an event, the originating event id
  actions_json TEXT,           -- JSON: [{label, action_id, kind: 'approve'|'deny'|'ignore'|'link'}]
  expires_at INTEGER,          -- correlation_id replay window (default +5 min for decisions, NULL for info)
  delivered_channels TEXT,     -- CSV of channel ids that returned 2xx
  failed_channels TEXT,        -- CSV of channel ids that errored
  consumed_at INTEGER,         -- timestamp when a reply or dashboard click consumed it
  consumed_by TEXT             -- 'telegram:chat_id' | 'webhook:ip' | 'dashboard:session_id'
);

CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,         -- 'ntfy' | 'email' | 'telegram' | 'webhook'
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,            -- non-secret config; secrets stay in env
  last_success_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);

CREATE INDEX idx_notifications_correlation ON notifications(correlation_id);
CREATE INDEX idx_notifications_kind_created ON notifications(kind, created_at DESC);
```

### Notifier API

```ts
interface Notification {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actions?: NotificationAction[];   // optional reply buttons
  sourceEventId?: string;
  ttlMs?: number;                   // reply window; defaults: 5m for decisions, none for info
}

class Notifier {
  async notify(n: Notification): Promise<NotificationResult>;
  registerChannel(channel: NotificationChannel): void;
  getChannelStatus(): ChannelStatus[];
}
```

`notify()` is fire-and-forget from the caller's perspective: it returns a `NotificationResult` with `id` + `correlationId` + `dispatchedChannels`, never throws. Channel-level errors are logged + recorded in `failed_channels` but never propagate.

### Channels

**ntfy.ts**: `POST https://ntfy.sh/{topic}` with `Title`, `Priority`, `Click`, `Actions` headers. Actions encode as `Actions: http, Approve, https://your-stavr/notify/reply?cid=...&action=approve` (ntfy.sh forwards as HTTP callbacks). Severity → Priority mapping: info=3, warn=4, crit=5.

**email.ts**: nodemailer SMTP. Body is plain text + minimal HTML (one button per action linking to the reply webhook URL with embedded correlation_id signature). No images, no tracking pixels.

**telegram.ts**: `POST https://api.telegram.org/bot{token}/sendMessage` with `chat_id`, `text`, and `reply_markup` containing inline keyboard buttons (one per action). Button callback_data = `{correlation_id}:{action_id}`. Long polling for replies handled in P3.

### Acceptance

- 3 channels register at startup if their env vars are present
- `notify({kind: 'health_alert', severity: 'warn', title: 'test', body: 'test'})` reaches all configured channels
- Channel failures don't crash daemon (kill SMTP connection mid-send → recorded in `failed_channels`, daemon continues)
- Correlation ID round-trip: mint → embed in URL → verify in a separate process succeeds with secret, fails without
- 6+ new tests passing

### Commit
`feat(notify): notifier core + ntfy/email/telegram channels`

---

## P2 · Emit hooks across daemon (PR #1, 3–4h)

**Files**:
- `src/steward/decisions.ts` — call `notifier.notify({kind: 'decision_required', actions: ['approve','deny','ignore']})` when `await_decision` is invoked
- `src/security/trust-scopes.ts` — emit `kind: 'scope_expired'` (or warning ~10% remaining)
- `src/health/watchdog.ts` (or wherever WATCH OK logic is) — emit `kind: 'health_alert'` on transition to warn/crit
- `src/worker/*` — emit `kind: 'work_complete'` when a worker finishes a dispatched task (filter on `notify_on_complete` flag in dispatch)
- `src/dashboard/data/digest.ts` (new) — daily digest builder: counts of decisions made, scopes granted, workers run, errors
- Daily digest scheduler hook in `src/server.ts` (cron-style, single timer)

### Don't add notifications for noisy events

Banned kinds in this PR: `event_received`, `tool_called`, `metric_updated`, `cache_refreshed`. These should be filterable via the digest, not pushed live.

### Acceptance

- 4 emit sites wired (decisions, scopes, health, work_complete)
- Daily digest sends at configurable hour (default 09:00 operator local)
- All emit sites have unit tests that mock the notifier and assert the right `kind` + `severity`
- Manual smoke: trigger a fake `await_decision`, see ntfy.sh push on operator phone

### Commit
`feat(notify): wire emit hooks for decisions/scopes/health/work + daily digest`

### Open PR #1

`feat(notify): outbound notification fabric (ntfy + email + telegram) with emit hooks`

Body must include:
- Channel matrix (which configured, which not)
- Sample notification screenshots from each channel
- Note: "Inbound replies land in PR #2; for now, replies are no-ops"

---

## P3 · Inbound webhook + reply handler (PR #2, 2–3h)

**Files**:
- `src/notify/inbound.ts` — `/notify/reply` HTTP handler
- `src/notify/telegram-poller.ts` — long-poll Telegram for inline button callbacks
- `src/notify/reply-router.ts` — maps `(correlation_id, action_id)` → underlying action (grant scope / respond_to_decision / dismiss)
- `tests/notify/inbound.test.ts`
- `tests/notify/reply-router.test.ts`

### `/notify/reply` endpoint

`GET /notify/reply?cid={signed_correlation_id}&action={action_id}` (GET because email/ntfy.sh links are GETs; mitigated by correlation_id being one-shot + signed + short-TTL).

Handler steps:
1. Verify HMAC signature on `cid` — reject 401 if invalid
2. Look up notification by `correlation_id` — reject 404 if not found
3. Check `consumed_at IS NULL` — reject 410 Gone if already consumed
4. Check `expires_at > now` — reject 410 Gone if expired
5. Validate `action_id` against the notification's `actions_json`
6. Mark consumed (`UPDATE notifications SET consumed_at = ?, consumed_by = ?`)
7. Dispatch to reply-router
8. Return HTML page: "✓ Approved" / "✗ Denied" / "Acknowledged" (operator-friendly, no JSON)

### Telegram poller

Single timer, 30s interval, calls `getUpdates` with offset. For each inline keyboard callback:
1. Parse `callback_data` → `(correlation_id, action_id)`
2. Same verify → consume → dispatch path as HTTP webhook
3. `answerCallbackQuery` with confirmation toast

### Reply router

Maps action kinds to internal handlers:
- `approve` on a decision → call existing `respond_to_decision(decision_id, 'approve')`
- `deny` on a decision → `respond_to_decision(decision_id, 'deny')`
- `grant_extension` on a scope → call existing scope-extend handler
- `ignore` / `dismiss` → just mark consumed, no further action
- `link` → not a reply, just a URL the operator visits (no-op on inbound, used for "open dashboard")

Each reply emits the SAME audit events as the equivalent dashboard click. Operator sovereignty preserved.

### Acceptance

- HMAC verify rejects tampered cid (negative test)
- Replay test: same cid clicked twice → second click 410 Gone
- Expired test: cid clicked after `expires_at` → 410 Gone
- End-to-end: emit `decision_required` from a test, "click" via test-mode HTTP call, assert decision is `approved` + audit event recorded
- Telegram callback handler unit tests (mock `getUpdates`)
- 8+ new tests passing

### Commit
`feat(notify): inbound webhook + telegram poller + reply→decision routing`

---

## P4 · Hardening + scope check (PR #2, 1–2h)

**Files**: `src/notify/inbound.ts`, `tests/notify/inbound.test.ts`

### Sub-tasks

1. **Rate limit** `/notify/reply`: 30 requests/min/IP (cheap in-memory; defense against brute-forcing correlation_ids)
2. **No CORS** — endpoint is intended for direct GET from notification clicks, not browser fetch. Set `Access-Control-Allow-Origin: null`
3. **Audit log** every reply: `notification_reply { correlation_id, action_id, source: 'webhook'|'telegram', ip?, chat_id?, granted_action? }`
4. **Scope-cap respected**: if a reply tries to expand allowlist or grant scope, that downstream call goes through normal scope check. Reply CANNOT bypass scope (e.g., a Telegram reply approving "delete production DB" — there's no allowlist entry for that, scope check still blocks)
5. **Negative tests** for §4 — reply that tries to invoke a no-go action returns 200 (consumed) but the action fails downstream with the normal scope error, audit log shows BOTH the reply AND the failure

### Acceptance

- Rate limit demonstrable (101st request in a minute → 429)
- Audit events written for every reply, queryable via existing event log
- 4+ new negative tests passing

### Commit
`feat(notify): rate limit + audit + scope-cap enforcement on inbound replies`

### Open PR #2

`feat(notify): bidirectional replies — webhook + telegram with audit + scope-cap`

Body must include:
- Threat model: what a stolen correlation_id buys an attacker (answer: one consumed reply, within 5-min window, of a pre-defined action — and the action still passes through scope check)
- Note: PR #3 adds operator-facing config UI; until then, channels are configured via env only

---

## P5 · Settings UI for channel config (PR #3, 1–2h)

**Files**:
- `src/dashboard/pages/settings.ts` — add "Notification Channels" section
- `src/dashboard/data/channels.ts` — fetcher for channel status
- `src/dashboard/data/__tests__/channels.test.ts`

### UI design (mirrors F2 pending-scopes panel pattern)

`.glass` panel titled "NOTIFICATION CHANNELS" with one row per registered channel:

```
┌─ NOTIFICATION CHANNELS ────────────────────────┐
│ ntfy.sh         CONFIGURED   ✓ 2m ago   [Test]│
│ Email (SMTP)    CONFIGURED   ✓ 1h ago   [Test]│
│ Telegram        NOT SET      —          [Help]│
│ Webhook         CONFIGURED   ✓ 5m ago   [Test]│
└────────────────────────────────────────────────┘
```

- Status: `CONFIGURED` (env vars present + last_success within 24h) / `CONFIGURED·STALE` (env present but no success in 24h) / `NOT SET` (env vars missing)
- `[Test]` button calls `notifier.notify({kind: 'health_alert', severity: 'info', title: 'Channel test', body: 'Test message from settings page'})` and returns success/failure
- `[Help]` button links to docs section for that channel
- **NO secret display, NO secret edit in UI** — channel config is env-only by design (per Hard rule #7)

### Helm page addition (tiny)

A single new row on `/dashboard` Helm:
- "Daily digest: 09:00 — [Edit]" with `[Disable]` toggle
- `[Edit]` opens a time picker; `[Disable]` clears the digest cron entry

### Acceptance

- Settings page renders channel rows from real data
- Test button works end-to-end (operator clicks → notification arrives on phone)
- Helm digest toggle persists across daemon restarts
- 4+ new tests passing

### Commit
`feat(dashboard): notification channels panel in settings + digest toggle in helm`

---

## P6 · Docs + Run prompt for ops (PR #3, ~1h)

**Files**:
- `docs/notifications.md` (new) — operator setup guide for each channel (env vars, ntfy.sh topic naming, Telegram bot setup)
- `CHANGELOG.md` — v0.6 entry
- `README.md` — one-line mention of notification capability in features list

### Acceptance

- A first-time operator can set up ntfy.sh in <5 min following the docs
- Telegram setup guide includes the exact @BotFather commands

### Commit
`docs(notify): operator setup guide + changelog`

### Open PR #3

`feat(dashboard): notification channels UI + docs (closes v0.6)`

---

## Budget

- **Time**: 12–17h CC sequential across 3 PRs (operator merges between)
- **API cost**: ~$15–25 (medium surface; lots of test scaffolding)
- **LOC change**: ~1,200–1,600 net across `src/notify/`, `src/dashboard/`, `migrations/`, `tests/notify/`
- **Token cap**: 1.5M (split across 3 worker runs, ~500k each)
- **New deps**: `nodemailer` (well-maintained, single dep) — that's it. Telegram + ntfy.sh + webhook all use Node stdlib `https`
- **Schema change**: 2 additive tables (`notifications`, `notification_channels`), no migrations to existing tables

---

## Footgun appendix

1. **ntfy.sh topic name IS the auth** — anyone with the topic name can publish to it. Pick long random suffixes. Document this prominently in setup guide.
2. **Telegram bot token in env** — must NOT appear in PM2 logs. Confirm `console.log(process.env)` is not called anywhere. Test by `pm2 logs stavr | grep BOT_TOKEN` returning empty.
3. **SMTP "from" must match domain** for many providers (SPF/DKIM). Operator's SMTP relay setup determines what "from" works. Document.
4. **Correlation ID in URL = logged in browser history** if operator clicks from email on a desktop browser. One-shot consumption mitigates: even if URL leaks later, second click is 410 Gone. Document that re-clicking old emails will say "Already responded."
5. **Telegram long polling vs webhook** — long polling is simpler (no public HTTPS needed) but uses a slot. For self-hosted stavR not exposed to internet, polling is the only path. Webhook would need ngrok/cloudflared; out of scope here.
6. **Daily digest at 09:00 operator local** — daemon doesn't know operator timezone reliably. Use `Intl.DateTimeFormat().resolvedOptions().timeZone` at config time; persist the TZ string in `notification_channels.config_json` for digest channel.
7. **`notify()` is fire-and-forget from caller, but `Notifier` itself awaits all channel sends in parallel** — slow SMTP could make the notify call take 10s. Wrap in `setImmediate` so caller is never blocked. The 10s SMTP attempt still runs to completion in background.
8. **Replay window is short (5 min) for decisions** — operator who sees notification 10 min later gets 410 Gone. This is correct: stale approvals are exactly what we want to reject. UI shows expired notifications as "Missed" so operator can re-trigger from dashboard if needed.
9. **Daily digest must NOT contain secrets** — channel statuses are fine, but never include trust-scope tokens, allowlist secrets, or env values in the digest body.
10. **Mobile push battery** — ntfy.sh app, Telegram app, email apps all use OS push fabric. No additional battery cost from stavR beyond what those apps already consume.
11. **Multi-device** — operator may have ntfy.sh app on phone AND watch. Both get the notification. First device to click wins (one-shot consume). Second device shows the notification but click → 410 Gone with "Already responded on another device" page.
12. **Daemon restart drops in-flight notifications** — emitted but not yet dispatched are lost (they live in memory queue until channel returns 2xx). Acceptable: operator gets the next emit. For critical kinds (`crit`), persist to `notifications` table BEFORE channel dispatch so they can replay on restart. Add `dispatched_at` column for this.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should the operator be able to disable a channel mid-session without daemon restart?

Yes (UI toggle), but channel re-enable requires env vars present. If env vars are missing, the toggle is grayed.

**Default during implementation**: yes, toggle in UI; underlying state in `notification_channels.enabled`.

### §2 — Should there be a "do not disturb" window (e.g., 22:00–07:00)?

Yes, but only for `info` severity. `warn` and `crit` always page. Configurable per-channel.

**Default**: not in PR #1-#3; add in v0.6.1 if operator wants it. Note in CHANGELOG as known follow-up.

### §3 — Should the daily digest include `work_complete` events?

Yes — operator wants the morning summary to show "5 PRs landed overnight." But individual `work_complete` notifications are noisy; default OFF for live push, ON for digest.

**Default**: live push for `work_complete` is opt-in per dispatched task (`notify_on_complete: true` flag). Digest always includes them.

### §4 — Should we support Slack/Discord channels?

Eventually. They're additional channel implementations of the same `NotificationChannel` interface. Out of scope for v0.6; one PR each in v0.6.x.

**Default**: not in this BOM. If operator adds them in v0.6.1, the channel registry pattern accepts new entries without core changes.

### §5 — Reply auth: should we add a second factor on critical replies?

For `crit` decisions (e.g., "approve daemon shutdown"), should the reply require a second tap with a TOTP? This would mean operator gets push → taps approve → gets second push asking for TOTP code → enters it.

**Default**: no in v0.6. Scope-cap enforcement (Hard rule #4 on P4) is the existing second-factor — replies can't grant what scopes don't allow. If a no-go action somehow shows up as a notification, the reply still gets blocked at scope check. Revisit when adding federation in ADR-035 phase 4.

### §6 — Should notifications federate across stavr-spawns?

Per ADR-035 phase 4, federated spawns will eventually share notification routing. For v0.6, single-spawn only. Federation adds a "from which spawn" header to notifications later.

**Default**: not in this BOM. The Notifier interface should accept an optional `originSpawnId` field so PR-future federation work doesn't need a refactor.

### §7 — Should the dashboard show notification history?

Yes, but as a separate `/dashboard/notifications` page (out of scope for v0.6 — UI lives only in settings + helm digest toggle for now). v0.6.1 candidate.

**Default**: not in this BOM. The `notifications` table is queryable, so a future page is purely additive.

---

## Run prompt for CC (PR #1, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6-notifications-bom.md and execute P0 (operator pre-flight) acceptance check followed by P1 and P2 sequentially.

This is Lex Insculpta-compliant scope expansion: notifications fulfill "I shall not act unseen." Replies that grant scope/approve decisions log the SAME audit events as dashboard clicks. Out-of-band consent is consent.

Rules:
- One commit per phase, DCO sign-off (-s)
- Don't pause for approval between phases inside this PR. Commit + push at end of each phase
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit. If a phase regresses, fix in the same phase commit
- After P2 opens PR, output a final delta report and STOP. Don't auto-merge. Don't proceed to PR #2 (P3-P4)

The brief is self-contained. Open questions §1-§7 are flagged — pick the conservative default during implementation and note in PR body, don't block.

Go.
```

## Run prompt for CC (PR #2, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6-notifications-bom.md.

PR #1 (P1-P2) is merged. Your scope: P3 (inbound webhook + reply handler) and P4 (hardening + scope-cap enforcement). Open PR at end of P4.

Same rules as PR #1. Go.
```

## Run prompt for CC (PR #3, paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6-notifications-bom.md.

PR #1 and PR #2 are merged. Your scope: P5 (settings UI + helm digest toggle) and P6 (docs). Open PR at end of P6.

Same rules as PR #1. UI work — mirror the F2 pending-scopes panel pattern in src/dashboard/pages/settings.ts. NO secret display in UI. Go.
```

---

## End of brief
