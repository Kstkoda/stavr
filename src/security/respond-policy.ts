/**
 * Decision-response authorization policy — family-mode-phase-1 Phase 4.5.
 *
 * This module owns the answer to: "may THIS verified caller respond to
 * THAT decision?" — and it is the **single extension point** for that
 * question across the whole codebase. Every code path that decides
 * whether to record a response goes through `mayRespond`. Future
 * widening (WebAuthn-verified remote operator, delegated approvers,
 * per-tier responder sets, role-based answer rules) must be a change to
 * this function only — call sites and store-level defenses do not move.
 *
 * Why this exists (and what Phase 4 missed):
 *
 *   Phase 4 closed the self-approval hole by adding `source_agent` and
 *   `tier` columns to the decisions table and refusing a response from
 *   the original requester. But the rules compared against the
 *   `responder` STRING ARGUMENT of the respond_to_decision MCP tool,
 *   which is self-asserted by the caller. A paired peer could evade the
 *   check by passing a different string, and could pass
 *   `responder: 'user-direct'` to satisfy the EXPLICIT operator-only
 *   check. The closure was real for honest actors and decorative for
 *   lying ones — exactly the failure mode the HARD RULE exists to
 *   prevent. Phase 4.5 closes it structurally by deriving the
 *   responder from VERIFIED identity at every call site.
 *
 * Today's policy (loopback-only, every tier):
 *
 *   - The verified caller must be the operator. "Operator" today means a
 *     LOOPBACK caller — the daemon's own host. Loopback is sovereign per
 *     the existing trust model and the actor_id values the HTTP
 *     transport stamps (`loopback:<correlation_id>` for verified /mcp
 *     loopback, `unstamped-loopback` for stdio MCP sessions where no
 *     HTTP middleware ran). A paired peer is stamped `peer:<name>` by
 *     the bearer-auth middleware (transports.ts) and is therefore
 *     structurally unable to satisfy this check — the spoof is killed.
 *   - The verified caller must not equal the decision's `source_agent`
 *     (no self-approval). This is the Phase 4 rule, now operating on a
 *     trustworthy actor identity.
 *   - The synthetic `switch-default` responder (timeout fallback) is an
 *     internal-only caller and bypasses this function — see the call
 *     path in `runChokepointDecision` (src/security/decision-gate.ts)
 *     and the equivalent fallback in `gatedAction`
 *     (src/tools/gated-action.ts). It never collides with source_agent
 *     and must remain able to close any open decision so the gate
 *     cannot hang past its deadline.
 *
 * Out of scope (deferred to the operator):
 *
 *   - Verified-remote operator paths (notify-via-Telegram/email, future
 *     federated peers). The notify subsystem's reply-router has its own
 *     HMAC sigil verification today and writes responder=`notify:*`
 *     directly to the store; this function does NOT cover that path.
 *     The store-level defense in `respondToDecision` accepts `notify:*`
 *     as a documented legacy-verified-remote carve-out so the existing
 *     channel keeps working; widening this function to formally accept
 *     it (or replacing the carve-out) is a design call for the operator
 *     per the Phase 4.5 stop condition.
 */
import type { DecisionRecord } from '../persistence.js';

/**
 * Verified caller is loopback iff actor_id matches the shape the HTTP
 * transport stamps for loopback callers, or the stdio default (`unstamped-
 * loopback`). Anything starting with `peer:` is a paired remote caller and
 * therefore not the operator.
 */
export function isLoopbackActor(actor: string): boolean {
  return actor === 'unstamped-loopback' || actor.startsWith('loopback:');
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

  // Operator-only at every tier. A paired peer (peer:*) is never the
  // operator regardless of what they claim in the tool input. The
  // structural answer is: only a loopback caller can approve.
  if (!isLoopbackActor(verifiedCaller)) {
    return {
      ok: false,
      error: 'operator_required',
      reason:
        `verified caller "${verifiedCaller}" is not a loopback (operator) ` +
        `caller; this BOM's policy is that only the operator may respond ` +
        `to gated decisions. Widening this rule (verified-remote operator, ` +
        `delegated approvers, per-tier responder sets) is a single-function ` +
        `change in src/security/respond-policy.ts`,
    };
  }

  return { ok: true };
}
