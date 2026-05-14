# ADR 017 — A2A protocol compatibility decision

**Status**: Accepted
**Date**: 2026-05-12

## Context

Spec 42 (event-driven worker orchestration, bundled into spec 40 Phase 2) introduces a new family of broker events — `worker_dispatch_request`, `worker_progress`, `worker_metadata_changed`, `worker_terminated` — that describe the lifecycle of orchestrated workers. The shape of those events is, on the schedule, about to ship.

In parallel, the Agent2Agent (A2A) protocol reached v1.0.0 on 2026-03-12 under the Linux Foundation's Agentic AI Foundation, with 150+ adopters (Microsoft, AWS, Salesforce, SAP, ServiceNow, IBM, Workday) and SDKs in five languages. It defines a JSON-RPC 2.0 vocabulary for agent↔agent communication (`Task`, `Message`, `Part`, `Artifact`, `AgentCard`, `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`) that overlaps materially with what Stavr's worker events describe.

The question this ADR settles, before Phase 2 freezes the event schema: should Stavr's internal `worker_*` event vocabulary be aligned with A2A's terms, or stay broker-pattern as designed, with any A2A interop handled at a future boundary? The detailed mapping and option scoring live in [spec 43 — A2A compatibility analysis](../../../privacy%20tracker/specs/43_a2a_compatibility.md); this ADR records the decision.

## Decision

Keep the broker-pattern as designed. Phase 2 ships its `worker_*` event taxonomy with no A2A-driven renames or restructuring. A2A interop, when a real peer materialises, is delivered as a projection adapter at an HTTP boundary (translating broker events to `Task` / `Message` / `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`), not by leaking A2A vocabulary into `src/event-types.ts`.

## Consequences

- Phase 2 of spec 40 / spec 42 is unblocked; no event schema rewrite, no payload reshaping.
- The internal event log remains insulated from A2A spec churn (v1.0 is two months old; v1.1/v1.2 corner-case clarifications are likely).
- Stavr's local-process identity model (PID, cwd, worktree path) is preserved unchanged; we do not invent HTTPS-published `AgentCard` identity for child processes that don't have URLs.
- When a real A2A consumer arrives, the bridge cost is bounded: ~300–500 LOC of projection plus three HTTP endpoints, scoped as a follow-up spec. The mapping table in spec 43 demonstrates the vocabulary overlap is high enough to make this a translation problem, not a redesign.
- Two forward-compat nudges fall out of this decision and apply to the Phase 2 dispatch at no cost: (a) `worker_terminated.reason` enum values must stay mappable to A2A terminal `TaskState`s (`completed`→`COMPLETED`, `crashed`→`FAILED`, `terminated`→`CANCELED`) — pin with a test so a future rename can't drift; (b) `correlation_id` must be set consistently across one worker's lifecycle so a projection can group them as one A2A `Task`.
- Trade-off accepted: an A2A-speaking peer that wants to consume Stavr events today gets nothing. We chose schema stability over zero-day interop because no such peer exists in any current Stavr consumer (Cowork, Claude Code, dashboard).

## Alternatives considered

- **Align internally with A2A vocabulary.** Rename `worker_*` events to A2A terms, introduce `Part`/`Artifact` payload structure, synthesise per-worker `AgentCard`. Ruled out: couples our event log to a two-month-old spec, forces an enterprise-cloud identity shape onto local child processes, and delivers no interop value until a real A2A peer appears. The history of fresh standards is one of v1.1/v1.2 clarifying corner cases — we want our internal vocabulary insulated.
- **Implement the A2A projection now.** Ship the HTTP/SSE projection adapter as part of Phase 2 rather than deferring. Ruled out: no concrete consumer exists today; building a translation layer with no real peer to validate against guarantees a bad fit. Spec 43 documents the projection as a deferred follow-up so the design is in hand when triggered.
- **Wait until A2A v1.1+ to decide.** Forces Phase 2 to ship with no answer to the schema-stability question, leaving downstream consumers exposed to a later breaking change. Deciding now — to stay broker-pattern — gives Phase 2 a clear runway and defers only the projection, which is the part that genuinely should wait for a real peer.

## References

- A2A Protocol Specification v1.0.0 — https://a2a-protocol.org/latest/specification/ (accessed 2026-05-12)
- A2A on GitHub — https://github.com/a2aproject/A2A (v1.0.0 released 2026-03-12, Apache 2.0)
- Linux Foundation press release on A2A adoption — https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- Companion analysis: spec 43 — A2A compatibility (mapping table, option scoring, deferred Option C design, revisit triggers)
- Related: ADR-006 (daemon binds 127.0.0.1 only — informs why A2A's HTTPS/auth model is out of scope today)
