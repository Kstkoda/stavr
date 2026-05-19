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
 * Where this is wired (and where it isn't, intentionally):
 *
 *   wired in Phase 3:
 *     - cross-peer federation events that carry a Tier 3 action
 *     - the docs example in `docs/family-mode.md` Phase 7
 *
 *   NOT wired in Phase 3 (deferred to v0.7.1):
 *     - host_exec's EXPLICIT-tagged paths — that's the
 *       v0_7-tier-3-explicit-consent BOM's domain. Per Phase 0 findings,
 *       passkey + typed-friction-string are complementary: passkey
 *       proves presence (this module), friction proves target
 *       articulation (the deferred BOM).
 *     - the orchestrator's worker_spawn/dispatch gate — Worker tiers
 *       resolve to 'auto'|'confirm'|'never' in the spawner contract,
 *       which doesn't currently surface EXPLICIT. v0.7.1 adds the
 *       resolved-via-categories.ts path so this gate can be applied.
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
