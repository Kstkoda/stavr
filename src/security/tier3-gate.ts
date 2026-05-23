/**
 * Tier 3 EXPLICIT enforcement helper — ADR-042 §Decision 3 v0.7.
 *
 * Any code path that needs to gate a Tier 3 action on a fresh passkey
 * assertion calls `requireRecentTier3Assertion`. It returns `ok: true`
 * with the assertion details when the operator has authenticated within
 * the freshness window, or `ok: false` with a structured reason the
 * caller can surface to the operator (typically a redirect to the
 * dashboard's "Re-authenticate" prompt).
 *
 * Where this is wired (family-mode-phase-1 Phase 3):
 *
 *   - The structural chokepoint's EXPLICIT branch
 *     (`src/security/decision-gate.ts::buildChokepointGate`). Every MCP
 *     tool call whose per-actor tier resolves to EXPLICIT — including
 *     host_exec, worker_spawn / dispatch / terminate when matrix-
 *     escalated, and anything else the operator marks EXPLICIT —
 *     passes through `requireRecentTier3Assertion` BEFORE the
 *     operator-confirmation decision opens. On miss the chokepoint
 *     denies the call and emits `tier3_assertion_required` so the
 *     dashboard can prompt; on hit it falls through to the decision
 *     route (Phase 4 then enforces operator-only respond for EXPLICIT).
 *
 * Out of scope for this BOM (still deferred to the
 * `v0_7-tier-3-explicit-consent` BOM):
 *
 *   - The typed-friction-string ceremony. Passkey + typed-friction are
 *     complementary: passkey proves presence (this module + the
 *     chokepoint EXPLICIT branch); friction proves articulation of the
 *     specific target. Phase 4 of family-mode-phase-1 substitutes the
 *     operator-must-respond rule (`responder = 'user-direct'`) for the
 *     missing friction string at respond time; the typed-friction BOM
 *     will replace that substitute with the real ceremony when it
 *     lands.
 */
import type { IdentityStore, Tier3Assertion } from './identity-store.js';
import { DEFAULT_TIER3_ASSERTION_TTL_MS } from './webauthn.js';

export interface RequireOptions {
  /** Operator id whose assertion we require. Defaults to 'operator'. */
  operatorId?: string;
  /** When set, the assertion must match this correlation_id (per-action
   *  re-auth). When absent, any recent assertion suffices. */
  correlationId?: string;
  /** Override the freshness window. Defaults to 60s per ADR-042. */
  withinMs?: number;
  /** Override the clock — tests inject a fixed `now`. */
  now?: number;
}

export type Tier3Result =
  | { ok: true; assertion: Tier3Assertion }
  | {
      ok: false;
      reason:
        | 'no_recent_assertion'
        | 'assertion_expired'
        | 'correlation_mismatch';
      operator_id: string;
      hint: string;
    };

export function requireRecentTier3Assertion(
  identity: IdentityStore,
  opts: RequireOptions = {},
): Tier3Result {
  const operatorId = opts.operatorId ?? 'operator';
  const within = opts.withinMs ?? DEFAULT_TIER3_ASSERTION_TTL_MS;
  const now = opts.now ?? Date.now();
  const assertionOpts: Parameters<IdentityStore['hasRecentAssertion']>[0] = {
    operatorId,
    now,
  };
  if (opts.correlationId !== undefined) assertionOpts.correlationId = opts.correlationId;
  const found = identity.hasRecentAssertion(assertionOpts);

  if (!found) {
    return {
      ok: false,
      reason: opts.correlationId !== undefined ? 'correlation_mismatch' : 'no_recent_assertion',
      operator_id: operatorId,
      hint:
        opts.correlationId !== undefined
          ? `No matching passkey assertion for correlation "${opts.correlationId}". Re-auth required.`
          : 'No recent passkey assertion. Visit /dashboard/settings#identity to authenticate.',
    };
  }

  if (found.expires_at <= now) {
    return {
      ok: false,
      reason: 'assertion_expired',
      operator_id: operatorId,
      hint: 'Passkey assertion expired. Re-auth required.',
    };
  }

  // Stale assertions inside-window are allowed unless the caller insists
  // on a tighter freshness via `withinMs`.
  if (now - found.created_at > within) {
    return {
      ok: false,
      reason: 'no_recent_assertion',
      operator_id: operatorId,
      hint: `Passkey assertion older than ${within}ms. Re-auth required.`,
    };
  }

  return { ok: true, assertion: found };
}
