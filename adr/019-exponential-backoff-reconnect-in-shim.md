# ADR 019 — Exponential-backoff reconnect in the shim

**Status**: Accepted (supersedes ADR-009's "3 consecutive errors → exit" policy)
**Date**: 2026-05-12

## Context

ADR-009 shipped the stdio↔SSE shim with a deliberately blunt failure rule: after 3 consecutive SSE errors, exit non-zero so Cowork registers the failure instead of silently spinning on `ECONNREFUSED`. That rule worked well enough to ship Phase 1, but in normal operation we observed the shim disconnect twice on a transient SSE blip — a single dropped keepalive plus the EventSource auto-reconnect's own brief error stream was enough to trip the threshold. The result was that Cowork lost its Switch connection during a chat, and the user had to restart it.

Spec 44 raises the bar: Switch must be the kind of infrastructure you forget is there. A clean policy that distinguishes "the daemon is briefly unreachable" from "the daemon is gone for good" is needed.

## Decision

Replace the 3-error threshold with exponential backoff inside the shim itself, instead of relying on EventSource's built-in auto-reconnect:

- On SSE error, schedule a reconnect attempt with a starting delay of **1s**, doubling on each subsequent error within 30s, capped at **5 minutes**.
- 30s of clean operation (no error since the last success) resets the counter and the backoff.
- After **1 hour** without a successful connection, the shim logs `shim_giving_up` and exits 1 — at that point the daemon is genuinely down and the watchdog (ADR-020) is the right layer to recover, not the shim.
- On successful reconnect, the shim fetches the daemon's `/status` and compares `started_at` against the last known value; if it changed, it logs `daemon restart detected (uptime reset)` so the gap is visible in the log. It also emits a `progress` event with body `shim_reconnected after Xms` so subscribers (dashboards, oncall) see the gap as an event, not just a log line.

The shim implements this by wrapping `SSEClientTransport` and tearing it down / recreating it explicitly. We do not delegate to EventSource's built-in auto-reconnect because it surfaces a stream of `onerror` events during retry that the old code mistook for sustained failure.

## Consequences

- The "the daemon blinked" failure mode disappears: a single blip costs 1s, not a process exit.
- The "the daemon is down for real" failure mode still terminates the shim cleanly — Cowork sees a non-zero exit instead of a permanently hanging stdio bridge.
- The shim emits a `progress` event on every reconnect, which adds a small amount of log noise during a flaky network. Acceptable: the alternative is a silent reconnect that hides bugs.
- The reconnect uses a fresh `SSEClientTransport` instance each time. This means we lose any in-flight JSON-RPC request that was on the wire when the connection dropped. Acceptable for v1; if Cowork needs request-resume we can layer it on top later — the protocol allows the client to retry idempotent calls itself.

## Alternatives considered

- **Keep the 3-error threshold but raise it to 10.** Buys time but doesn't fix the underlying mismatch — the threshold is unit-less (errors, not time) and so it scales badly with network conditions.
- **Trust EventSource's built-in auto-reconnect.** That's how ADR-009 was originally written; in practice EventSource raises an error event per retry attempt, and the shim was counting those as separate failures. Owning the reconnect loop ourselves gives us the right signal.
- **Move the reconnect logic into the daemon-side transport.** Doesn't help — the daemon can't reconnect to a client; the client has to drive.
- **Use jittered backoff instead of plain doubling.** Considered useful for a future ADR if many shims reconnect against the same daemon (reconnect storm risk noted in spec 44). Not in v1: a single Cowork instance has one shim.
