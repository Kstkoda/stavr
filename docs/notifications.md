# Notifications · operator setup guide

> stavR v0.6 ships a personal notification fabric: outbound push from the daemon (Steward / Cowork-Claude / workers) plus bidirectional replies so the operator can approve decisions and extend trust scopes from anywhere. Replies log the same audit events as dashboard clicks — out-of-band consent is consent.

This guide walks through enabling each channel from scratch and explains the security model (Lex Insculpta posture).

---

## Quick architecture

```
 daemon (broker + notifier)
       │
       ├──→ ntfy.sh       (HTTP push, anonymous topic)
       ├──→ Email (SMTP)  (button links → /notify/reply?cid=…&action=…)
       └──→ Telegram bot  (inline keyboard → bot callback_query)
                                                       ↑
                                                       │
       operator phone/watch ──── HTTPS or Telegram poll
                                                       │
       /notify/reply  ←── one-shot, HMAC-signed, 5-min TTL
                          │
                          ▼
                   ReplyRouter
                          │
                          ├──→ respondToDecision  →  decision_response event
                          ├──→ TrustStore.extend  →  trust_scope_extended event
                          └──→ ignore             →  marks consumed only
```

All three channels are optional. Set as few or as many as you want; the notifier sends to every configured channel in parallel and records per-channel delivery status.

---

## Prerequisite: the master signing secret

The fabric is opt-in. Until you set a master signing secret, the notifier is wholly disabled (no rows persisted, no channels registered).

```sh
# Generate once. 32 random bytes hex-encoded is plenty.
openssl rand -hex 32
# → e.g. b4d3e1f0a7c8...

# Add to ~/.stavr/.env (or your daemon env loader)
export STAVR_NOTIFY_SECRET=b4d3e1f0a7c8…
```

Rotating the secret invalidates every previously-minted correlation_id — old reply links become unverifiable on the next daemon restart. Treat the secret like an SSH key, not like a password.

Restart the daemon after setting:

```sh
# Linux (systemd):  systemctl --user restart stavr.service
# macOS (launchd):  launchctl kickstart -k gui/$(id -u)/com.stavr.daemon
# Windows (WinSW):  .\bin\winsw\StavrDaemon.exe restart
# Direct (any OS):  stavr daemon stop && stavr daemon start --detach
# Legacy (PM2, deprecated): pm2 restart stavr
```

Open the Settings page (`http://127.0.0.1:7777/dashboard/settings`). The new **Notification channels** panel appears. Until you configure individual channels below, all three show `NOT SET`.

---

## ntfy

Simplest path. ntfy.sh is anonymous push — no account, no API key. The **topic name is the auth**: anyone who knows the topic can publish and subscribe to it. Pick a long random suffix.

### Setup

1. Install the **ntfy** app on your phone (Android / iOS / web).
2. Subscribe to a topic, e.g. `stavr-kst-prod-7f4a91b2c8d3`. The topic name must be at least 8 chars; longer is better.
3. Set the env var:
   ```sh
   export STAVR_NOTIFY_NTFY_TOPIC=stavr-kst-prod-7f4a91b2c8d3
   # Optional: self-hosted ntfy server
   # export STAVR_NOTIFY_NTFY_SERVER=https://ntfy.example.com
   ```
4. Restart the daemon. The Settings panel should now show `CONFIGURED · STALE` for ntfy (stale because no successful send has happened yet).
5. Click **[Test]** in the Settings panel. A push should appear on your phone within a few seconds. The panel will refresh and show `CONFIGURED`.

### Footgun

If the topic name leaks, anyone can publish notifications to your phone. Roll the topic name by changing the env var and re-subscribing in the app. There's no revocation — old messages already delivered stay on the phone until you clear them.

---

## Email (SMTP)

Routed through any SMTP relay you already have. Plain-text + minimal HTML, one button per reply action.

### Setup

1. Pick an SMTP relay (your own server, Postmark, SendGrid, the SMTP gateway your IDP exposes — whatever you trust).
2. Set the env vars:
   ```sh
   export STAVR_NOTIFY_EMAIL_FROM=stavr@your-domain.example
   export STAVR_NOTIFY_EMAIL_TO=you@your-domain.example
   export STAVR_NOTIFY_EMAIL_SMTP_HOST=smtp.example.com
   export STAVR_NOTIFY_EMAIL_SMTP_PORT=587
   export STAVR_NOTIFY_EMAIL_SMTP_USER=stavr@your-domain.example
   export STAVR_NOTIFY_EMAIL_SMTP_PASS=your-smtp-password
   ```
