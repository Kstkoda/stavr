# ADR 024 — Reporting cadences and channels for trust scopes

**Status**: Accepted
**Date**: 2026-05-12

## Context

A granted trust scope authorizes batched autonomous work. Without progress
reporting, Kenneth has no signal between grant and completion — the whole
point of the model is that he stops being part of every approval. So the
reporter has to surface enough that he can spot trouble and revoke before
damage piles up.

We also have to obey ADR-012 (event-driven over polling). Time-based reporting
is the awkward case.

## Decision

A scope declares its `reporting.cadence` from a closed enum of four:

- **`every-action`** — emit a `trust_scope_progress` event after every
  authorized action. Highest signal, highest noise. Reasonable for
  high-stakes scopes (e.g. label sweeps on production repos).
- **`every-5-actions`** — emit on every 5th authorized action. The default.
  Tuned for batched migrations where individual progress is uninteresting but
  the rough rate is. With `expires_after_actions: 20`, this yields ~4
  intermediate reports plus a completion summary.
- **`every-15-min`** — bounded one-shot `setTimeout(15 * 60_000)`, reset on
  each emit, on top of the action-event subscription. Fires regardless of
  action volume — useful for long-running scopes with sparse actions.
  Explicit ADR-012 exception: bounded one-shot, not a polling loop.
- **`on-completion-only`** — single `trust_scope_completed` event at cap or
  expiry. Use when intermediate progress would be noise.

Every scope-termination path (action cap reached, time expired, revoked)
emits a final `trust_scope_completed` event with the reason and the final
action count. This event is independent of the cadence — `on-completion-only`
just means *no intermediate progress events*.

v1 channels: `chat` and `event-log`. Chat is event fan-out via the existing
subscriber pattern (Co + Cowork get notifications). Event log is the SQLite
persistence path — queryable via `get_events --kind=trust_scope_progress
--by-scope=<id>`.

Future channels (deferred to spec 45 — remote access): `slack`, `email`,
`dashboard panel`. The `channels` field already accepts these enum values; we
just don't deliver to them yet.

## Consequences

- Four cadences is enough to cover the named use cases without a custom DSL.
  Adding a fifth (e.g. `every-N-actions`) is a small follow-up and doesn't
  break existing scopes.
- The `every-15-min` timer is bounded and unref'd at the timer level — a
  scope that's revoked or completes early cancels its timer. We accepted that
  one timer per active `every-15-min` scope is fine; the live count is
  typically O(1).
- `trust_scope_completed` always fires once per scope. Tests rely on this.
- Slack / email / dashboard channels are accepted in the schema today but are
  no-ops at the reporter layer. Once spec 45 ships, they become deliverers
  without changing the scope shape.

## Alternatives considered

- **One cadence (every-N actions)** — too rigid for long, low-volume scopes.
- **Free-form cron expression** — over-engineered for the v1 surface; introduces
  parsing complexity for a feature whose payoff is small.
- **Always emit, let subscribers throttle** — pushes complexity onto consumers
  and floods the event log. Throttling at source is cheaper.
- **No 15-min timer (poll on event-driven only)** — sparse scopes would go
  silent for hours. A bounded one-shot is the smallest deviation from ADR-012
  that solves it.
