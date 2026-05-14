# ADR 015 — Federation-readiness as a design constraint

**Status**: Accepted (constraint, not implementation)
**Date**: 2026-05-12

## Context

Stavr is not the only agent orchestrator that will exist in the user's life. Two adjacent systems are already visible in early 2026:

- **Anthropic Agent Teams** — experimental in Claude Code as of May 2026; coordinates multiple Claude agents on a shared task.
- **n8n with MCP support** — n8n-mcp shipped in 2026; n8n workflows can call MCP tools natively and could in principle expose their own state as MCP events.
- **A2A (Agent-to-Agent) protocol** — complementary to MCP, emerged 2025-2026 for autonomous agent communication.

Kenneth's users will run some workers via Stavr and others via Agent Teams / n8n / A2A peers. Unified oversight ("show me everything that's running on my behalf right now") is a non-goal *for v1* but a hard constraint on the interfaces we ship — once `worker_spawned` / `worker_progress` / `worker_terminated` are public, breaking them costs every external integrator a migration.

## Decision

Treat the worker event taxonomy (`worker_spawned`, `worker_progress`, `worker_metadata_changed`, `worker_activity`, `worker_dispatch_request`, `worker_terminated`, `worker_error`) and the `WorkerRecord` shape as a public API. Specifically:

1. **No Stavr-internal-only metadata in event payloads.** Every field must be something an external worker (an Agent Teams session, an n8n workflow, an A2A peer) could plausibly produce. No fields like `stavr_session_id` or `internal_handle`; metadata that *is* Stavr-internal goes into the SQLite row, not the broadcast event.
2. **The worker model is independent of in-process `WorkerInstance`.** A worker row can be created and updated by external systems via a future `POST /api/events/ingest` endpoint without Stavr owning a `child_process` handle for it. The `WorkerOrchestrator`'s live map of `WorkerInstance` is an in-process optimization, not a load-bearing part of the model.
3. **A future `src/workers/external.ts` is reserved.** It will represent work happening *outside* Stavr's process tree — an Agent Teams session, an n8n workflow run, a remote A2A agent. It does not spawn anything locally; it only registers a worker row and listens for status updates via the ingress endpoint. The dashboard renders it just like any other worker.
4. **A future A2A translation layer is reserved.** When A2A's direction settles, a small adapter translates between our `worker_*` events and A2A's event vocabulary. Two-way: subscribe to A2A agents and emit our events; expose Stavr workers as A2A-speakable peers.

## Non-decision

This ADR does *not* commit to building any of (3), (4), or the ingress endpoint in v1. It commits to *not foreclosing them* — the constraint is that nothing in spec 42's worker schema or event taxonomy can be Stavr-process-bound in a way that would force a redesign when those bridges arrive.

## Consequences

- **Event payloads stay portable.** External systems can subscribe to Stavr's event log without translation. Stavr can subscribe to theirs symmetrically.
- **No `WorkerInstance`-shaped fields leak into the schema.** The in-process handle is invisible to anything but the orchestrator.
- **The cost is small.** We were already going to ship clean, typed event payloads. The constraint just rules out a class of internal-detail leakage that would have been easy to add later by accident.
- **Future ingress endpoint has a clear contract.** When `POST /api/events/ingest` ships, it accepts `Event` envelopes that look exactly like internally-emitted ones, with `source_agent` indicating the foreign system. No special path, no separate schema.

## Alternatives considered

- **"Cross that bridge when we get to it."** Once the schemas ship, they're public. Migrating a published taxonomy costs every integrator a release. Easier to apply the constraint now while there are no consumers.
- **Build the federation surface in v1.** Premature — Agent Teams is still experimental, A2A is still settling, n8n-mcp's surface is in flux. Better to leave the constraint and revisit when at least one adjacent system has a stable v1.

## See also

- Spec 42 §"External-orchestrator federation".
- [ADR-013](./013-single-workers-table-with-type-discriminator.md) — the single-table + JSON-metadata design works for external workers without modification.
