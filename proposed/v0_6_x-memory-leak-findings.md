# Phase 0 findings — v0.6.x memory leak

**Branch:** `fix/v0.6.x-memory-leak`
**Date:** 2026-05-19
**Status:** Smoking gun identified; matches BOM suspect #2/#4 (per-request McpServer +
broker subscription leak). Suspect #1 (third-party SDK) is the proximate retainer
but the leak is OUR cleanup omission, not an SDK bug.

---

## Smoking gun

`src/transports.ts:447-562` — the `app.all('/mcp', …)` handler creates a fresh
`McpServer` + `StreamableHTTPServerTransport` whenever an incoming request has no
matching `mcp-session-id` (line 467: `if (!session)`). `createSwitchServer(broker)`
(line 476 + `src/server.ts:199-256`) eagerly calls **`broker.registerSession(sessionId,
server)`** — registering the server in the broker's `subscribers` Map keyed by
`handle.sessionId` (a freshly-minted UUID, distinct from the transport's
`sessionId`).

After `handleRequest` (line 536) returns, the code only registers the session into
`sseSessions` (and only then schedules cleanup via `transport.onclose`) **if the
transport actually adopted a session id** (line 540: `if (isNew &&
session.transport.sessionId)`). For stateless one-shot POSTs — e.g. `tools/list`
or `ping` without an `initialize` handshake, or malformed requests the SDK
rejects with 400 — `session.transport.sessionId` stays `undefined`. The handler
falls off the end without touching `broker.removeSession(handle.sessionId)` or
`transport.close()`.

### Why this leaks the entire McpServer object graph

