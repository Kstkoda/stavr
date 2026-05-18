# BOM v0.6.X — Telegram operator directives (Steward inbound channel)

> **Status:** Draft. Implements operator → Steward routing via the existing Telegram bot. Closes the "can I message the bot with instructions and have Steward see them" gap.
>
> **Sensitivity:** `careful` — security-adjacent (authenticates by chat_id), audit-logged like every other reply path.
>
> **Depends on:** v0.6 notify fabric (PR #32 — Telegram poller + reply router + HMAC verify already exist on main). Builds on top of, doesn't replace.
>
> **Estimated size:** ~300 LOC implementation + ~100 LOC tests. One phase.

---

## Problem

The current Telegram poller only handles `callback_query` (inline button taps for decisions / scope extension). Free-text messages sent to the bot get dropped on the floor. Operator can approve a queued decision from their phone but can't say "Steward, look at recent OOM errors and propose a fix" — there's no path from a typed Telegram message into the daemon's planning loop.

## Solution

Extend the Telegram poller to also handle `message` events. Authenticate by `STAVR_NOTIFY_TELEGRAM_CHAT_ID` match (only the configured operator can issue directives). Route a small command grammar into the event log as `operator_directive` events that the Steward subscribes to and consumes on its next planning cycle.

## Command grammar

| Telegram message | Effect | Audit event kind |
|---|---|---|
| `/steward <text>` | Post `operator_directive` event with payload `{text, source: "telegram"}` | `operator_directive` |
| `/scope <text>` | Post `operator_scope_request` event (Steward proposes a scope shape, operator confirms via the existing trust-scope flow on dashboard) | `operator_scope_request` |
| `/status` | Reply inline with daemon health + active worker count + last 3 decisions | (no event — read-only) |
| `/ask <text>` | Synchronous one-shot: Steward replies with a short answer (no scope grant). Useful for "what's running?" / "any pending decisions?" | `operator_ask` |
| anything else | Reply with a help message listing the commands above | (no event) |

## Authentication

- Sender must match `STAVR_NOTIFY_TELEGRAM_CHAT_ID`. Any other sender (the bot accidentally being added to a group, a spoofed message, a different chat) is silently dropped — log a `telegram_directive_rejected` event with chat_id but never reply (avoids leaking that the bot is alive).
- No HMAC needed (the chat_id check is the auth; Telegram's transport security covers the rest).
- Rate-limit: 30 directives per minute per chat_id (same limiter as `/notify/reply`).

## Steward consumption

- Steward agent subscribes to `operator_directive` event kind (in addition to its existing subscriptions).
- On receipt, the directive text is appended to the next planning cycle's prompt prefix as `## Operator directive (telegram, <timestamp>)\n\n<text>\n\n---\n`.
- Steward MAY reply via Telegram with its plan/response. Replies go through the existing notifier path (one `Notification` row, one `dispatch` via Telegram channel).
- For `/ask`, the Steward path is synchronous: post the question, wait up to 30s for Steward to reply, deliver to Telegram, fall back to "Steward not responding" message on timeout.

## Files

### New

- `src/notify/telegram-directives.ts` — command parser + dispatcher (~150 LOC)
- `tests/notify/telegram-directives.test.ts` — parser unit tests + auth tests (~100 LOC)

### Modified

- `src/notify/telegram-poller.ts` — add `message` event handling alongside existing `callback_query` (~50 LOC change)
- `src/steward/agent.ts` (or wherever the planning loop is) — subscribe to `operator_directive` + `operator_ask` event kinds, fold directive text into the prompt prefix (~50 LOC change)
- `src/notify/reply-router.ts` — extend the audit log helper to cover the new event kinds (~20 LOC change)
- `docs/notifications.md` — add a Telegram-directives section with the command grammar (~30 lines)

## Open questions

1. **Should `/ask` block the poller while waiting for Steward?** Probably no — fire-and-forget with a correlation_id so the Steward's reply finds the right Telegram message. Decision: fire-and-forget; correlation via the existing `operator_ask` event id.
2. **Should non-operator messages reply with a generic "unauthorized" or silent drop?** Silent drop. The bot's existence shouldn't be confirmable to non-operators (defense in depth, even if the bot username is guessable).
3. **What about group chats?** v0.6.X scope: single-chat only (the configured `STAVR_NOTIFY_TELEGRAM_CHAT_ID`). Group support deferred.
4. **Backpressure if Steward is busy?** Steward already has its own queue (event-driven). Directives enter that queue. No new backpressure logic needed.
5. **Audit retention?** Standard event retention (configurable). Directive events count against the operator's event log size.

## Acceptance

- Send `/steward investigate the May-15 zombies` from operator's Telegram → daemon log shows `operator_directive` event with that text → Steward picks it up next cycle → Steward's response appears in operator's Telegram.
- Send `/steward ...` from a non-configured chat_id (e.g., create a second bot client and message from there) → silent drop → `telegram_directive_rejected` event in log, no Telegram reply.
- Send `/status` → inline reply with health snapshot within 5 seconds.
- Send rubbish like `hello` or `xyz` → help-message reply listing the commands.
- 30+ directives in 60 seconds → rate-limit kicks in, replies "rate limit hit, try again in N seconds."

## Bonus: extend outbound notification coverage

While we're in the notify fabric, plug the missing trust-scope coverage. Currently `src/notify/wiring.ts` taps `decision_request` + `trust_scope_revoked` + `trust_scope_completed` + `worker_terminated` but NOT `trust_scope_proposed`. Result: when cowork-claude or any actor proposes a scope, operator only sees it on the dashboard — no phone ping. Adds friction every time we ask for permission.

Fix: extend the wiring filter to include:

| Event kind | When | Severity | Inline buttons |
|---|---|---|---|
| `trust_scope_proposed` | Any actor calls `trust_scope_propose` | `warn` | [Grant] [Reject] |
| `host_exec_denied` | An action hit the host_exec allowlist deny | `warn` | [View audit] (link only — no remediation button) |
| `worker_dispatch_failed` | A worker spawn failed (port collision, AV block, etc.) | `crit` | [View logs] |
| `cc_quota_warning` | CC quota at 90% / 100% | `warn` | [View status] |

Same auth model as the existing reply path: HMAC-signed correlation_ids, 5-min TTL, one-shot consume. The [Grant] button on `trust_scope_proposed` routes to `TrustStore.grant(scopeId, source: "notify:telegram")` — same audit shape as a dashboard click. Reject routes to `TrustStore.reject` (currently no-op; logs a `trust_scope_rejected` event).

Scope of this bonus: ~80 LOC in `src/notify/wiring.ts` + ~50 LOC in `src/notify/reply-router.ts` (handle the new action_ids) + ~40 LOC of tests. Folds into the same PR as the Telegram-directives work since both touch the notify fabric.

## What's NOT in this BOM

- Slack / Discord / email equivalents — Telegram-only for now (the other channels have less natural fit; Discord could come later if asked).
- Multi-chat / group-chat support.
- Steward → operator-initiated outbound (Steward asks operator a question). The path exists in the v0.6 decision-request flow already.
- Voice messages or attachments.

## Notes for CC

- Don't add a new MCP tool for this. It's an internal subsystem — Telegram poller already exists; just extend it.
- Reuse the existing `RateLimiter` from `src/notify/rate-limit.ts`. Don't roll a new one.
- Reuse the existing HMAC + correlation_id machinery for the reply path; the directive itself doesn't need HMAC (chat_id auth is sufficient) but the Steward → Telegram reply does.
- Tests: shape tests for the parser (the 5 grammar rows above), auth tests (rejection of non-operator chat_id), rate-limit test, fire-and-forget /ask correlation test.
