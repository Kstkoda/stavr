# ADR-044 — Migration of the remote MCP transport from HTTP+SSE to Streamable HTTP

**Status:** Accepted — retroactive. The migration was executed in the v0.2.1 Forefront Pass BOM, Checkpoint 4 (code landed 2026-05-16); this ADR documents it after the fact.
**Date:** 2026-05-20
**Related:** ADR-001 (stdio + SSE dual transport — **superseded by this ADR**, SSE half), ADR-009 (stdio↔transport shim — transport reference superseded by this ADR), ADR-019 (shim reconnect policy), `proposed/v0.2.1-forefront-pass-bom.md` Checkpoint 4
**Supersedes:** ADR-001 (the SSE half — stdio is unaffected)

## Context

MCP's original remote transport was HTTP+SSE. The protocol has since consolidated on **Streamable HTTP**, and the MCP SDK now marks `SSEClientTransport` / `SSEServerTransport` `@deprecated`. Staying on SSE is debt against a moving floor: a deprecated transport accrues incompatibility with every SDK and client release.

stavR's remote transport (the `daemon` / `both` modes from ADR-001) ran HTTP+SSE. The v0.2.1 Forefront Pass BOM, Checkpoint 4, migrated it to Streamable HTTP. Checkpoint 4.5 promised an ADR ("ADR-024: Streamable HTTP migration") — but ADR-024 was assigned to "Reporting cadences and channels," so the most consequential transport change in stavR's history shipped undocumented for ~4 days. This ADR closes that gap retroactively.

## Decision

Migrate the remote MCP transport from HTTP+SSE to **Streamable HTTP**. The daemon serves a single `/mcp` endpoint (`POST` for requests, `DELETE` for session teardown); the legacy `/mcp/sse` route is removed. stdio transport (for Claude Code's child-process model) is unaffected — ADR-001's stdio half still stands.

The decision itself is not in question: SSE is deprecated, the migration direction is correct, nothing here is reversed. This ADR exists to (a) put the decision on the record and (b) bank the lesson from how the migration *landed*.

## Consequences

### Positive

- Off the deprecated transport; aligned with the current MCP spec and SDK.
- A single `/mcp` endpoint — simpler surface than the SSE GET-stream + POST-back pair.

### Negative — banked lesson: a transport migration is a *model* migration

The migration shipped an OOM-class regression. Streamable HTTP introduces a request shape SSE never had: **stateless one-shot POSTs** — `tools/list`, `ping`, and requests rejected before an `initialize` handshake. The migrated `/mcp` handler wired session lifecycle and cleanup for the *session-ful* path (the SSE-shaped path) and missed the stateless one. Every stateless POST leaked a full `McpServer` object graph (~100–400 KB); `broker.removeSession()` and `transport.close()` never fired.

Impact, sustained 3+ days from 2026-05-16: ~36 MB/min heap growth, the daemon OOMing roughly every 64 minutes, an 18 GB RSS incident, PM2 restart-looping, a 16 GB heap snapshot. Fixed in `fbcc2e4`. Regression coverage: `tests/transports/oneshot-mcp-leak.test.ts`.

**Lesson:** when migrating a transport, enumerate every request shape the *new* transport introduces that the *old* one lacked, and verify lifecycle and cleanup for each one explicitly. A transport is not a wire format — it is a state model. "SSE with a new name" was the wrong mental model and it cost three days of OOMs.

## Follow-ups

- `.mcp.json` updated from `type: "sse"` / `/mcp/sse` to `type: "http"` / `/mcp` — it was pointing at a route that no longer exists.
- ADR-001 marked Superseded (SSE half); ADR-009's transport reference annotated.
- The `sseSessions` identifier and other `sse`-prefixed names still pepper `src/transports.ts` while holding `StreamableHTTPServerTransport` objects — stale vocabulary. The rename is folded into the Family-mode cycle Phase 1 (which already opens `transports.ts`), to avoid double-churning a hot file.
- The two-ADR-023 numbering collision was resolved in the 2026-05-21 hygiene-sweep: the shared-memory ADR moved to `adr/025-shared-memory-on-stavr-daemon.md`; `adr/023-param-constraint-matching-syntax.md` keeps the 023 slot.
