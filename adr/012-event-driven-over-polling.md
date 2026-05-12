# ADR 012 — Event-driven over polling, with bounded one-shot exceptions

**Status**: Accepted
**Date**: 2026-05-12

## Context

Spec 40 Phase 2's first draft polled: a 10 second `git status --porcelain` loop per CC worker, a 30 second `process.kill(pid, 0)` aliveness check, a file the worker had to write that the orchestrator polled for dispatch messages. Kenneth pushed back: "i think the architecture needs to be event driven so nothing is truly waiting and polling if possible." Spec 42 inverted the design — the worker subsystem must be event-driven by construction, and the orchestrator must enforce that as a structural invariant rather than a coding convention.

Node has cheap primitives for this: `child_process` emits `'exit'` natively; `chokidar` wraps `fs.watch` portably; `readline` turns a stdout pipe into per-line events; MCP's `notifications/event/published` already fans events out to subscribed sessions. Every former polling site has a native event source.

## Decision

The worker subsystem (`src/workers/`) bans `setInterval` outright. Process exits use `child_process` `'exit'` events; filesystem changes use `chokidar`; line streams use `readline`; cross-process notifications use the broker. The only `setTimeout` permitted is a bounded one-shot per worker — the 5 minute idle marker that fires once and is reset on every activity event. That timer never re-arms by itself; if the worker stays active forever, the timer fires at most once between activity bursts.

Spawners are required to honor the same invariant. The orchestrator's API surface gives them events to emit (`progress`, `metadata`, `activity`, `exit`, `error`) and offers no hook for periodic callbacks. If a spawner's underlying tool genuinely has no event source, the spawner must document the gap in its docstring and in this ADR — not smuggle a `setInterval` past the review.

## Consequences

- **No CPU floor.** A daemon with ten idle CC workers consumes no measurable CPU. The previous design ran ten `git status` subprocesses every ten seconds whether anything changed or not.
- **Sub-second latency on state changes.** A `git commit` inside a worker's worktree produces a `worker_metadata_changed` event within ~50 ms of the index update, not "up to 10 seconds." Tests assert <100 ms.
- **Spawners are mechanically prevented from drift.** The contract is enforced by code review and by the absence of a "tick" hook on `WorkerSpawnerContext`. New worker types get the right architecture for free.
- **chokidar is a hard dependency.** ~3 MB of transitive deps for cross-platform `fs.watch` semantics. `fs.watch` natively is unreliable on macOS recursive mode and inconsistent on Windows network drives; chokidar smooths both. Worth it.
- **One-shot timers are explicit.** The orchestrator's idle marker is the only `setTimeout` and it is annotated and `unref()`-d so it never holds the process up. Decision expirations are also one-shot (existing implementation).

## Alternatives considered

- **Allow `setInterval` with a justification comment.** Conventions decay; structural invariants persist. The cost of writing `chokidar.watch` instead of `setInterval` is small enough that there is no reason to leave the door open.
- **Hide all polling inside the orchestrator and let spawners poll freely.** Inverts the wrong way — spawners are where new worker types accumulate; if they're allowed to poll, the system-wide property is lost as soon as a contributor doesn't know the rule.
- **Push polling to native OS APIs (e.g. ETW on Windows).** Significant complexity, platform-specific, and Node's existing primitives already cover the cases that came up.

## Acceptable one-shot exceptions (documented)

- **Per-worker idle marker** — one `setTimeout(idleAfterMs)`, reset on every activity event, fires at most once per inactive window. Marks status `idle` so dashboards can render a "stale" indicator.
- **Decision deadline** — one `setTimeout(timeoutMs)` per `await_decision`, cleared on response. Existing implementation; not part of this dispatch.
- **Daemon PID file stale check** — one read at daemon start. Not continuous.
