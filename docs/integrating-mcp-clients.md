# Integrating MCP clients with stavR

This page is the durability contract for any MCP client that talks to
stavR through the HTTP transport (`POST /mcp` Streamable HTTP). It
matters because stavR exposes chokepoint-gated tools (`await_decision`
and any tool the operator routes through it) whose handlers can block
for minutes while a human responds in the dashboard. The connection
hosting that call MUST be durable across the kind of transient drop
real networks produce.

## What stavR guarantees on the server side

Since the BOM in `proposed/mcp-session-stability-bom.md` (Phase 2):

1. **Resumable response streams.** Every
   `StreamableHTTPServerTransport` is constructed with a bounded
   `EventStore`. Every message the server sends to a stream carries a
   monotonic event ID; on reconnect with a `last-event-id` header, the
   SDK replays whatever the store still holds (bounded at **256 events
   OR 5 minutes per stream**, whichever fires first — evicted on insert,
   never via a janitor).
2. **Standalone-stream keepalive.** A `notifications/message` (level
   `debug`, logger `stavr-keepalive`) fires every 20s on each session's
   standalone GET stream. Idle intermediaries (proxies, NATs, undici
   body-timeout) will not silently close the control channel during a
   long handler.

## What the client MUST do

Any client that wants the durability guarantee:

1. **Use a transport that resumes.** The reference
   `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` does
   this automatically — on a GET-stream disconnect it reconnects with
   the last seen event ID. If you wrap or replace the SDK transport,
   preserve that behaviour. stavR's `shim.ts` adds an outer reconnect
   ladder; if you are not the shim, you carry the resumption logic
   yourself.
2. **Do not unilaterally recycle the session on a wall-clock timer.** A
   client-side 15-minute teardown defeats the durability work: even with
   resumption, a fresh `initialize` discards the long-blocking call's
   correlation. If your client must rotate sessions for unrelated
   reasons, do it on **operator quiescence**, not on a fixed timer.
3. **Ignore `notifications/message` you don't understand.** The 20s
   keepalive is a server-initiated logging message at debug level. Per
   MCP spec the client may discard it; it exists to keep the wire warm,
   not to deliver semantic data.
4. **Handle `Mcp-Session-Id`-404 cleanly.** If your session was reaped
   on the server side (rare — only on `DELETE /mcp` or explicit
   teardown), stavR returns 404 on subsequent requests. Treat that as
   "start a new session"; do not retry the same request body against a
   fresh session — chokepoint state belongs to the old one.

## What stavR does NOT do

- **Per-POST keepalive.** The per-request response stream is protected
  by resumability, not heartbeat. If the SDK eventually exposes a clean
  hook for per-request keepalives we may add it; the current
  Phase 2 spike concluded it would require tracking in-flight request
  IDs ourselves, which crosses the BOM's scope boundary.
- **Persistent session state across daemon restarts.** Sessions live
  in-memory only. A `pm2 restart stavr` invalidates every session id;
  clients must reinitialise. Pending `await_decision` rows persist in
  SQLite and are reconciled on next call by correlation_id.
- **Cross-process resumability.** The eventStore is per-transport,
  in-memory. If stavR is ever federated across hosts, the eventStore
  will need to grow accordingly — out of scope today.

## Diagnostic surface

For end-to-end visibility:

- Server-side: the `sse_session_opened` / `sse_session_closed` /
  `sse_session_force_removed` event kinds are emitted on every
  transition. The dashboard's `/dashboard/diagnostics/engine` page
  surfaces session counts; Prometheus exposes
  `mcp.server.sessions.active`.
- A future Phase 3 of the same BOM will add
  `stavr_tool_response_delivery_failed_total` (counter) and a
  handler-duration histogram so the eventStore bound can be tuned from
  data rather than guessed.

## See also

- `proposed/mcp-session-stability-bom.md` — the BOM that introduced
  durability.
- `proposed/mcp-session-stability-recon.md` — the recon walk.
- `proposed/mcp-session-stability-cadence-findings.md` — Phase 0
  measurement, fixed-timer verdict.
- ADR-044 — Streamable HTTP transport migration.