1. `broker.subscribers` (Map) **retains the McpServer** under `handle.sessionId`.
2. The MCP SDK's `Protocol.connect()`
   (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:215-225`)
   wires `_transport = transport`, so the **server retains the transport**.
3. The transport's `_webStandardTransport` carries internal Maps
   (`_streamMapping`, `_requestToStreamMapping`, `_requestResponseMap`) and the
   captured response/request objects from `handleRequest`.
4. `transport.onclose` is set on line 478 with a closure capturing `transport`,
   `handle`, a 30s `setTimeout` (`sweepHandle`), and references to `sseSessions`
   + `broker` — but **onclose only fires when somebody calls `transport.close()`
   or the SDK explicitly invokes the close path**. The SDK does NOT call close
   at the end of a one-shot `handleRequest`; close is for the whole transport
   lifecycle. Without an explicit cleanup, that callback never runs.
5. The 30s `sweepHandle` (line 507) is registered **inside** the onclose
   callback — so it never gets scheduled in the leak path either.
6. The 5-min janitor (line 687) walks `sseSessions` only — the leaked transport
   is not in `sseSessions`, so it's invisible to the janitor.

Per-request cost: a fresh `McpServer` with ~15 tool registrations (registerTool
closures, zod schemas, broker callbacks) + the transport's hono request listener
+ wrapped registerTool + tool registry record (idempotent so it's noise) ≈
~100-400 KB retained. At Cowork's poll cadence of ~few requests/sec, 36 MB/min
is consistent with this leak rate.

### Why the BOM's other ruled-IN suspects are NOT the leak

- **#1 SDK `StreamableHTTPServerTransport`** — the SDK's internal Maps DO grow
  per-request inside a single transport, but **they're scoped to that transport
  instance**. They'd only leak if the transport itself leaks. Our fix below
  short-circuits that path; we don't need an SDK upgrade.
- **#2 `attachMcpAttributes` in spans.ts** — clean. Calls
  `trace.getActiveSpan().setAttribute(...)`. No accumulation; OTel NoopTracer
  short-circuits when no SDK is configured.
- **#3 Notification queue from ntfy header bug** — `Notifier.notify` is
  fire-and-forget via `setImmediate`. Failed dispatches log + write SQLite, no
  retry queue. The header bug is a real bug (fixed in Phase 2) but is NOT the
  leak source.
- **#5 Express middleware per-request data** — `logContext.run(...)` uses
  AsyncLocalStorage which the runtime cleans automatically. The
  `stavrHttpRequestDuration` histogram has bounded label cardinality
  (`normalizeRoute` collapses to a fixed set, `method`/`status` are bounded).

---

## Planned fix (Phase 1)

In `src/transports.ts` `app.all('/mcp', …)`, after `await
session.transport.handleRequest(req, res, req.body)`:

```ts
if (isNew && !session.transport.sessionId) {
  // Stateless one-shot or rejected request: the transport never adopted a
  // session id, so it's not in sseSessions and onclose will never fire. Clean
  // up the per-request McpServer + transport explicitly so the broker doesn't
  // retain them indefinitely (v0.6.x memory-leak fix — see
  // proposed/v0_6_x-memory-leak-findings.md).
  broker.removeSession(session.handle.sessionId);
  try {
    await session.transport.close?.();
  } catch {
    /* socket likely already gone */
  }
  refreshSseGauge();
}
```

Also emit a low-volume diagnostic event (`mcp_oneshot_cleanup`) the first time
this fires per minute, so the operator can see in the event tail that the path
is exercised — without flooding the log if Cowork polls aggressively. (A simple
"last-emitted timestamp + 60s gate" suffices; full counting belongs in metrics.)

### Regression test

`tests/transports/oneshot-mcp-leak.test.ts`:
- Spin up the daemon with an in-memory event store.
- Send N stateless POST `/mcp` requests with no `mcp-session-id` header and a
  body the SDK will reject (or a `tools/list` without `initialize`).
- Assert `broker.sessionCount()` returns to 0 after the burst settles.
- Assert `process.memoryUsage().heapUsed` delta over N=200 iterations stays
  under a coarse bound (e.g. <50 MB growth) — coarse because GC is timing-
  dependent on Windows + better-sqlite3 native allocations.

---

## Companion bugs (Phase 2, same PR)

### ntfy header encoding (`src/notify/channels/ntfy.ts:77-79`)

`stripHeaderUnsafe` only collapses CR/LF. Node's `http.ClientRequest` rejects
**any non-latin-1 character in header values** with `ERR_INVALID_CHAR`. If a
notification Title contains an emoji or other non-ASCII character (likely from
worker names or user-supplied content), the entire dispatch fails before
network send.

**Fix:** RFC 8187 percent-encode any byte outside `0x20-0x7E` (also strip CR/LF
and tab). Keep the 250-char truncation. Apply the same sanitization to
`Actions` labels (line 58).

### PM2 restart-loop spam

Observed in `tmp/pm2-stavr.err.log`: every ~30s, PM2 spawns a fresh `node
dist/cli.js daemon start`, which fails with EADDRINUSE because the previous
daemon is still running on the port. PM2 considers that a crash and retries.

**Fix (cleanest UX):** edit `ecosystem.config.cjs` — raise `min_uptime` to
30000 (30s) and lower `max_restarts` to 5. This makes PM2 trip the restart-
gate after a port-conflict burst instead of looping forever. Also add
`exp_backoff_restart_delay: 5000` so successive failures back off.

Alternative considered: change CLI to exit 0 on EADDRINUSE. Rejected — it
silently masks a real "port busy" error and breaks the `npm run start` UX.

### `max_memory_restart: '7000M'` didn't fire at 18 GB RSS

PM2 polls `process.memoryUsage().rss` every 10s by default. If the daemon's
event loop is stalled (likely during the V8 GC death-spiral plateau), PM2's
poll may not get a fresh reading in time before V8 itself OOMs. **Phase 3
self-watchdog** belt-and-braces: an in-process `setInterval` that checks
`process.memoryUsage().rss` every 30s and, if over `STAVR_RSS_WATCHDOG_MB`
(default 4000), writes a heap snapshot and emits a `daemon_rss_watchdog`
event. The in-process watchdog runs even when the event loop is degraded.

---

## What I did NOT investigate

Per BOM rule "do not re-investigate the ruled-out list":
- Events table growth — confirmed not the leak.
- OTel collector — NodeSDK never starts.
- memory-poller — clean.
- SSE socket descriptor leak — libuv handles fine.
- SSE broadcast buffer — grows with sseSessions=0.
- script-signing.ts SyntaxError — already fixed.

## Ready to proceed

Phase 1 fix is ~10 lines of code + ~1 regression test. No changes to the
don't-touch list (`persistence.ts`, `types/`, `dashboard/data/*`,
`dashboard/adapters/*`, `migrations/`, `db/schema*`).
