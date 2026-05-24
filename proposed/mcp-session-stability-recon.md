# MCP Session Stability — Recon

**Branch:** `fix/mcp-session-stability`
**Sensitivity:** careful
**Status:** RECON COMPLETE — STOPPED for operator review before any fix.
**Date:** 2026-05-23

---

## TL;DR

Two issues, only loosely related, share this branch because the operator
asked them to be folded together:

1. **In-flight long-blocking MCP calls can be silently lost.** stavR's
   `StreamableHTTPServerTransport` is constructed **without an `eventStore`**
   (transports.ts:782–784), so the GET SSE stream and the per-POST response
   stream are **non-resumable**. If the underlying connection drops while a
   tool handler is blocked (`await_decision`, long `github_*` writes), the
   SDK client cannot resume — `last-event-id` is meaningless because no
   priming events with IDs were ever emitted. The pending client-side
   `Client.request` promise hangs forever; the server-side tool promise
   eventually resolves but the result has nowhere to go.

2. **Retention is silently broken for 5 event kinds**, including the
   2-second-cadence `daemon_host_headroom`. ~43k/day of headroom events
   accumulate in the `unknown` bucket and never prune. Quick fix; bundles
   well with this work because one of the missing kinds is
   `mcp_oneshot_cleanup` which the operator flagged.

The exact **~15-minute** cadence the operator observes is **not visible in
stavR's code**. stavR's server has no per-session TTL, no idle reaper on
sessions, and no keep-alive heartbeat on either stream. The trigger is
external — most likely client-side or network-stack-side (see §4 for
candidates and a verification plan).

---

## 1. What we know about session recycling

### Where the recycle is emitted

- The `MCP session ${id} connected` log line is at **transports.ts:858**,
  inside the `/mcp` handler's "new session" branch. It fires when:
  - The incoming POST has no `Mcp-Session-Id` header AND its JSON-RPC
    method is `initialize` (transports.ts:752–784), and
  - The SDK transport adopts a session id after `handleRequest` returns
    (transports.ts:855).
- So this log is **client-driven**: a fresh log line means a client just
  performed a fresh `initialize`, not that the server kicked anyone.

### Where session teardown happens server-side

stavR has 4 paths that delete an entry from `sseSessions`. None of them is
on a 15-minute clock:

| Path | Where | Trigger |
|---|---|---|
| `transport.onclose` | transports.ts:787–840 | SDK transport detects socket close |
| 30s defensive sweep | transports.ts:816–839 | onclose fired but map entry stuck |
| 5-min janitor | transports.ts:1064–1101 | walks sessions, removes `_writable.destroyed` |
| DELETE /mcp | transports.ts:682–720 | client-driven explicit termination |

There is **no `setInterval` in the daemon process that runs on a
15-minute cadence and could close sessions**. Closest periodic intervals:

- 2s — `daemon_host_headroom` poller (host-headroom-poller.ts:200)
- 5s — load shedder, dashboard cache TTL
- 25s — `/events/sse` (raw tail) heartbeat — separate stream, not /mcp
- 60s — `mcp_oneshot_cleanup` flush throttle, Ollama models refresh
- 5min — SSE session janitor
- 60min — retention sweep

### What the SDK server transport does about timeouts

`@modelcontextprotocol/sdk@latest`'s `StreamableHTTPServerTransport` is a
thin wrapper over `WebStandardStreamableHTTPServerTransport` via
`@hono/node-server`'s `getRequestListener`. Grep over the entire SDK server
transport returns **no `setInterval`, no `setTimeout`, no `keepAlive`** —
it does not heartbeat the GET stream, does not idle-reap, does not
session-TTL.

### What the SDK client transport does about timeouts

`StreamableHTTPClientTransport` defaults:

```js
DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
  initialReconnectionDelay: 1000,
  maxReconnectionDelay: 30000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 2
}
```

(`node_modules/.../client/streamableHttp.js:6–11`)

Critical: **`maxRetries: 2`**. After 2 failed reconnection attempts on the
GET stream, the client gives up and emits `onerror`. shim.ts wraps that
into its own reconnect ladder (1s → 5min, give-up after 1h), so the
shim-mediated path is robust.

### Why "~15 minutes" then?

Not from stavR. Likely candidates, in rough order of plausibility:

1. **Client idle / undici `bodyTimeout`** — undici default is 5 min, but
   any wrapper that bumped it to ~15 min would match the symptom.
   Cowork's MCP client config is the place to check.
2. **OS-level TCP keepalive** — Windows default is 7200s (2h) — not 15.
   Loopback (127.0.0.1) bypasses NAT, so router idle isn't the cause.
3. **A Cowork-side session lifecycle policy** — many MCP hosts recycle
   sessions on a fixed schedule for sanity. 15 min is a common pick.
4. **Express/Node `server.headersTimeout` / `server.requestTimeout`** —
   defaults are 60s / 5min, not 15. Could be a custom config we missed.

**Verification step the operator should run before any fix lands:** grep
`pm2 logs stavr` for the gap between consecutive `MCP session connected`
lines from the same client agent. If the gap is **exactly** 15 min ±
seconds, it's a fixed timer (client-side, almost certainly Cowork's). If
the gap drifts ±minutes, it's idle-driven and one of the network stack
timeouts.

