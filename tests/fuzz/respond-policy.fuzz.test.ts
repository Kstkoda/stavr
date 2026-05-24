/**
 * Phase 5 fuzz — decision-respond gate (mayRespond).
 *
 * The respond-policy module (src/security/respond-policy.ts) is the
 * single authority for "may THIS verified caller respond to THAT
 * decision?" — the family-mode security floor introduced in Phase 4.5.
 *
 * Properties asserted:
 *
 *   1. `mayRespond` is total — never throws — for any (decision,
 *      verifiedCaller) shape, including arbitrary source_agent strings.
 *
 *   2. Self-approval invariant: when decision.source_agent is non-empty
 *      AND verifiedCaller === decision.source_agent, the response is
 *      ALWAYS refused with `responder_is_requester`. No caller shape
 *      (operator, notify, peer, gibberish) can override.
 *
 *   3. Non-operator invariant: when verifiedCaller is neither
 *      loopback-shaped nor notify-shaped (and self-approval doesn't
 *      kick in first), the response is ALWAYS refused with
 *      `operator_required`. Holds for any `peer:*`, any UUID, any
 *      empty string.
 *
 *   4. Legacy-fall-open invariant: when source_agent is undefined (NULL
 *      on disk — Phase 3-and-earlier decisions), the self-approval
 *      rule cannot fire. Pre-Phase-4 rows must remain answerable by
 *      any operator-shaped caller.
 *
 *   5. Allow-shape invariant: a verified loopback or notify caller
 *      whose identity differs from source_agent is ALWAYS allowed.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  mayRespond,
  isLoopbackActor,
  isNotifyVerifiedRemote,
  isOperatorAuthorized,
} from '../../src/security/respond-policy.js';
import { fuzzSeed, RUNS } from './seed.js';

// Caller-shape arbitraries — keep the bias roughly balanced so the
// suite hits self-approval, non-operator, and allow paths often.
const loopbackArb = fc.oneof(
  fc.constant('unstamped-loopback'),
  fc.string({ minLength: 1, maxLength: 32 }).map((s) => `loopback:${s}`),
);
const notifyArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .map((s) => `notify:${s}`);
const peerArb = fc.string({ minLength: 1, maxLength: 32 }).map((s) => `peer:${s}`);
const otherArb = fc.oneof(
  fc.constant(''),
  fc.constant('cc'),
  fc.constant('cowork-user'),
  fc.string({ minLength: 1, maxLength: 32 }),
);
const callerArb = fc.oneof(loopbackArb, notifyArb, peerArb, otherArb);

// DecisionRecord.tier is `'CONFIRM' | 'EXPLICIT'` (persistence.ts:95).
// Phase 4.5 widened the rule so mayRespond ignores tier today — but
// the doc-comment marks re-introducing a tier-conditional in mayRespond
// as the single-function extension point for per-tier responder sets.
// Using the production type here means a future EXPLICIT-tier branch
// would actually be exercised by these properties, instead of being
// silently invisible behind impossible TIER_1/TIER_2/TIER_3 inputs.
const decisionArb = fc.record({
  source_agent: fc.option(
    fc.oneof(loopbackArb, notifyArb, peerArb, fc.string({ minLength: 1, maxLength: 32 })),
    { nil: undefined },
  ),
  tier: fc.option(fc.constantFrom('CONFIRM', 'EXPLICIT'), { nil: undefined }),
});

describe('Phase 5 fuzz — mayRespond', () => {
  it('is total for any (decision, verifiedCaller) input', () => {
    fc.assert(
      fc.property(decisionArb, callerArb, (decision, caller) => {
        const r = mayRespond(decision, caller);
        return r.ok === true || r.ok === false;
      }),
      { seed: fuzzSeed('respond-total'), numRuns: RUNS },
    );
  });

  it('always refuses self-approval (responder_is_requester) when source_agent is non-empty and matches caller', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }), (identity) => {
        const r = mayRespond(
          { source_agent: identity, tier: undefined },
          identity,
        );
        return r.ok === false && r.error === 'responder_is_requester';
      }),
      { seed: fuzzSeed('respond-self-approval'), numRuns: RUNS },
    );
  });

  it('always refuses non-operator callers (operator_required) when self-approval does not apply', () => {
    // Construct a non-operator caller and a non-matching source_agent so
    // self-approval cannot fire and short-circuit the rule.
    const callerNonOpArb = fc.oneof(peerArb, otherArb).filter((s) => !isOperatorAuthorized(s));
    fc.assert(
      fc.property(callerNonOpArb, fc.string({ minLength: 1, maxLength: 32 }), (caller, src) => {
        if (caller === src) return true; // skip self-approval collisions
        const r = mayRespond({ source_agent: src, tier: undefined }, caller);
        return r.ok === false && r.error === 'operator_required';
      }),
      { seed: fuzzSeed('respond-non-operator'), numRuns: RUNS },
    );
  });

  it('always allows operator-shaped callers when source_agent is undefined (legacy fall-open)', () => {
    const operatorArb = fc.oneof(loopbackArb, notifyArb);
    fc.assert(
      fc.property(operatorArb, (caller) => {
        const r = mayRespond({ source_agent: undefined, tier: undefined }, caller);
        return r.ok === true;
      }),
      { seed: fuzzSeed('respond-legacy-fall-open'), numRuns: RUNS },
    );
  });

  it('always allows operator-shaped callers when identity differs from source_agent', () => {
    const operatorArb = fc.oneof(loopbackArb, notifyArb);
    fc.assert(
      fc.property(operatorArb, fc.string({ minLength: 1, maxLength: 32 }), (caller, src) => {
        if (caller === src) return true; // self-approval — skip
        const r = mayRespond({ source_agent: src, tier: undefined }, caller);
        return r.ok === true;
      }),
      { seed: fuzzSeed('respond-operator-allow'), numRuns: RUNS },
    );
  });

  it('isLoopbackActor / isNotifyVerifiedRemote / isOperatorAuthorized are total and consistent', () => {
    fc.assert(
      fc.property(callerArb, (caller) => {
        const lb = isLoopbackActor(caller);
        const nv = isNotifyVerifiedRemote(caller);
        const op = isOperatorAuthorized(caller);
        // op MUST be exactly lb || nv (alignment property — no path
        // around the predicate).
        return op === (lb || nv);
      }),
      { seed: fuzzSeed('respond-predicates'), numRuns: RUNS },
    );
  });
});