3. Restart the daemon, then click **[Test]** in Settings.

### Footgun

Most SMTP relays enforce SPF/DKIM matching the `FROM` domain. If you see "550 sender not allowed" in the channel error row, set `STAVR_NOTIFY_EMAIL_FROM` to a domain you actually own (or one your relay permits).

The reply button links go to `STAVR_NOTIFY_REPLY_BASE_URL` (set this when you want the operator to be able to click from email). For loopback-only setups, set it to `http://127.0.0.1:7777` — but realize that only works when the email client is on the same machine.

---

## Telegram

Best UX for replies (inline buttons, native push, group support). Requires creating a bot.

### Setup

1. In Telegram, message `@BotFather`:
   ```
   /newbot
   stavR-personal
   stavr_kst_bot
   ```
   BotFather replies with a bot token like `1234567890:AAEx...`. Copy it.
2. Search for your bot in Telegram (e.g. `@stavr_kst_bot`), tap **Start**, then send it any message (just `hi`).
3. Find your chat_id by visiting:
   ```
   https://api.telegram.org/bot{BOT_TOKEN}/getUpdates
   ```
   in a browser. The response JSON contains `"chat":{"id":123456789,...}`. Copy the `id`.
4. Set env:
   ```sh
   export STAVR_NOTIFY_TELEGRAM_BOT_TOKEN=1234567890:AAEx...
   export STAVR_NOTIFY_TELEGRAM_CHAT_ID=123456789
   ```
5. Restart the daemon. The poller is started automatically when both env vars are present. Click **[Test]** in Settings.

### Footgun

The bot token is a secret. Treat it like an API key:
- Keep it out of shell history (`HISTFILE=/dev/null` or use a secrets file).
- Don't `console.log(process.env)` anywhere — the daemon code never does, but verify your own customizations.
- Rotate via `/revoke` in BotFather if leaked.

Telegram callback_data is 64 bytes max. The poller handles this by storing the full signed cid in DB and using a prefix lookup; the prefix itself isn't trusted as auth, the full HMAC verify still runs.

### Operator directives (v0.6.X)

