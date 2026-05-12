# ADR 006 — Daemon binds 127.0.0.1 only

**Status**: Accepted
**Date**: 2026-05-12

## Context

The Switch daemon serves MCP over HTTP/SSE on a TCP port (default 7777). MCP messages can trigger arbitrary tool calls — including, in the future, write actions guarded by `await_decision`. Exposing that endpoint on `0.0.0.0` would let any process on any host that can reach the user's machine drive the user's agents.

## Decision

`app.listen(port, '127.0.0.1', ...)` in `src/transports.ts`. The literal string `'127.0.0.1'` is used — not `'localhost'`, which on some Windows configurations resolves to IPv6 `::1` first and surprises users.

## Consequences

- **No remote attack surface.** Only processes on the same host can connect.
- **No authentication required at the transport layer** in v0.1/v0.2 — the host's process model is the trust boundary.
- **Cross-host scenarios are future work** (a separate spec). When they happen, they will go through a real network listener with auth in front, not by flipping a bind address.
- **`localhost` quirks documented.** The README troubleshooting section warns users to use `127.0.0.1` literally because of the IPv6-first resolution issue.

## Alternatives considered

- **Bind 0.0.0.0 with a token.** Adds an auth surface (tokens to issue, rotate, store) for a use case we don't have. If we ever need cross-host, the right answer is a deliberate "remote access" spec — not flipping the bind in this ADR's scope.
- **Unix domain socket.** Avoids the port-allocation conversation entirely but breaks the Windows case (Windows' UDS support is real but young) and excludes any MCP client that only speaks TCP.
- **Bind localhost instead of 127.0.0.1.** Same network outcome but adds the IPv6 surprise on Windows. Net negative.
