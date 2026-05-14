# ADR 018 — Destructive GitHub operations remain manual

**Status**: Accepted
**Date**: 2026-05-12

## Context

[ADR-008](./008-write-actions-await-decision.md) established that GitHub write actions are exposed as MCP tools gated by `await_decision`. Spec 39 ("Co actions and tiered authorization") classifies every action into AUTO / CONFIRM / NEVER tiers. Phase B (this commit) ships the CONFIRM-tier writes: `create_pr`, `merge_pr` (squash + delete-branch), `create_issue`, comment tools, label tools, `request_pr_review`, `close_issue`, `reopen_issue`.

What it does NOT ship — and this ADR records the decision that it never will, without a deliberate future ADR superseding this one — is the set of *destructive* operations whose blast radius is large and whose typical recovery path is "git surgery" or "ask GitHub support."

## Decision

The following operations are **NEVER tier**. They are out of scope for Stavr's GitHub adapter even with human approval. The user runs them manually with full awareness of what they're doing:

- **Force-push** (`git push --force`, `git push --force-with-lease`) to any branch, including the agent's own working branch. Force-push rewrites history; downstream collaborators lose work silently.
- **Branch delete** (`gh api -X DELETE`, `git push origin :branch`). The squash-merge path already deletes the source branch automatically (`--delete-branch`); arbitrary branch deletion outside of that flow is not exposed.
- **`gh pr merge --force`**, `--rebase` with `--admin`, or any other override of branch-protection / required-checks. If a merge is failing because CI is red, the answer is to fix CI, not to bypass it.
- **Repository settings changes**: branch-protection rules, collaborator/role mutations, repo visibility, secrets, webhooks, deploy keys. These can leak access or silently weaken the safety boundary on which every other tool depends.
- **Tag/release deletion**. Tags are immutable references that other tooling and humans assume are stable.

These can change once we have a real audit-and-rollback story for them. Today we do not, so the answer is "manual only."

## Consequences

- **Bounded blast radius for the agent.** The worst Stavr can do with `gh` is "open a noisy PR" or "make a wrong comment." Recoverable in minutes by a human. No history rewrites, no silent permission changes.
- **Force-push remediation stays in the user's hands.** When CC and Co make a mistake on a branch, Kenneth resolves it via `git` directly. This is the right amount of friction for an action whose default outcome is "you lost three days of someone else's work."
- **Slight friction for legitimate cases.** Occasionally a force-push *is* the right move (cleaning up a mid-flight WIP branch before review). The cost of that friction is acceptable — the action is rare and the user is the right decision-maker.
- **The CONFIRM tier stays small.** Every tool added to the gated set is a tool a human approves; if approvals become routine for a class of action, the path forward is auto-ack policies on top of `await_decision` ([ADR-008](./008-write-actions-await-decision.md)) — *not* moving things into NEVER and re-exposing them.

## Alternatives considered

- **Expose destructive ops gated by stricter approval** (e.g. require typing the branch name, double-confirm). Rejected: the failure mode is silent data loss, and the same UX that traps a human into "yes, click again" traps an agent into "yes, call respond_to_decision again." The blast radius is too large to put behind any approval flow we trust today.
- **Expose force-push only to the agent's *own* working branch.** Rejected: the agent doesn't have a well-defined notion of "my branch" — a per-spawn branch becomes a shared review branch the moment a PR opens. Drawing the line later is harder than drawing it here.
- **No NEVER tier at all; let `await_decision` mediate everything.** Rejected by spec 39 — the tier model exists because some actions don't belong to an agent's repertoire even with consent.

## References

- [ADR-008 — gh CLI write actions through `await_decision`](./008-write-actions-await-decision.md)
- `../privacy tracker/specs/39_co-actions-and-tiered-authorization.md` §"NEVER tier"
