# Architecture Decision Records

An ADR records one architectural decision in one short page. The point is *durability of context*: months later, when nobody remembers why the code looks the way it does, the ADR explains it.

## What goes in an ADR

- **Context** — the situation when the decision was made. What forced a choice?
- **Decision** — what we chose, in 1–3 sentences.
- **Consequences** — the good and bad outcomes we accepted by choosing this.
- **Alternatives considered** — what we ruled out and why.

What does NOT go in an ADR: how-to instructions, implementation details, code listings. ADRs explain decisions; `ARCHITECTURE.md` and the adapter guide explain how things work.

## When to write an ADR

Write one when you make a decision that:
- another engineer (or future-you) would reasonably second-guess later, **and**
- is hard to discover from the code alone — the choice closed off alternatives that aren't visible.

Don't ADR a routine implementation choice. ADR a structural choice: "we picked X over Y," "we kept both transports instead of consolidating," "we did not use library Z."

## Format

Copy [`000-template.md`](./000-template.md) and rename to `NNN-short-kebab-title.md`. Numbers are monotonic — never reuse one. If an ADR is superseded, leave it in place and add a new one; mark the old one's `Status` line.

## Index

- [ADR-001 — stdio + SSE dual transport](./001-stdio-and-sse-dual-transport.md)
- [ADR-002 — SQLite for persistence](./002-sqlite-not-postgres.md)
- [ADR-003 — `gh` CLI in the GitHub adapter](./003-gh-cli-not-octokit.md)
- [ADR-004 — Zod for event-payload validation](./004-zod-for-event-validation.md)
- [ADR-005 — Per-spawn architecture in v0.1](./005-per-spawn-architecture-v01.md)
- [ADR-006 — Daemon binds 127.0.0.1 only](./006-daemon-binds-127001-only.md)
- [ADR-007 — EADDRINUSE graceful fallback](./007-eaddrinuse-graceful-fallback.md)
- [ADR-008 — gh CLI write actions through `await_decision`](./008-write-actions-await-decision.md)
- [ADR-009 — Stdio→SSE shim for clients that don't recognize remote MCP](./009-stdio-sse-shim.md)
- [ADR-012](./012-event-driven-over-polling.md) — Event-driven over polling
- [ADR-013](./013-single-workers-table-with-type-discriminator.md) — Single workers table with type discriminator
- [ADR-014](./014-spawner-static-registry.md) — Spawner static registry
- [ADR-015](./015-federation-readiness-design-constraint.md) — Federation-readiness as design constraint
- [ADR-016](./016-cc-worker-uses-git-worktree-isolation.md) — CC worker uses git worktree isolation
- [ADR-017](./017-a2a-protocol-decision.md) — A2A protocol compatibility decision
- [ADR-018](./018-destructive-operations-stay-manual.md) — Destructive operations stay manual
- [ADR-019](./019-exponential-backoff-reconnect-in-shim.md) — Exponential-backoff reconnect in the shim (supersedes ADR-009's 3-error rule)
- [ADR-020](./020-daemon-watchdog.md) — Standalone daemon watchdog via OS scheduler
- [ADR-021](./021-graceful-degradation-vs-crash.md) — Graceful degradation, not crash
