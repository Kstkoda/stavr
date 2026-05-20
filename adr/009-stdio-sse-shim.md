# ADR 009 — Stdio→SSE shim for clients that don't recognize remote MCP

**Status**: Superseded by [ADR-019](./019-exponential-backoff-reconnect-in-shim.md) (reconnect policy section) and partially by [ADR-044](./044-streamable-http-transport-migration.md) (transport). The shim itself remains; the "3 consecutive errors → exit" rule is replaced by exponential backoff (ADR-019); and the SSE references below — `SSEClientTransport`, `/mcp/sse`, the `type: "sse"` config — are historical: the daemon's remote transport is now Streamable HTTP at `/mcp` (ADR-044).
**Date**: 2026-05-12

## Context

Spec 40 Phase 1 added daemon mode to Switch with SSE as the transport for multi-client connection. The intent was that any MCP client — including Cowork — would point its config at `type: "sse"` with `url: http://127.0.0.1:7777/mcp/sse` and connect to the running daemon.

In integration we discovered that Cowork's MCP client config does not recognize `type: "sse"` entries. The exact config we tried (and that silently failed):

```json
{
  "mcpServers": {
    "switch": {
      "type": "sse",
      "url": "http://127.0.0.1:7777/mcp/sse"
    }
  }
}
```

Cowork's `mcp-server-switch.log` showed zero connection attempts; `main.log` showed no parse error and no validation warning — the entry was simply skipped. Cowork's schema apparently requires a stdio-style `command` + `args`.

Without a bridge, Cowork cannot connect to the daemon. Multi-agent topology (Co + N CCs sharing a single broker, single event log, single decision queue — the entire point of Phase 1) stays out of reach.

## Decision

Ship a ~70-LOC stdio↔SSE proxy at `src/shim.ts` → `dist/shim.js`. Cowork spawns it as a stdio MCP server (`command: "node"`, `args: ["…/dist/shim.js"]`); the shim opens an SSE connection to the daemon and forwards JSON-RPC messages bidirectionally without inspection. The daemon URL is configurable via the `STAVR_DAEMON_URL` env var (defaults to `http://127.0.0.1:7777/mcp/sse`) or a `--url` flag for direct invocation.

The shim uses the MCP SDK's transports directly (`StdioServerTransport` + `SSEClientTransport`) rather than wrapping them in a `Client`/`Server` pair, so it stays byte-level: it does not parse messages, validate JSON-RPC envelopes, or maintain any per-request state.

## Consequences

- Cowork can now connect to the same daemon as future CC sessions. Spec 40 Phase 2 (CC orchestration on the shared event log) is unblocked.
- One extra Node process per Cowork session (small RAM footprint; the shim does nothing but forward bytes).
- Stderr-only logging: anything written to stdout must remain valid MCP JSON-RPC because Cowork is parsing it. All shim diagnostics go to `console.error`.
- Lifecycle correctness is the shim's job: when Cowork closes the shim's stdin, the shim closes its SSE connection and exits 0; when the daemon disconnects, the shim closes stdio and exits non-zero so Cowork registers the failure rather than hanging.
- When Cowork adds native `type: "sse"` support, the shim becomes optional and the config reverts. The code stays as a fallback for other clients with the same limitation.

## Alternatives considered

- **Wait for Cowork to add native SSE support.** Blocks Phase 2 indefinitely on an external dependency.
- **Stay on the legacy per-spawn architecture ([ADR-005](./005-per-spawn-architecture-v01.md)).** Forfeits multi-agent state sharing — the whole reason Phase 1 exists. Every Cowork chat would still spawn its own isolated Switch and SQLite.
- **HTTP-only transport on the daemon, no shim.** Same problem — Cowork doesn't speak it.
- **A larger proxy that maintains MCP `Client`/`Server` pairs and re-routes JSON-RPC by method.** Adds a layer that can drift from the spec; byte-level forwarding is correct by construction.
