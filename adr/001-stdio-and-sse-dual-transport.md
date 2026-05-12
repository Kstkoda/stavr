# ADR 001 — stdio + SSE dual transport

**Status**: Accepted
**Date**: 2026-05-12

## Context

MCP defines two standard transports: stdio (the server runs as a child process of one client, communication over pipes) and HTTP/SSE (the server runs as a network endpoint, one or more clients connect remotely). Cowire is consumed by two very different clients today: Claude Code (CC), which is launched per-session and spawns its MCP servers as child processes, and Cowork, which wants a long-lived remote connection so it can observe events across many CC sessions. Picking one transport would force one of those two consumers into an awkward shim.

## Decision

Switch supports both transports in the same binary, via `mountTransports(broker, opts)` in `src/transports.ts`. The `mode` flag selects between `'stdio'`, `'daemon'` (HTTP/SSE only), and `'both'`. Multiple MCP sessions from any combination of transports share the same `Broker` and `EventStore` instances in-process.

## Consequences

- CC keeps its native "MCP server is a child process" model — no protocol shim needed.
- Cowork (and any future remote agent) connects over SSE — no per-session subprocess.
- One codebase, one set of tools, one persistence layer. A tool added to the server is visible from both transports automatically.
- Slightly more complex startup: we have to think about port-binding failure differently in `'daemon'` (fatal) and `'both'` (degrade — see ADR-007).

## Alternatives considered

- **stdio only.** Would force Cowork to spawn its own Switch per session, with no shared state across the dashboard's view. The whole point of Cowork is cross-session observation; this defeats it.
- **SSE only.** Would force CC to learn a network-server model and would require Switch to be running before CC starts. Adds a configuration step ("did you remember to `cowire daemon start`?") that breaks the zero-setup CC story.
- **A separate stdio→SSE shim binary** that runs as a child of CC and proxies to a daemon. Possible future fallback if a given MCP client cannot consume `type: "sse"` config, but pure overhead today.
