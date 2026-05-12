# ADR 007 — EADDRINUSE graceful fallback in `'both'` mode

**Status**: Accepted
**Date**: 2026-05-12

## Context

Before the daemon existed, `cowire start` was the only way to run Switch and it opened both stdio and HTTP/SSE in the same process. When CC (or any MCP client) spawned Switch multiple times — once per MCP session — every spawn after the first crashed trying to bind the same port (`EADDRINUSE`). The first spawn would silently own port 7777 and every later spawn would die. There was no error handler on `app.listen`, so the failure was a process crash, not a graceful degradation.

## Decision

In `'both'` mode (the legacy `cowire start` path), if `app.listen` fails with `EADDRINUSE`, log a clear message ("port already in use; continuing with stdio-only — another Switch instance is probably holding it") and proceed with stdio only. The MCP session over stdio still works. In `'daemon'` mode, bind failure is fatal — there is no point continuing if HTTP/SSE is the only transport.

The handler lives in `transports.ts` on the `s.on('error', ...)` callback for `app.listen`.

## Consequences

- **Per-spawn `cowire start` works in parallel.** Cowork spawning multiple MCP sessions no longer kills the second, third, fourth Switch instances. They share whatever HTTP listener exists by giving up on theirs.
- **Stdio MCP keeps working.** The CC use case (stdio, no HTTP) is unaffected.
- **The HTTP listener is "first writer wins" in per-spawn mode.** That's acceptable because in per-spawn mode each Switch has its own SQLite store anyway; no one was supposed to discover them via HTTP.
- **Daemon mode is unforgiving.** `cowire daemon start` on a busy port fails loudly. That's correct — the daemon's contract is "one daemon per host, owning :7777".

## Alternatives considered

- **Port hunt: try 7777, 7778, 7779, ...** Hides the conflict and leaves the user wondering which port their daemon is on. Worse UX in every case.
- **Always treat EADDRINUSE as fatal.** Re-introduces the original crash in per-spawn mode. The whole point of this ADR is *not* doing that.
- **Tear down whatever holds the port and bind anyway.** Catastrophic — could kill the user's daemon, their dev server, anything.
