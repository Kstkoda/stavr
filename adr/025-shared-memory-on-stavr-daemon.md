# ADR 025 — Shared memory layer on the Stavr daemon

**Status**: Proposed
**Date**: 2026-05-14

> **Note on numbering (2026-05-21):** this ADR was originally created as `adr/023-shared-memory-on-stavr-daemon.md` and collided with the existing `adr/023-param-constraint-matching-syntax.md`. Renumbered to 025 by the hygiene-sweep (first free slot in the 020s). Same proposal — only the file name and this heading have changed.

## Context

Stavr's spec 39 tier model and the trust-scope work (ADR-022) gave us shared *authority* across sessions: every CONFIRM-tier action on the operator's machine goes through one daemon, one log, one approval surface, regardless of which agent issued it. We do not have the analogous layer for *context*. Each Claude Code worker, each Cowork chat session, each ad-hoc `stavr` CLI invocation starts cold, reads a per-project CLAUDE.md if one exists, edits it locally, and exits. There is no way for session B to ask "what is session A currently doing" or for either of them to find "what was decided about the audit-log schema last Tuesday." The result is what Kenneth calls split-brain syndrome: three agents working in parallel on the same operator's behalf, each partially amnesiac, each capable of re-deciding decisions the others have already made, each capable of clobbering the same CLAUDE.md.

The pressure forcing the decision is multi-session, multi-project workflow. Spec 47's tail and the dashboard already assume the operator runs several spawned workers at once. ADR-016 isolates each worker in its own git worktree. Federation-readiness (ADR-015) anticipates this scaling further. Memory is the only layer left that still treats each session as a singleton, and at the cadence of work Stavr is built for, that no longer holds.

## Decision

Memory becomes a first-class concern of the Stavr daemon, sharing the same SQLite file (`~/.stavr/runestone.db`), the same WAL semantics, the same MCP transport, and the same 127.0.0.1-only binding as the action-audit layer. Three new tables and four new MCP tools, scoped to `src/memory/` alongside `src/trust/`.

**Tables** (defined in `src/persistence.ts` migrations):

- `memory_facts` — append-only knowledge. Columns: `id`, `topic`, `body`, `project`, `source_session_id`, `created_at`, `supersedes_id` nullable. Indexed by `(project, topic, created_at)`. Compaction is the `consolidate-memory` skill's job, run periodically; it writes a new row that supersedes a chain of older ones rather than mutating in place.
- `sessions` — current and recent agent sessions. Columns: `session_id`, `source_agent` ("cc", "cowork", "cli", "external"), `project` nullable, `current_task`, `status` ("active", "idle", "ended"), `started_at`, `last_heartbeat_at`, `ended_at` nullable. Indexed by `(status, project, last_heartbeat_at)`. Stale `active` rows (no heartbeat in N minutes) flip to `idle` by the watchdog (ADR-020 pattern).
- `session_updates` — append-only what-am-I-doing-now stream. Columns: `id`, `session_id`, `body`, `created_at`. Indexed by `(session_id, created_at desc)`. Bounded retention (rolling window) plus elevation to `memory_facts` for entries the session flags as durable.

**MCP tools** (registered in the existing catalogue, validated with Zod per ADR-004):

- `memory.recall { topic?, project?, since? }` — returns the most-recent non-superseded facts matching the filter, plus a digest of relevant `session_updates`. Read-only, no gating.
- `memory.inscribe { topic, body, project?, supersedes? }` — appends a fact. Cheap, frequent, low-stakes. Tier AUTO. Not gated by trust scopes; failures are logged but never block execution.
- `sessions.peers { project? }` — lists `sessions` rows where `status != 'ended'`, with their last update lines. Read-only.
- `sessions.heartbeat { task, status, project? }` — upserts the caller's `sessions` row keyed by the MCP connection's session id. Tier AUTO.

**Protocol at session boundaries:**

