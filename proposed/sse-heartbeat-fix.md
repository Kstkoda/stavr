# SSE heartbeat fix

The 5-minute reconnect cycle you've been seeing in switch logs is undici's default 300s `bodyTimeout` killing the SSE long-poll. The shim recovers in ~1s every time, but it's noisy and there's a brief window where events from the daemon are dropped.

Fix is two-sided: server sends a heartbeat comment so undici sees bytes flowing, client disables the body timeout entirely for SSE (belt + suspenders).

## Server side — `src/transports.ts`

Find the `/mcp/sse` route handler that wires up the MCP SDK's `SSEServerTransport`. After `res.flushHeaders()` (or wherever the response is opened), start an interval that writes a comment line every 25s. SSE clients ignore comments but they keep the connection alive.

```ts
// In mountMcpSseRoute (or wherever the SSE endpoint is mounted)
app.get('/mcp/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable any reverse-proxy buffering
  res.flushHeaders();

  // Heartbeat — write SSE comment every 25 seconds
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 25_000);

  // ... existing transport setup (SSEServerTransport, broker.subscribe, etc)

  req.on('close', () => {
    clearInterval(heartbeat);
    // ... existing cleanup
  });
});
```

Same pattern for the `/events/sse` raw event tail endpoint and any other long-lived SSE responses.

Reference: 25s is well under the 30s mark that most intermediaries (proxies, mobile carriers, undici defaults) use for idle timeout. If you have a known proxy with a tighter window, drop to 15s.

## Client side — `src/shim.ts`

The shim opens an SSE stream from the daemon via `fetch`. Pass it an undici `Agent` with `bodyTimeout: 0` so the body-read timeout never fires.

```ts
import { Agent, fetch } from 'undici';

// At module scope, once
const sseAgent = new Agent({
  bodyTimeout: 0,       // disable body-read timeout (SSE never "completes")
  headersTimeout: 30_000, // headers should arrive in 30s or it's a real failure
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

// Where the shim opens the SSE stream
async function openSseStream() {
  const res = await fetch('http://127.0.0.1:7777/mcp/sse', {
    dispatcher: sseAgent,
    headers: { Accept: 'text/event-stream' },
  });
  // ... existing stream parsing
}
```

If you're using a different HTTP client (axios, node-fetch), the equivalent is whatever knob disables read-idle timeout on the response stream. Don't disable headers timeout — that one should still bark at 30s if the daemon never replies.

## Verify

After applying both, restart the daemon and the shim. Tail the switch log:

```
tail -f %APPDATA%\Claude\logs\mcp-server-switch.log
```

You should NOT see `SSE error: TypeError: terminated: Body Timeout Error` every 5 minutes anymore. Connections should stay open until either explicitly closed (renderer exits, daemon restart) or a real network failure occurs.

## Why this works

- Server: writing any bytes resets undici's body-idle timer. SSE comments are part of the spec and any compliant client (including the MCP SDK's SSEClientTransport) skips them.
- Client: `bodyTimeout: 0` tells undici "don't impose a max gap between bytes" — the right setting for a stream that's intentionally long-lived.

## Why this is safe

- Heartbeats are tiny (~24 bytes every 25s = 1 KB/min per client). Negligible.
- Disabling body timeout doesn't disable connection-close detection — TCP RST, EOF, and headers-timeout still apply. If the daemon truly disappears, the client knows within seconds, just not via the body timer.
- No protocol change. No event semantics change. Pure transport hygiene.

## Cleanup TODO when landing

1. Add a small unit test that mocks a slow-emitting SSE stream and asserts no body-timeout errors over 60s.
2. Add a metric: count `: heartbeat` writes per client per minute. Should be ~2.4. Anything else is a bug.
3. Audit any other long-lived `fetch`/`http.request` calls in the daemon and shim — same Agent treatment if they exist.
