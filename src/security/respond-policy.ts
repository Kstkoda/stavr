/**
 * Decision-response authorization policy — family-mode-phase-1 Phase 4.5
 * (introduced) + Phase 4.6 (notify folded in as first-class).
 *
 * This module owns the answer to: "may THIS verified caller respond to
 * THAT decision?" — and it is THE single authority for that question
 * across the whole codebase. Every code path that decides whether to
 * record a response goes through `mayRespond`. The store-level check in
 * `respondToDecision` is a thin consistency backstop (matching this
 * function's accepted set), not a parallel looser policy. Future
 * widening (WebAuthn-verified remote operator on a paired peer,
 * delegated approvers, per-tier responder sets, role-based answer
 * rules) must be a change to this function only — call sites and the
 * store-level fence do not move.
 *
 * Why this exists (and what Phase 4 missed, what Phase 4.5 closed, what
 * Phase 4.6 cleaned):
 *
 *   Phase 4 closed the self-approval hole by adding `source_agent` and
 *   `tier` columns to the decisions table and refusing a response from
 *   the original requester. But the rules compared against the
 *   `responder` STRING ARGUMENT of the respond_to_decision MCP tool,
 *   which is self-asserted by the caller. A paired peer could evade the
 *   check by passing a different string, and could pass
 *   `responder: 'user-direct'` to satisfy the operator-only check. The
 *   closure was real for honest actors and decorative for lying ones —
 *   exactly the failure mode the HARD RULE exists to prevent.
 *
 *   Phase 4.5 closed the spoof structurally by deriving the responder
 *   from VERIFIED identity at every call site (logContext.actor_id,
 *   stamped by the HTTP transport from req.device or the kernel loopback
 *   signal). Phase 4.5 also left an intentional looseness at the store
 *   level: `notify:*` was a documented carve-out to keep the notify
 *   reply-router channel working.
 *
 *   Phase 4.6 folds that carve-out IN as a first-class case: `notify:*`
 *   is a verified-remote-operator channel because the notify subsystem
 *   has already verified the reply via HMAC sigil before it ever calls
 *   the store. The reply-router now calls `mayRespond` BEFORE the store
 *   call, the same way the tool layer does, and the store-level check
 *   becomes a thin alignment fence: same accepted set as this function.
 *
 * Today's policy (operator OR verified-remote, every tier):
 *
 *   - Loopback caller (`unstamped-loopback`, `loopback:*`) — the operator
 *     on the daemon's own host. The HTTP transport stamps `loopback:<corr>`
 *     for verified /mcp loopback; stdio MCP sessions fall through to
 *     `unstamped-loopback`. Loopback is the kernel-enforced ADR-006
 *     boundary; a peer cannot fake it.
 *
 *   - Notify-verified-remote (`notify:*`) — the operator replying via a
 *     channel the notify subsystem has cryptographically verified (HMAC
 *     sigil per the reply-router). Only the reply-router produces this
 *     identity; the tool layer cannot stamp it (HTTP middleware only
 *     emits `loopback:*` or `peer:*`). The HMAC verification stays in
 *     the reply-router; only the authorization decision lives here.
 *
 *   - Self-approval refused for any verified caller: if the caller's
 *     identity equals the decision's `source_agent`, the response is
 *     refused regardless of channel shape. Legacy decisions
 *     (source_agent === undefined) fall open on this rule — they predate
 *     Phase 4 and have no requester identity to compare against.
 *
 *   - `switch-default` (timeout fallback) is an internal-only synthetic
 *     responder used by `runChokepointDecision` and `gatedAction`. It
 *     never enters this function — the store-level shortcut handles it
 *     directly so the timeout path cannot deadlock against the policy.
 *
 * A paired peer (`peer:<name>`) is structurally unable to satisfy any of
 * these — that's the spoof Phase 4.5 killed. To formally widen to
 * verified-remote peers (WebAuthn-verified federated operator, delegated
 * approver registries, etc.), edit `mayRespond` here and nothing else.
 */
import type { DecisionRecord } from '../persistence.js';

/**
 * Verified caller is loopback iff actor_id matches the shape the HTTP
 * transport stamps for loopback callers, or the stdio default
 * (`unstamped-loopback`). Anything starting with `peer:` is a paired
 * remote caller and therefore not on this path.
 */
export function isLoopbackActor(actor: string): boolean {
  return actor === 'unstamped-loopback' || actor.startsWith('loopback:');
}

/**
 * Verified caller is the operator via a notify channel iff actor_id has
 * the `notify:*` shape the reply-router stamps after HMAC sigil
 * verification. The reply-router (`src/notify/reply-router.ts`) is the
 * ONLY production caller that emits this identity; no HTTP middleware
 * stamp produces it, so a peer cannot impersonate the shape.
 */
export function isNotifyVerifiedRemote(actor: string): boolean {
  return actor.startsWith('notify:');
}

/**
 * The full set of verified-operator identities mayRespond accepts today.
 * The store-level fence in `respondToDecision` keeps an aligned predicate
 * so it cannot accept a responder this function rejects.
 */
export function isOperatorAuthorized(actor: string): boolean {
  return isLoopbackActor(actor) || isNotifyVerifiedRemote(actor);
}

export type RespondPolicyResult =
  | { ok: true }
  | {
      ok: false;
      error: 'responder_is_requester' | 'operator_required';
      reason: string;
    };

export function mayRespond(
  decision: Pick<DecisionRecord, 'source_agent' | 'tier'>,
  verifiedCaller: string,
): RespondPolicyResult {
  // Self-approval: a verified caller cannot answer their own decision.
  // Legacy decisions (source_agent === undefined) fall open on this rule —
  // they predate Phase 4 and have no requester identity to compare
  // against.
  if (decision.source_agent && verifiedCaller === decision.source_agent) {
    return {
      ok: false,
      error: 'responder_is_requester',
      reason:
        `verified caller "${verifiedCaller}" is the original requester ` +
        `(source_agent on this decision); responses must come from a ` +
        `different actor`,
    };
  }

  // Operator-shape: loopback caller OR notify-verified-remote. Any other
  // identity (a paired `peer:*` actor, an unstamped HTTP request, an
  // unknown string) is refused. Widening this set is the single-function
  // extension point for verified-remote peers, delegated approvers, etc.
  if (!isOperatorAuthorized(verifiedCaller)) {
    return {
      ok: false,
      error: 'operator_required',
      reason:
        `verified caller "${verifiedCaller}" is not authorized to respond ` +
        `to gated decisions. Accepted shapes today: loopback ` +
        `(unstamped-loopback, loopback:*) or notify-verified-remote ` +
        `(notify:*). Widening (e.g., WebAuthn-verified peer) is a ` +
        `single-function change in src/security/respond-policy.ts`,
    };
  }

  return { ok: true };
}
