/**
 * Phase 5 fuzz — trust scope matcher (matchesOne / scopeCovers).
 *
 * The trust scope matcher (src/trust/matcher.ts) drives the per-tool
 * authorization decision. Two invariants matter most:
 *
 *   - forbidden_actions ALWAYS overrides allowed_actions. If a tuple
 *     matches both lists, the scope must NOT cover it.
 *   - status !== 'active' refuses the call regardless of match. An
 *     expired/revoked/proposed/completed scope must never cover
 *     anything.
 *
 * Properties asserted:
 *
 *   1. `matchesOne` is total — never throws — for any (matcher, tool,
 *      args) shape, including args that are not records.
 *
 *   2. `scopeCovers` is total for any (scope, tool, args) shape.
 *
 *   3. status-floor invariant: when status !== 'active', scopeCovers
 *      returns false for any (tool, args). Holds across all
 *      non-active TrustScopeStatus values.
 *
 *   4. forbidden-overrides invariant: when a tool+args pair matches
 *      both an allowed_actions matcher AND a forbidden_actions matcher,
 *      scopeCovers returns false.
 *
 *   5. constraint-mismatch invariant: a matcher with
 *      param_constraints does NOT cover non-record args.
 *
 *   6. regex-constraint behaviour: a constraint string starting with
 *      "^" is interpreted as a regex against String(value); invalid
 *      regex syntax returns false (no throw).
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { matchesOne, scopeCovers } from '../../src/trust/matcher.js';
import type { TrustScope, TrustScopeStatus } from '../../src/trust/types.js';
import { fuzzSeed, RUNS } from './seed.js';

const TOOL_ARB = fc.string({ minLength: 1, maxLength: 32 });

const PRIMITIVE_ARB = fc.oneof(
  fc.string({ maxLength: 32 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

// Param-constraint values are either deepEqual matched or, if a string
// starting with "^", interpreted as regex against String(value).
const CONSTRAINT_VALUE_ARB = fc.oneof(
  PRIMITIVE_ARB,
  fc.string({ maxLength: 16 }).map((s) => `^${s}$`),
  fc.constant('^.*$'),
  fc.constant('^[a-z]+$'),
);

const PARAM_CONSTRAINTS_ARB = fc.option(
  fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), CONSTRAINT_VALUE_ARB, {
    maxKeys: 4,
  }),
  { nil: undefined },
);

const MATCHER_ARB = fc.record({
  tool: TOOL_ARB,
  param_constraints: PARAM_CONSTRAINTS_ARB,
  reason: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
});

const ARGS_ARB = fc.oneof(
  fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), PRIMITIVE_ARB, { maxKeys: 4 }),
  PRIMITIVE_ARB,
  fc.array(PRIMITIVE_ARB, { maxLength: 4 }),
);

function makeScope(overrides: Partial<TrustScope>): TrustScope {
  return {
    id: 'fuzz-scope',
    title: 'fuzz',
    description: 'fuzz',
    granted_by: 'fuzz',
    granted_at: new Date(0).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    allowed_actions: [],
    forbidden_actions: [],
    reporting: { cadence: 'every-action', channels: ['event-log'] },
    status: 'active',
    actions_executed: 0,
    ...overrides,
  };
}

describe('Phase 5 fuzz — matchesOne', () => {
  it('is total for any (matcher, tool, args) input', () => {
    fc.assert(
      fc.property(MATCHER_ARB, TOOL_ARB, ARGS_ARB, (matcher, tool, args) => {
        const r = matchesOne(matcher as never, tool, args);
        return typeof r === 'boolean';
      }),
      { seed: fuzzSeed('matcher-total'), numRuns: RUNS },
    );
  });

  it('returns false when tool name does not match', () => {
    fc.assert(
      fc.property(MATCHER_ARB, TOOL_ARB, ARGS_ARB, (matcher, tool, args) => {
        if (matcher.tool === tool) return true; // skip the matching case
        return matchesOne(matcher as never, tool, args) === false;
      }),
      { seed: fuzzSeed('matcher-tool-mismatch'), numRuns: RUNS },
    );
  });

  it('returns false when constraints exist but args is not a record', () => {
    fc.assert(
      fc.property(
        // matcher must have a constraint set
        fc
          .record({
            tool: TOOL_ARB,
            param_constraints: fc.dictionary(
              fc.string({ minLength: 1, maxLength: 8 }),
              CONSTRAINT_VALUE_ARB,
              { minKeys: 1, maxKeys: 3 },
            ),
          })
          .filter((m) => Object.keys(m.param_constraints).length > 0),
        // args is a primitive or array (not a record)
        fc.oneof(PRIMITIVE_ARB, fc.array(PRIMITIVE_ARB, { maxLength: 3 })),
        (matcher, args) => {
          return matchesOne(matcher as never, matcher.tool, args) === false;
        },
      ),
      { seed: fuzzSeed('matcher-non-record'), numRuns: RUNS },
    );
  });
});

describe('Phase 5 fuzz — scopeCovers', () => {
  it('is total for any (scope, tool, args) input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TrustScopeStatus>(
          'proposed',
          'active',
          'expired',
          'revoked',
          'completed',
        ),
        fc.array(MATCHER_ARB, { maxLength: 3 }),
        fc.array(MATCHER_ARB, { maxLength: 3 }),
        TOOL_ARB,
        ARGS_ARB,
        (status, allowed, forbidden, tool, args) => {
          const scope = makeScope({
            status,
            allowed_actions: allowed as never,
            forbidden_actions: forbidden as never,
          });
          const r = scopeCovers(scope, tool, args);
          return typeof r === 'boolean';
        },
      ),
      { seed: fuzzSeed('scope-covers-total'), numRuns: RUNS },
    );
  });

  it('returns false for any non-active status, regardless of matchers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TrustScopeStatus>('proposed', 'expired', 'revoked', 'completed'),
        MATCHER_ARB,
        TOOL_ARB,
        ARGS_ARB,
        (status, matcher, tool, args) => {
          const scope = makeScope({
            status,
            allowed_actions: [{ ...matcher, tool } as never], // guarantee a "would-match" entry
          });
          return scopeCovers(scope, tool, args) === false;
        },
      ),
      { seed: fuzzSeed('scope-covers-inactive'), numRuns: RUNS },
    );
  });

  it('forbidden_actions always overrides allowed_actions', () => {
    fc.assert(
      fc.property(TOOL_ARB, ARGS_ARB, (tool, args) => {
        // Build a matcher with no constraints — guaranteed to match any args
        // for the given tool. Put the same matcher in both allowed and
        // forbidden; scope must NOT cover.
        const m = { tool } as never;
        const scope = makeScope({
          status: 'active',
          allowed_actions: [m],
          forbidden_actions: [m],
        });
        return scopeCovers(scope, tool, args) === false;
      }),
      { seed: fuzzSeed('scope-covers-forbidden'), numRuns: RUNS },
    );
  });

  it('covers when active + matches allowed + does not match forbidden', () => {
    fc.assert(
      fc.property(TOOL_ARB, ARGS_ARB, (tool, args) => {
        const m = { tool } as never;
        const scope = makeScope({
          status: 'active',
          allowed_actions: [m],
          forbidden_actions: [], // explicitly empty
        });
        return scopeCovers(scope, tool, args) === true;
      }),
      { seed: fuzzSeed('scope-covers-active-allowed'), numRuns: RUNS },
    );
  });

  it('handles invalid regex constraints by returning false (no throw)', () => {
    // Constraints starting with "^" are interpreted as regex; an
    // unbalanced bracket should produce false, not throw.
    fc.assert(
      fc.property(fc.constantFrom('^[unclosed', '^(', '^*'), (badPattern) => {
        const matcher = {
          tool: 'do-thing',
          param_constraints: { x: badPattern },
        } as never;
        return matchesOne(matcher, 'do-thing', { x: 'value' }) === false;
      }),
      { seed: fuzzSeed('scope-covers-bad-regex'), numRuns: 30 },
    );
  });
});
