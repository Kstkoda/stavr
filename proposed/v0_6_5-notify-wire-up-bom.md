# stavR · v0.6.5 — Notification wire-up + generic `notification_requested` event kind

> Small PR closing the open follow-ups from PR #32 + PR #33 plus a small architectural addition that lets ANY party (Steward, Cowork-Claude, federated peers) trigger notifications via the event bus. Sits between v0.6 and v0.7; tiny surface, high leverage.

**Estimated wall-clock**: 3–4 hours CC sequential. Single PR.

**Sensitivity**: `routine` per CLAUDE.md section 9. Wire-up of already-shipped code + one additive event kind. Standard autonomous flow.

**Stop conditions**: end of any phase if `npm test` regresses (must stay ≥873 passing per current baseline post-PR-#33), `npm run build` fails, or any negative-path test demonstrates `/notify/reply` accepts unauthenticated requests OR `notification_requested` events can be published with unrestricted source_agent attribution.

**Do NOT pause for approval** between phases. Open PR at end of P4.

---

## Why this matters

v0.6 shipped the notification fabric across three PRs (#32 outbound + #32 inbound + #33 UI). Two functional gaps remain (CC flagged both in PR #33 body):

1. **`/notify/reply` HTTP handler is NOT mounted into the Express app.** Inbound webhook code exists (`src/notify/inbound.ts`); the route registration in `src/transports.ts` is missing. Reply links in notifications currently 404.

2. **TelegramPoller is NOT started from the daemon lifecycle.** Polling code exists (`src/notify/telegram-poller.ts`); the daemon startup hook to call `poller.start()` is missing. Telegram bot won't respond to inline button taps.

Without these, the entire inbound flow is dead — outbound notifications go out, but the operator can't reply through any channel. The dashboard is the only response surface.

There's also a small architectural addition that fits naturally in the same PR (per design conversation 2026-05-17):

3. **No generic `notification_requested` event kind.** The notifier subscribes to specific event kinds (decision_required, scope_expired, worker_completed, etc.) tied to daemon flows. There's no way for the **Steward subprocess** (or Cowork-Claude, or a federated peer) to say "operator should hear about X" without being one of those specific flows. This is the missing piece per ADR 040 §Inter-party contracts — Steward should be able to use the Engine's notify fabric without owning channel logic.

Adding `notification_requested` to the event taxonomy + notifier subscription costs essentially nothing extra and unlocks every party's ability to reach the operator.

---

## Reference reading

1. `CLAUDE.md` — invariants (tests-are-derivative + never-lose-files + sensitivity flag + status-before-git-op)
2. `adr/040-three-process-architecture.md` — three-party model defining Engine ↔ Steward contract
3. `proposed/v0_6-notifications-bom.md` — original notifications BOM (the unwired follow-ups originated here)
4. `src/notify/inbound.ts` — `/notify/reply` handler (already implemented, needs mounting)
5. `src/notify/telegram-poller.ts` — `TelegramPoller` class (already implemented, needs lifecycle hook)
6. `src/transports.ts` — Express app wiring (where the new route mounts)
7. `src/server.ts` — daemon lifecycle (where the TelegramPoller starts/stops)
8. `src/types/events.ts` (or wherever the event taxonomy lives — verify location during P0) — for adding `notification_requested` kind
9. `src/notify/wiring.ts` — notifier's broker subscription handler (where the new subscription handler is added)

---

## Don't touch

- The notifier core (`src/notify/notifier.ts`) — wiring is sufficient, no internals change
- Channel implementations (`src/notify/channels/*.ts`) — they're correct
- `src/notify/correlation.ts` — HMAC signing untouched
- `src/notify/rate-limit.ts` — rate limit untouched
- `src/persistence.ts` schema — no new tables; existing `notifications` and `notification_channels` tables cover this
- `src/security/*` — no trust scope changes
- Other dashboard pages, MCP tools, worker code, steward-agent subprocess code — all out of scope
- `ecosystem.config.cjs`, `package.json` deps — no new deps

---

## Hard rules

1. **Tests are derivative** — if existing event-bus tests assert on the registered event-kind enum size, extend the assertion
2. **Never lose files** — `stat -c %s` + `tail -5` verify before commit for any file >15KB (transports.ts already is)
3. **Skärp och hängslen: status before every git op** (CLAUDE.md section 8) — `git status --short` + `git symbolic-ref HEAD` before every mutating command. Both checks, every time
4. **`/notify/reply` MUST be loopback-or-authenticated** — registered under the same mount as `/dashboard` (loopback-only in single-operator mode). Any change to the mount point requires explicit operator approval (this BOM does not authorize that change)
5. **`notification_requested` events MUST be source-attributed** — the event's `source_agent` field is required (not nullable); the notifier MUST include `source_agent` in the rendered notification body so operator can see which party requested it
6. **TelegramPoller MUST handle the "not configured" case** — if `STAVR_NOTIFY_TELEGRAM_BOT_TOKEN` is unset at daemon start, poller silently no-ops (logs once, doesn't crash); no environment-var assertion that fails startup
7. **DCO -s, per-phase commits, push at end of each phase. Single PR.**

---

## P0 · Pre-flight (Kenneth, before CC kicks off)

~3 min. Operator confirms:

1. `git status` clean on `main`; PR #33 has been merged into main (look for the `feat(dashboard): notification channels UI` commit at HEAD)
2. `npm test --run` baseline = 873 passing, 1 skipped (matches PR #33 baseline)
3. Find the event-kind taxonomy: typically in `src/types/events.ts` or `src/persistence.ts` schema constants. CC's P3 should grep for the existing kinds (`decision_required`, `scope_expired`, etc.) and add `notification_requested` alongside them
4. Dispatch CC with this brief

---

## P1 · Mount `/notify/reply` HTTP route (1h)

**Files**:
- `src/transports.ts` — register the route inside the dashboard mount
- `tests/transports/notify-reply.test.ts` (new) — integration tests confirming the route is reachable

### Sub-tasks

1. Import `createInboundHandler` (or whatever the inbound.ts module exports) at the top of `transports.ts`
2. Inside the dashboard mount block, register: `app.get('/notify/reply', inboundHandler)`
3. The handler needs a `deps` parameter that includes:
   - `secret`: env value `STAVR_NOTIFY_SECRET`
   - `notifier`: the active Notifier instance (passed in from `getOrCreateNotifier`)
   - `router`: the ReplyRouter instance (which itself needs `broker.store` and `TrustStore` from existing daemon state)
4. Add startup guard: if `STAVR_NOTIFY_SECRET` is unset, mount a 503 placeholder (`app.get('/notify/reply', (_, res) => res.status(503).send('notification fabric disabled'))`)

### Acceptance

- `GET /notify/reply?cid=valid_signed_cid&action=approve` triggers ReplyRouter.route → action executes via existing TrustStore methods
- `GET /notify/reply?cid=invalid` returns 401 (handled by inbound.ts)
- `GET /notify/reply?cid=expired` returns 410 (handled by inbound.ts)
- `GET /notify/reply?cid=already_consumed` returns 410 (handled by inbound.ts)
- `GET /notify/reply` with fabric disabled (no SECRET) returns 503
- 4+ new integration tests passing

### Commit
`feat(notify): mount /notify/reply HTTP handler in transports`

---

## P2 · Start TelegramPoller from daemon lifecycle (1h)

**Files**:
- `src/server.ts` (or wherever the daemon lifecycle hook lives — see CC pre-flight)
- `tests/server/telegram-poller-lifecycle.test.ts` (new)

### Sub-tasks

1. Inside the daemon startup function (likely `startDaemonForeground` or similar), after the notifier is created, check if Telegram channel is configured
2. If configured, create + start a `TelegramPoller` instance with the Telegram channel's config
3. Inside the daemon shutdown function, call `poller.stop()` before broker shutdown
4. Add startup log line: "telegram poller started" (when polling begins) OR "telegram poller skipped (not configured)" (when not)
5. Handle reload/restart: if SIGHUP arrives (Linux/macOS) or config-reload event, restart the poller

### Acceptance

- When daemon starts with Telegram env vars set, poller starts and logs the line
- When daemon starts without Telegram env vars, poller is skipped (no error)
- When daemon shuts down, poller.stop() is called before broker shutdown
- 3+ new integration tests passing (start with config, start without, shutdown order)

### Commit
`feat(notify): start telegram poller from daemon lifecycle hook`

---

## P3 · Add `notification_requested` event kind (1h)

**Files**:
- `src/types/events.ts` (or wherever the event taxonomy lives — verify in P0)
- `src/notify/wiring.ts` — extend the broker subscription handler
- `tests/notify/notification-requested.test.ts` (new)

### Sub-tasks

1. Add `'notification_requested'` to the event-kind union/enum
2. Define the payload shape: `{ severity: 'info'|'warn'|'crit', title: string, body: string, actions?: NotificationAction[], correlation_id?: string }`
3. In `wiring.ts`, extend the broker.onEvent handler: when `event.kind === 'notification_requested'`, construct a Notification from the payload and call `notifier.notify(...)` directly (mirrors how existing event kinds are handled)
4. The notification body MUST include the originating actor: prepend `[from {event.source_agent}] ` to the body before dispatch
5. Schema validation: payload must be present + must have severity + title + body (Zod or similar — match existing event validation patterns)
6. Negative test: emit_event with missing payload fields → rejected

### Acceptance

- `emit_event { kind: 'notification_requested', source_agent: 'cowork-claude', payload: { severity: 'info', title: 'X', body: 'Y' } }` triggers a notification to all configured channels
- Body of the notification includes `[from cowork-claude] Y` (or similar source attribution)
- Schema validation rejects malformed payloads
- 4+ new tests passing (happy path, source attribution, schema validation, multiple actors)

### Commit
`feat(notify): notification_requested event kind for cross-party operator alerts`

---

## P4 · Docs + cross-link from ADR 040 (0.5h)

**Files**:
- `docs/notifications.md` — add operator-facing section on "Who can send notifications" listing the three paths (decision-triggered, scope-triggered, work-triggered, and now generic `notification_requested`)
- `CHANGELOG.md` — v0.6.5 entry
- `adr/040-three-process-architecture.md` — small clarification under "Engine ↔ Steward" contract: Steward CAN call `notify` indirectly via `notification_requested` event kind

### Acceptance

- Docs include worked example: "How Steward (or any party) sends an operator alert"
- CHANGELOG entry lists all three fixes (reply route, poller lifecycle, notification_requested kind)

### Commit
`docs(notify): wire-up + generic notification kind + ADR 040 clarification`

### Open PR

`feat(notify): wire reply route + telegram poller lifecycle + notification_requested event kind (closes v0.6.5)`

Body must include:
- Description of all three fixes
- Test count (873 → 887+ passing target)
- Worked example of Steward sending a notification

---

## Budget

- **Time**: 3–4h CC sequential, single PR
- **API cost**: ~$3–5 (small surface, mostly wiring)
- **LOC change**: ~250–400 net across `src/transports.ts`, `src/server.ts`, `src/types/events.ts`, `src/notify/wiring.ts`, new tests
- **Token cap**: 400k
- **New deps**: none
- **Schema change**: none (event kind is a TypeScript-level addition; existing event row schema accommodates new kinds)

---

## Footgun appendix

1. **`/notify/reply` mount path collision** — if registered at top level, conflicts with potential future routes. Mount under `/dashboard/` parent (operator-only loopback per existing convention) so the same auth posture applies.
2. **TelegramPoller long-poll loop must not block daemon shutdown** — poller's `stop()` must `controller.abort()` the in-flight fetch and resolve quickly; otherwise SIGTERM → daemon hangs 30s waiting on poller's HTTP request to time out.
3. **`notification_requested` source spoofing** — the event's `source_agent` is operator-trusted at write time (the publishing actor sets it). Don't let untrusted MCP calls forge `source_agent: 'operator'`. P3 acceptance test: confirm that an `emit_event` call's `source_agent` matches the calling MCP client's identity (or at least isn't `'operator'` unless the call comes from the operator's dashboard session — out of scope to fully enforce here; flag as v0.7 candidate).
4. **Notification flood from `notification_requested`** — a buggy Steward could fire 1000 notifications/sec. Notifier has no per-source rate limit today. Out of scope to add here; document as known limitation; consider adding `per-source-rate-limit` to notifier in a future PR if it becomes a real problem.
5. **Telegram poller offset persistence** — TelegramPoller tracks the `update_id` offset to avoid re-processing messages on restart. Offset MUST persist across daemon restarts (file or DB). Verify P2 implementation reads + writes the offset correctly.
6. **Reply route GET vs POST** — using GET means correlation_id is in the URL → leaks to browser history. Mitigated by one-shot consumption (replay-protected). Worth a comment in code reminding operators to either click links from email/notification once OR clear browser history if paranoid.
7. **`notification_requested` event volume in audit log** — every operator notification will now be a persisted event in the events table. ADR 030 retention applies. If volume gets noisy, consider adding a `non-persistent` flag to the payload (notify but don't persist the event) — defer to follow-up.

---

## Open questions (FLAGGED — do not pre-answer)

### §1 — Should `notification_requested` events themselves be displayable in `/dashboard/streams`?

Yes (they're events), but the live-tail might get noisy if Steward sends many. Default: include in streams (no special filter), let operator filter via the existing stream filter UI when v0.8 audit history lands.

### §2 — Should the notifier de-duplicate identical `notification_requested` events within a short window?

E.g., Steward fires the same alert 3 times in 30 seconds. Operator probably wants ONE notification, not three. Default: not in v0.6.5. Add `dedupe_key` to payload as an optional field in v0.7+ if requested.

### §3 — Should `notification_requested` payload accept a `defer_until` timestamp?

E.g., "send this notification only if not cleared by 09:00 tomorrow." Useful for non-urgent alerts. Default: not in v0.6.5. Future v0.7+ candidate.

### §4 — When the daemon shuts down with a queued notification still being dispatched, what happens?

Today: in-flight notifications are awaited (~5s timeout per Notifier). For `notification_requested`, same behavior. If operator wants stricter guarantees (e.g., "always persist before dispatching"), add a `persistent: true` payload flag in v0.7+.

---

## Run prompt for CC (paste at start)

```
Read CLAUDE.md first. Then read proposed/v0_6_5-notify-wire-up-bom.md and execute P0-P4 sequentially.

Sensitivity: routine. Standard autonomous flow.

Skärp och hängslen: run `git status --short` + `git symbolic-ref HEAD` BEFORE every mutating git command. Verify branch + working tree match intent. (CLAUDE.md section 8.)

Work on a NEW branch: `git checkout -b feat/v0.6.5-notify-wireup` from latest main. Never commit to main. Never push to feat/v0.6-notifications-ui (already merged).

Rules:
- One commit per phase, DCO sign-off (-s)
- Don't pause for approval between phases
- For any file >15KB after edit, run `stat -c %s file` + `tail -5 file` BEFORE git add
- `npm test` must pass after every commit
- After P4 opens PR, output a final delta report and STOP. Don't auto-merge.

The brief is self-contained. Open questions §1-§4 are flagged — pick the conservative default during implementation and note in PR body, don't block.

Go.
```

---

## End of brief
