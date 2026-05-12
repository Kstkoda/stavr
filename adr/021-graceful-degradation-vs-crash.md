# ADR 021 — Graceful degradation, not crash

**Status**: Accepted
**Date**: 2026-05-12

## Context

Spec 44 invariant 5 says Switch must prefer logging-and-continuing over crashing whenever a subsystem fails. The earlier code was inconsistent: some failures (`appendEvent` SQLite errors, broker fanout failures, gh CLI invocations) threw out of async handlers, which in a Node daemon either kills the process via `uncaughtException` or, worse, gets swallowed by `unhandledRejection` and leaves the daemon in a half-broken state.

We needed an explicit policy on which failures may crash the daemon and which must degrade gracefully — and a top-level safety net for the ones we missed.

## Decision

The policy is now:

1. **Crash on unrecoverable startup failures only.** Examples that justify `process.exit(1)`:
   - HTTP port permanently bound by another process and there's no fallback path (daemon mode).
   - SQLite DB file present but unreadable AND we can't rename it out of the way.
   - Programming errors caught at the top level (uncaughtException / unhandledRejection — these always crash, after writing a dump).

2. **Otherwise, degrade.** Concretely:
   - **`EventStore.appendEvent` failure** → `Broker.publish` catches, logs via `getLogger().error`, synthesizes an in-memory `StoredEvent` and continues fan-out so subscribers still see the event live (it just won't be in the replay log). This is the right tradeoff for the on-host single-daemon model: an in-memory event that one subscriber missed is better than a dead daemon that everyone missed.
   - **Broker fanout failure on one subscriber** → already handled (the subscription is removed from the map; other subscribers continue). Verified, no change.
   - **SQLite DB corruption detected at startup** → `EventStore.init` catches the failure, renames the file to `cowire.db.corrupt.<timestamp>`, and reopens a fresh DB. The daemon then publishes an `error` event with `recoverable: true` and `attempted_recovery` describing the rename, so the dashboard and oncall see the recovery.
   - **gh CLI invocation failure** → already wrapped in `GhWriteError` and returned as a typed tool error. The daemon does not crash on gh auth expiry; the tool call returns `{ ok: false, error }` and the caller decides what to do.

3. **Backstop everything else with a crash dump.** `installCrashHandler(store)` registers `uncaughtException` and `unhandledRejection` handlers that write a JSON dump to `~/.cowire/crash-<timestamp>.json` (containing the error, stack, recent 100 events, and PID) and then `process.exit(1)`. The watchdog (ADR-020) restarts us. No silent crashes.

## Consequences

- Single-host robustness goes way up. The daemon survives transient SQLite contention, missing gh auth, dropped subscribers — failure modes that used to require a manual restart.
- The replay log can theoretically drift from the live event stream if `appendEvent` is failing repeatedly. Acceptable: the daemon emits an `error` event each time, so the drift is visible. If it becomes a routine problem we'll need a more aggressive remediation (move to a fresh DB), but we'd rather discover that condition than silently lose events.
- The corruption-recovery path is *destructive*: a renamed `cowire.db.corrupt.<ts>` is left on disk and an empty DB takes its place. We chose this default over "halt and wait for a human" because the most common cause of corruption is power loss on a non-WAL filesystem — and in that case, the user wants the daemon back up so they can see whether anything in flight survived. The corrupt file remains on disk for forensic recovery if needed. Future work (out of scope for v1): a flag `--db-corruption=halt` for users who'd rather refuse to start.
- The crash-dump handler is intentionally simple: it writes the JSON file synchronously and exits. It does NOT try to flush the SQLite WAL or close transports. We rely on the watchdog to restart and on SQLite's WAL recovery to do the right thing on next open.

## Alternatives considered

- **Wrap every async handler in a try/catch and exit on any failure.** Same fragility we had before; doesn't differentiate "transient subsystem hiccup" from "real catastrophe."
- **Use a global error event bus and let subscribers decide.** Over-engineered for v1. The current model — log + emit `error` event + continue — gives subscribers full visibility without needing them to opt in.
- **Halt on corruption instead of rebuilding.** Less destructive, but means the daemon can't come up after a power-loss crash without manual intervention — exactly the case the watchdog is meant to handle. Default is rebuild + emit warning.