---

## 2. What happens to an in-flight long-blocking call when the session dies

Walking the `await_decision` flow (tools/decisions.ts:31–105):

1. Client `Client.request` → posts `tools/call` body, awaits the SSE
   response on the POST.
2. Server's tool handler runs synchronously up to step 3.
3. **`broker.store.createDecision` writes the row** (decisions.ts:43–50),
   then publishes `decision_request`. So as long as we got this far, the
   row exists and the dashboard sees it.
4. Server `await broker.store.awaitDecisionResponse(corrId, timeoutMs)` —
   blocks the tool promise. Default cap 30 min.
5. The handler is held inside `await session.transport.handleRequest`
   (transports.ts:851).

### What can break

**A. POST-side disconnect (response carrier dies mid-flight):**
- The SDK server sends the response over an SSE stream on the POST
  response. Without an `eventStore` configured, **the stream is not
  resumable**.
- Client SDK `_handleSseStream` (client/streamableHttp.js:158–254): on
  graceful end, `needsReconnect = canResume && !receivedResponse`. Without
  a priming event with an ID, `hasPrimingEvent === false` and
  `canResume === false`. The reader exits cleanly. **No reconnect is
  attempted.** The pending request promise hangs.
- Server side: when the operator eventually responds in the dashboard,
  `awaitDecisionResponse` resolves, the tool returns `toolJson({...})`,
  the SDK tries `transport.send(message)` — but the response stream is
  closed. Write fails silently or throws into `transport.onerror`. The
  decision is marked responded in the DB but the client never sees it.

**B. GET-side disconnect (server→client notifications channel dies):**
- The standalone GET stream IS reconnectable by spec (`isReconnectable =
  true` at the call site in client/streamableHttp.js:107).
- But: same store-less server, so resumption from `last-event-id` yields
  whatever the server feels like (no replay). Notifications since the
  drop are **lost**, even though a fresh GET stream re-opens.
- For `await_decision` specifically this doesn't matter — the result
  comes back on the POST stream (A), not the GET stream.

**C. Brand-new POST while the client is mid-recycle:**
- If the client is in the gap between sessions when the operator triggers
  a new gated call, the client may send with a stale `mcp-session-id`.
  Server returns **404** (per spec — and stavR delegates that to the SDK
  in transports.ts:752–760). Client SDK throws back through
  `Client.request`. Cowork's caller sees an error — but if Cowork
  swallows it (no retry queue), this matches "no decision created, no
  error in stavR logs".

**D. Client gives up after `maxRetries: 2`:**
- On a GET-stream disconnect storm during the recycle window, the SDK
  client gives up after 2 reconnect attempts. shim.ts wraps and retries,
  so shim-mediated traffic survives. Direct StreamableHTTPClient users
  (Cowork?) don't get that safety net.

**The operator's observed "no decision created, no error logged" lines
up best with C** — the call landed in the recycle gap and never reached
the server's tool handler. The "intermittent" qualifier fits: most calls
miss the gap, some land in it.

---

## 3. The `mcp_oneshot_cleanup` path

(transports.ts:172–202, 876–892)

A `mcp_oneshot_cleanup` fires when an `/mcp` POST creates a fresh
`McpServer` + `StreamableHTTPServerTransport` for the request, but the
transport never adopts a session id. This happens in two ways:

- **SDK rejected the request** (e.g., schema violation), so
  `handleRequest` returned without setting `transport.sessionId`.
- **Stateless one-shot** (`initialize` was attempted, the SDK closed the
  transport before adopting an id, etc.).

The cleanup branch (transports.ts:876–892) explicitly tears down the
fresh McpServer+transport pair so the broker doesn't retain the object
graph (the v0.6.x memory-leak fix). It calls `oneshotCleanup.tick()`,
which aggregates and emits one `mcp_oneshot_cleanup` event per 60s.

### Volume math

The cleanup emits **at most once per 60 seconds** — that's 1440/day max.
5400+ accumulated events implies ~3.75 days of continuous traffic where
at least one one-shot fired per minute. Consistent with Cowork polling
`tools/list` or similar without holding an initialized session.

### Is it the recycle driver?

**No.** `mcp_oneshot_cleanup` fires for requests that **never adopted a
session id**. The "MCP session connected" log fires only when a new id
**was** adopted. These are disjoint code paths (transports.ts:855 vs.
transports.ts:876). Eliminating the one-shots would not change the
recycle cadence.

But: the v0.6.x reject-non-initialize gate (transports.ts:766–781)
already rejects most stateless one-shots. The remaining cleanup volume
is plausibly the upstream client mis-behaving — could be worth a
follow-up to identify which actor (correlation_id is captured) and
file a ticket against that side.

---

## 4. Retention gap — confirmed

`src/observability/retention.ts` partitions kinds into
`OPERATIONAL_KINDS` (7d / 100k-row cap) and `AUDIT_KINDS` (90d), with
anything else classed `unknown` and **preserved with a warning log**.

The kinds the operator named are all genuinely missing from both sets:

