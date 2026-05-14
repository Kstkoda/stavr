# ADR 008 — gh CLI write actions go through `await_decision`

**Status**: Inferred — please confirm
**Date**: 2026-05-12

## Context

The GitHub adapter in v0.1 exposes 14 read-only tools. Spec 39 ("Co actions and tiered authorization") classifies external actions into three tiers — AUTO (safe, read-only or scoped reads), CONFIRM (any state change a human should sign off on), NEVER (out of scope for the agent at all). The GitHub *write* surface (commenting, opening issues, closing PRs, merging, force-pushing) is all CONFIRM or NEVER. The question is how the agent *requests* a confirm step at runtime.

## Decision

GitHub write actions, when they ship, will be exposed as MCP tools whose handler opens an `await_decision` rendezvous before issuing the `gh` call. The decision's `question` describes the proposed action ("Comment on PR #42: 'Looks good to me'?"), the `options` are `approve` / `deny`, and the response gates whether the underlying `gh` call runs. Switch never holds a long-lived write token; it relies on the host's `gh auth login` (see [ADR-003](./003-gh-cli-not-octokit.md)) and gates *invocation*, not credentials.

## Consequences

- **Single auth model.** No separate write-token to issue, scope, or rotate. The user's `gh` already has the right scope; we just decide whether to *call* it.
- **Every write is a question.** The dashboard sees a `decision_request` event for every proposed write, plus the `decision_response` that resolved it. Full audit trail.
- **One mechanism for human-in-the-loop.** All approvals go through the same path. Future tiered-auth policies (auto-approve trivial comments after the user has approved 10 of them, etc.) layer on top of `await_decision`'s callback machinery without changing the broker contract.
- **Latency.** Every write blocks until a human (or auto-approval policy) responds, capped at 30 minutes. Acceptable for agent workflows; would be wrong for high-throughput automation.

## Alternatives considered

- **Separate "write token" model.** Issue an OAuth token with write scope on demand, hand it to the agent. Multiplies the auth surface and decouples the *decision to write* from the *act of writing*, which is exactly the boundary we want to keep close together.
- **Whitelist of safe writes that bypass approval.** Slippery slope — "comments are safe" until they aren't. We can layer auto-approval policies on top of `await_decision` later without weakening the default gate.
- **No write actions at all.** Available today (v0.1 has none). Eventually limits Stavr to read-only co-pilot work, which contradicts the spec 39 vision of agents acting on the user's behalf.