Each Claude session (Claude Code worker, Cowork chat, CLI) opens its MCP connection to Stavr and, in its first turn, calls `sessions.heartbeat` to register itself and `memory.recall` to read the project's working memory. It then optionally calls `sessions.peers` to find concurrent sessions and steers around them. Significant decisions during the session call `memory.inscribe`. Cheap progress updates call `sessions.heartbeat` again, which doubles as the watchdog's freshness signal. On clean exit, the session sets its own status to `ended`; on dirty exit, the watchdog handles it.

The existing `tail` and dashboard surfaces extend to render `session_updates` alongside action events, so the operator can see what every agent thinks it's doing in one view.

## Consequences

- Multi-session work stops re-deciding the same questions. A decision recorded by session A is visible to session B at its next `memory.recall`. The 70% of context loss that today happens at session boundaries collapses to a single `recall` call.
- The same `runestone.db` becomes the operator's full external brain — actions, scopes, audits, facts, sessions. One file to back up, one threat model, one local-first commitment. The brand line extends from "what your AIs *do*" to "what your AIs *do* and *know*."
- The schema grows, and so does the compaction problem. Every session writing `session_updates` every few minutes is a write-heavy stream. We accept it because SQLite WAL handles this well at single-machine scale and the consolidate pass keeps `memory_facts` flat. ADR-015 federation readiness still applies — the schema is event-shaped so a future cross-machine sync is mechanical, not architectural.
- Privacy surface grows. The memory store now contains people, decisions, project state — material the action log doesn't always have. Same threat model as `runestone.db`: 127.0.0.1 only, owner-readable file permissions, no telemetry, no cloud sync, opt-in encryption at rest deferred to a follow-up ADR if/when it becomes a buyer concern.
- We accept a small latency cost at session start (two extra MCP calls before the first useful turn) for the very large benefit of session-aware context. Empirically the cost is dominated by network/IPC round-trip, not query time.
- The `consolidate-memory` skill becomes load-bearing rather than nice-to-have. Without periodic compaction, `memory_facts` grows unbounded and `memory.recall` slows linearly. The skill must run on a schedule (manual or via `mcp__scheduled-tasks__create_scheduled_task`) and is part of v0.3 operational hygiene.
- Session identifiers become attestable. The same `session_id` used in `sessions` is the one already recorded against `scope_actions` in the trust-scope layer. This lets queries answer "show me every action and every memory fact produced by session X" in a single join — a real audit primitive, not just a debug aid.

## Alternatives considered

- **Filesystem-only markdown (status quo, just better-organized)** — what the `productivity:memory-management` skill does today. Works for single-session work; provably fails the moment two sessions need to write to the same file. Markdown also gives us no query primitive — `memory.recall { topic: "audit-log schema" }` is a SQL query, not a `grep`.
- **Separate memory daemon** — keeps Stavr focused on actions, runs `memnos` or similar alongside. Doubles the install surface, doubles the threat model the operator has to reason about, splits the audit story (actions in one place, decisions in another). Stavr already binds 127.0.0.1, already has WAL SQLite, already has MCP transport — the marginal cost of three more tables and four more tools is far less than a second daemon.
- **Cloud-sync the memory (Notion, Linear, Obsidian Sync)** — violates the local-first promise that's load-bearing for the brand. Half of Stavr's pitch is "your record never leaves your machine." A cloud memory layer is the wrong abstraction at the wrong altitude.
- **Per-worker memory only, no cross-session sharing** — solves nothing. Workers already have their own scratchpad in the worktree (ADR-016). The whole problem is the bits that *need* to cross worker boundaries: decisions, people, project context, status. A per-worker store can't carry those.
- **Use an existing memory MCP server (mem0, letta, etc.)** — viable in principle, kills the single-daemon promise in practice. The operator already trusts one binary on 127.0.0.1; introducing a second MCP server with its own storage, lifecycle, and update cadence raises the threshold for who'll actually run this. Keep the surface small.