| Kind | Emit rate | Source |
|---|---|---|
| `daemon_host_headroom` | every 2s | host-headroom-poller.ts:200 |
| `mcp_oneshot_cleanup` | ≤ 1/min | transports.ts:189 |
| `peer_joined` | per peer-arrival | federation/reporter.ts:33 |
| `capability_override_changed` | per mutation | transports.ts:1852, 1875 |
| `host_ceiling_os_cap` | once at boot | daemon.ts:509 |

**At 43,200/day, `daemon_host_headroom` alone explains the bulk of the
unprunable 47k.** The other four are low-volume but should still be
classified for hygiene.

### Proposed classification

| Kind | Class | Rationale |
|---|---|---|
| `daemon_host_headroom` | operational | Pure telemetry, 2s cadence |
| `mcp_oneshot_cleanup` | operational | Aggregated heartbeat, no audit value |
| `peer_joined` | **audit** | Federation lineage — who joined when |
| `capability_override_changed` | **audit** | Policy mutation, must be preserved |
| `host_ceiling_os_cap` | **audit** | Boot-time policy install record |

`peer_left` is also probably emitted by `federation/reporter.ts` — check
during the fix and classify symmetrically.

---

## 5. Proposed fix plan (NOT implementing yet — awaiting operator green-light)

Each phase ends with a per-phase commit, `git commit -s`, status check
before/after, `npm test` + `npm run build` green.

### Phase 1 — Retention classification (low risk, immediate value)

- Add the 5 confirmed kinds + `peer_left` to the correct sets in
  `src/observability/retention.ts`.
- Update or add tests in `tests/observability/retention.test.ts` to
  assert each kind classifies correctly.
- One commit, ~20 line diff, no behaviour change beyond retention.

### Phase 2 — Restore in-flight call durability (the core fix)

Two complementary pieces. Implement together so the fix is observable end-to-end.

**2a — Server-side: wire up an `eventStore` on `StreamableHTTPServerTransport`.**
The SDK supports an in-memory `EventStore` that captures emitted events
keyed by `streamId` + monotonic `eventId`. On reconnect with
`last-event-id`, the SDK replays whatever the store still has. We need:
- An in-memory implementation bounded by (count, age) — e.g., 256 events
  or 5 minutes per stream, whichever fires first.
- Wired in `transports.ts:782` where we currently pass only
  `sessionIdGenerator`.

**2b — Server-side: heartbeat the per-POST SSE stream.**
Even with `eventStore`, idle disconnects are still expensive. Add a
periodic SSE comment (`:keepalive\n\n`) every ~20s while a tool handler
is blocked. Open question: does the SDK transport expose a hook for this,
or do we need to write through `transport.send` with a noop notification?
**Spike before committing.** If the SDK gives us nothing, alternative is
to send a low-cost progress notification.

**Risk:** server-side eventStore retains events in memory per session.
We need to bound it tightly — uncapped this is exactly the kind of
memory-leak the v0.6.x work fixed. Bound on creation, not via janitor.

### Phase 3 — Client-side reconnect safety net (defensive)

If Cowork is the primary client and it's recycling at 15 min, no amount
of server-side resumability matters unless Cowork's MCP client cooperates.
But we can:

- **Document the requirement** in `docs/integrating-mcp-clients.md` (new
  file or section): MCP clients connecting to stavR for long-blocking
  tool calls MUST either (a) use the standalone GET stream with
  `last-event-id` resumption, or (b) keep their session id stable across
  recycles and re-POST `initialize` cleanly.
- **Expose a server-side hint** — when the operator's policy classes a
  decision as "long-blocking" (>5 min), `await_decision` could return
  early with a correlation_id and require the caller to poll
  `get_events(correlation_id=..., kind=decision_response)`. This sidesteps
  the long-blocking-call problem entirely. Big API change — flag for
  separate BOM if we want to go this way.

### Phase 4 — Observability for the failure mode

- Add a counter for "tool response delivery failed" (response computed
  but transport.send threw / silently dropped).
- Add a histogram for "tool handler duration when transport closed
  before send" — surfaces the exact long-call cases that this fix is
  meant to protect.
- Wire both into the `/dashboard/diagnostics/engine` page.

---

## 6. Open questions for operator before Phase 2 starts

1. **Is Cowork the primary client experiencing the loss?** If so, can
   we instrument Cowork-side to log `Client.request` start + end for
   `await_decision`? That confirms whether the call ever arrived.
2. **Does the operator want Phase 3b** (early-return + poll pattern)
   for long-blocking tools? Cleaner architecturally but bigger change.
3. **For the eventStore bound:** 256 events / 5 min per stream is a
   guess. If the operator has historical sense of how chatty a typical
   stream is, that pins the number better.
4. **The 15-min cadence verification:** does the operator want me to
   write a small log-parser to confirm fixed-interval vs. idle-driven
   before Phase 2 starts? Cheap, reduces risk of fixing the wrong layer.

---

## 7. Files touched in this RECON (none yet)

Branch `fix/mcp-session-stability` was created from `main` (commit
fd71042) and is currently identical to it. No code changes pending.

STOP.
