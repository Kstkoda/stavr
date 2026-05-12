# ADR 022 — Trust scopes supersede per-action CONFIRM for the common case

**Status**: Accepted
**Date**: 2026-05-12

## Context

Cowire's spec 39 tier model gates every CONFIRM-tier action (worker_spawn,
github.create_pr, github.merge_pr, github.create_issue, …) behind its own
`await_decision`. Approving a ten-issue migration meant ten round-trips through
Cowork to Kenneth and back. The cost was Kenneth's attention, and at ten
approvals it was already too high to scale to the spec-driven autonomous
workflow Cowire is aiming at.

Kenneth's framing (2026-05-12): approve *a plan*, then let agents execute the
plan, while reports stream back. That maps cleanly to OAuth-scope semantics:
a typed, time-bounded, action-bounded permission grant.

## Decision

A **trust scope** is the unit of plan-level approval. Granting one moves
CONFIRM-tier checks for *matching* tool calls from per-call `await_decision`
to per-scope `await_decision` (just the one `trust_scope_grant`). Out-of-scope
CONFIRM-tier calls still gate per-call. NEVER-tier (ADR-018) is unaffected.

Concretely, every CONFIRM-tier handler still calls `gatedAction` (or
`WorkerOrchestrator.gate`). The new behaviour is inside that helper: if the
broker has a `TrustStore` and an active scope covers the (tool, args) pair, the
action runs immediately, the call is recorded in `scope_actions`, and a
`trust_scope_action_authorized` event is emitted. Otherwise the existing
decision-request path runs unchanged.

## Consequences

- Plan-level approval becomes the default for batched, predictable work
  (migrations, label sweeps, multi-PR roll-outs). The audit log now keys every
  authorized action to its `scope_id`, so "who allowed this and when" is
  answerable in one query.
- The lifecycle adds new failure modes the per-call gate didn't have:
  expiration by time, expiration by action count, mid-execution revoke. All
  three terminate the scope and force subsequent in-scope actions back to the
  CONFIRM gate. We accept this surface area because it's the price of
  scope semantics — and revoke is the escape hatch Kenneth needs.
- Forbidden matchers act as a per-scope deny-list (e.g. "allow github.* on this
  repo but never `merge_pr` against `main`"). This is a strict override even
  when an `allowed_actions` matcher would otherwise pass.
- We accepted no change to NEVER-tier behaviour. ADR-018 stays inviolate;
  trust scopes cannot grant force-push, branch-delete, or destructive flags.

## Alternatives considered

- **Just raise the per-action timeout** — doesn't address attention cost; ten
  approvals at any timeout is still ten approvals.
- **Auto-approve everything CONFIRM-tier during a session** — too coarse;
  Kenneth wants typed scopes ("migrate BUGS to issues") not session-wide trust.
- **Move CONFIRM tools to AUTO and rely on revocation** — irreversible blast
  radius. Scopes give us bounded autonomy (time + count + tool + params) which
  per-tool tier flags can't express.
- **One approval per *call site* (handler) rather than per *plan*** — same
  attention pattern as today; doesn't bundle related actions into a single
  human decision.