The Telegram bot accepts free-text directives in addition to inline-button replies. Authentication is by chat_id match against `STAVR_NOTIFY_TELEGRAM_CHAT_ID` — only the configured operator can issue directives. Messages from any other chat are silently dropped (the bot's existence stays unconfirmable) and an audit event (`telegram_directive_rejected`) is logged.

| Command | Effect | Audit event |
|---|---|---|
| `/steward <text>` | Steward picks up the directive on its next planning cycle | `operator_directive` |
| `/scope <text>` | Steward proposes a trust scope; operator confirms via Grant/Reject buttons | `operator_scope_request` |
| `/status` | Inline reply with daemon health + active worker count | (no event — read-only) |
| `/ask <text>` | One-shot synchronous Q→A; Steward replies via Telegram | `operator_ask` |
| anything else | Help text reply listing the four commands | (no event) |

Group-chat tagging works: `/steward@stavr_kst_bot ...` parses the same as `/steward ...`. Replies confirm receipt with a short event id (`Directive received (id ab12cd34)…`) so the operator can correlate against the audit log.

Rate limit: 30 directives per minute per chat_id, shared with the `/notify/reply` budget. Bursts get a `Rate limit hit. Try again in a minute.` reply and a `telegram_directive_rejected` audit event with `reason: rate_limit`.

The poller is not yet auto-started by the daemon for directive mode — operators who want it call `new TelegramPoller({...broker, authorisedChatId, directiveRateLimiter})` from their wiring code. A follow-up PR adds `STAVR_NOTIFY_TELEGRAM_POLL=1` opt-in to the default startup.

### Extended outbound coverage (v0.6.X bonus)

The notification fabric now taps four additional event kinds:

| Event kind | Notification kind | Severity | Inline actions |
|---|---|---|---|
| `trust_scope_proposed` | `scope_proposed` | `warn` | [Grant] [Reject] [Open dashboard] |
| `host_exec_denied` | `host_exec_denied` | `warn` | [View audit] |
| `worker_dispatch_failed` | `worker_dispatch_failed` | `crit` | [View logs] |
> The `worker_dispatch_failed` event is a legacy name still emitted via dual-emit during the worker-dispatch deprecation window (see [event-taxonomy.md](./event-taxonomy.md)). Subscribers don't need to migrate today; a future release will rename the notification kind to `job_dispatch_failed`.

| `cc_quota_warning` | `cc_quota_warning` | `warn` (`crit` at ≥95 %) | [View status] |

[Grant] routes to `TrustStore.grant(scopeId, "notify:telegram")` — same audit shape as a dashboard click; emits `trust_scope_granted`. [Reject] revokes the proposed scope and emits a dedicated `trust_scope_rejected` event. Both honour the same `wrong_state` short-circuit if the scope isn't in `proposed` state any more (e.g. operator granted from the dashboard in the meantime).

---

## Daily digest

Once you have at least one channel configured, the daily digest fires automatically each morning. Default: **09:00 local timezone**. Body counts decisions answered, trust scopes granted, workers run, and errors over the last 24 hours.

Tweak from the Helm page (`http://127.0.0.1:7777/dashboard`): the L4 INTENT band has a `digest` row with **[Edit]** (time picker) and **[Disable]/[Enable]** toggle. Changes apply immediately for the daemon's lifetime; permanent changes go in env vars:

```sh
export STAVR_NOTIFY_DIGEST_HOUR=8
export STAVR_NOTIFY_DIGEST_MINUTE=30
export STAVR_NOTIFY_DIGEST_ENABLED=true   # set to false to disable on next boot
```

---

## Reply security model

Stolen correlation_ids buy an attacker:

- **One** consumed reply (one-shot atomic SQL UPDATE)
- Within a **5-minute** TTL window (default for `decision_required`)
- Of a **pre-defined** action shape (action_id must validate against the notification's `actions_json`)
- And the action still passes through the existing `TrustStore` / `respondToDecision` checks

In practice an attacker also needs to reach `/notify/reply`. By default the daemon binds to `127.0.0.1` only; the inbound endpoint is therefore loopback-restricted out of the box. Setting `STAVR_NOTIFY_REPLY_BASE_URL` to a non-loopback host requires you to ALSO satisfy the daemon's bind-host auth gate (see `transports.ts` isLoopback check).

Rate limit: 30 requests/minute/IP on `/notify/reply` before any cid verification runs. Defense against brute-forcing correlation_ids.

### Audit

Every reply emits a `progress` event with `stage='notification_reply'` and detail JSON containing notification_id, source (webhook/telegram), source_label (ip or chat_id), action_id, action_kind, and target_id. Same audit trail as a dashboard click. Use the Streams page or query the event log directly:

```sh
sqlite3 ~/.stavr/events.db "SELECT * FROM events WHERE kind='progress' AND payload_json LIKE '%notification_reply%' ORDER BY persisted_at DESC LIMIT 20"
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Channel shows `NOT SET` after env vars set | Daemon not restarted | Restart via the per-platform service-control command (systemd/launchd/WinSW; see [README §Quick start](../README.md#quick-start)). PM2 `pm2 restart stavr` still works on deprecated legacy setups. |
| Channel shows `CONFIGURED · STALE` | No successful send yet (or last success >24h ago) | Click **[Test]** |
| Test push works but reply does nothing | `STAVR_NOTIFY_REPLY_BASE_URL` unset or unreachable | Set to a URL the phone can actually reach |
| Email "From" rejected | SPF/DKIM mismatch | Use a domain your SMTP relay accepts |
| Telegram button gives "Bad action" | callback_data truncated past 64 bytes | Shorten action_id (see `src/notify/channels/telegram.ts`) |
| Reply page shows "Already responded" | Notification was consumed (dashboard click, another device, or replay) | Re-trigger from dashboard if needed |
| 429 on `/notify/reply` | Rate limit (30/min/IP) | Wait one minute; investigate if not your own clicks |

---

## What's NOT in v0.6

- Slack / Discord channels (planned for v0.6.1)
- "Do not disturb" hours (planned for v0.6.1)
- Per-channel granular preferences (e.g. severity filters) — current behavior fans out every notification to every configured channel
- Federation (per ADR-035 phase 4)
- Notification history page (`/dashboard/notifications`) — the `notifications` table is queryable directly via SQLite for now

See `proposed/v0_6-notifications-bom.md` for the full BOM and open-questions log.
