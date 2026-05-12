# ADR 005 — Per-spawn architecture in v0.1

**Status**: Accepted (with v0.2 daemon mode coexisting)
**Date**: 2026-05-12

## Context

Cowire v0.1 was originally built to be spawned as an MCP child process — `cowire start --stdio-only` or `cowire start` (which also opened HTTP/SSE for any local subscribers). Each spawn opened its own SQLite store and its own broker. This shipped first because it was the path of least resistance to land the MCP server: Claude Code knows how to spawn child MCP servers, no daemon supervision required.

The trade-off became visible as soon as Cowork tried to subscribe to events emitted in a separate CC session: the two spawns each had their own `Broker` and their own `cowire.db`, with no shared state. The dashboard story is impossible under per-spawn.

## Decision

Keep `cowire start` as a working entry point for v0.1 and for "I just want to embed Switch under CC and not run a daemon" cases. Add `cowire daemon start/stop/status/restart` (spec 40 Phase 1) as the recommended path going forward. Both modes use the same broker/store/transport code via `mountTransports`. Future versions may deprecate per-spawn, but v0.2 supports both.

## Consequences

- **v0.1 still works** for anyone whose MCP client just wants to spawn Switch and not think about it.
- **v0.2 unlocks the dashboard** by sharing state across all MCP sessions on one host.
- **Two modes to test.** Tests cover daemon mode (multi-client SSE fan-out) and per-spawn (`cowire start`). The matrix is small enough to be cheap.
- **Cowork's config moves from "spawn cowire" to "connect to daemon."** That's the migration spec 40 prepares for. Old configs still work via per-spawn until the user updates.

## Alternatives considered

- **Drop per-spawn entirely in v0.2.** Cleaner but forces every MCP client to be daemon-aware. CC's `.mcp.json` currently expects to spawn its server; we don't want to fight that until we have to.
- **Keep per-spawn only.** Cannot deliver the spec-40 multi-CC orchestration story. Non-starter.
