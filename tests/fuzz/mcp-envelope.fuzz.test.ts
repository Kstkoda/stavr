/**
 * Phase 5 fuzz — MCP envelope label normalisation.
 *
 * `normalizeMcpMethod` and `normalizeMcpToolName` (src/observability/
 * mcp-metrics.ts) sit on the gateway-metrics path: they're called once
 * per JSON-RPC envelope to collapse user-supplied `method` /
 * `params.name` into a bounded Prometheus label value. The "bounded"
 * part is the stability invariant — if it ever breaks, a hostile client
 * can blow Prometheus label cardinality and DoS the metrics scrape.
 *
 * Properties asserted:
 *
 *   1. `normalizeMcpMethod(any string | undefined)` is total — never
 *      throws — and always returns one of: KNOWN_TOOLS member,
 *      "unknown", "other".
 *
 *   2. `normalizeMcpToolName(any string | undefined)` is total and
 *      returns either a sentinel ("(none)" / "(invalid)" / "(other)")
 *      or a string that survived the validity filters (length ≤ 64,
 *      no whitespace / slashes / backslashes).
 *
 *   3. Cardinality cap: feeding N >> MAX_TOOL_LABELS distinct valid
 *      tool names, the set of distinct return values for the verbatim-
 *      bucket inputs never exceeds MAX_TOOL_LABELS. The first
 *      MAX_TOOL_LABELS valid names pass through; the rest collapse to
 *      "(other)". This is the property a malicious flood must not
 *      break.
 *
 *   4. Sentinel-shape invariants (deterministic): empty / 65-char /
 *      contains-slash / contains-whitespace inputs always map to the
 *      documented sentinel. Holds at every position in the stream,
 *      regardless of cardinality state.
 */
import { describe, it, beforeEach, expect } from 'vitest';
import fc from 'fast-check';
import {
  normalizeMcpMethod,
  normalizeMcpToolName,
  MAX_TOOL_LABELS,
  _resetToolLabelsForTest,
} from '../../src/observability/mcp-metrics.js';
import { fuzzSeed, RUNS } from './seed.js';

const KNOWN = new Set([
  'tools/list',
  'tools/call',
  'initialize',
  'notifications/initialized',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'ping',
  'completion/complete',
]);
const ALLOWED_METHOD_RETURNS = new Set([...KNOWN, 'unknown', 'other']);
const TOOL_SENTINELS = new Set(['(none)', '(invalid)', '(other)']);

describe('Phase 5 fuzz — normalizeMcpMethod', () => {
  it('is total and returns a bounded label for any string-or-undefined input', () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 256 })), (input) => {
        const out = normalizeMcpMethod(input ?? undefined);
        // No throw is implicit by reaching here.
        return typeof out === 'string' && ALLOWED_METHOD_RETURNS.has(out);
      }),
      { seed: fuzzSeed('normalize-method'), numRuns: RUNS },
    );
  });

  it('returns "unknown" for null/undefined/empty', () => {
    expect(normalizeMcpMethod(undefined)).toBe('unknown');
    expect(normalizeMcpMethod('')).toBe('unknown');
  });

  it('returns "other" for any non-known string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !KNOWN.has(s)),
        (input) => normalizeMcpMethod(input) === 'other',
      ),
      { seed: fuzzSeed('normalize-method-other'), numRuns: RUNS },
    );
  });
});

describe('Phase 5 fuzz — normalizeMcpToolName', () => {
  beforeEach(() => {
    _resetToolLabelsForTest();
  });

  it('is total and returns either a sentinel or a validity-passing string', () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 256 })), (input) => {
        const out = normalizeMcpToolName(input ?? undefined);
        if (TOOL_SENTINELS.has(out)) return true;
        // Non-sentinel return must have survived all rejection filters.
        return out.length > 0 && out.length <= 64 && !/[\s\\\/]/.test(out);
      }),
      { seed: fuzzSeed('normalize-tool'), numRuns: RUNS },
    );
  });

  it('always rejects shell-metachar / path / whitespace shapes as "(invalid)"', () => {
    fc.assert(
      fc.property(
        fc
          .oneof(
            fc.constantFrom('a b', 'a\tb', 'a\nb', 'foo/bar', 'C:\\baz', '   ', 'a/'),
            // Construct guaranteed-invalid strings of length 1..64 that contain
            // at least one banned char.
            fc.tuple(
              fc.string({ minLength: 0, maxLength: 30 }),
              fc.constantFrom(' ', '\t', '\n', '/', '\\'),
              fc.string({ minLength: 0, maxLength: 30 }),
            ).map(([a, c, b]) => a + c + b),
          )
          .filter((s) => s.length > 0 && s.length <= 64 && /[\s\\\/]/.test(s)),
        (input) => normalizeMcpToolName(input) === '(invalid)',
      ),
      { seed: fuzzSeed('normalize-tool-invalid'), numRuns: RUNS },
    );
  });

  it('always rejects over-length (>64) inputs as "(invalid)"', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 65, maxLength: 512 }), (input) => {
        return normalizeMcpToolName(input) === '(invalid)';
      }),
      { seed: fuzzSeed('normalize-tool-overlong'), numRuns: 50 },
    );
  });

  it('caps cardinality: a flood of distinct valid names produces ≤ MAX_TOOL_LABELS verbatim outputs', () => {
    // Generate distinct valid tool names well past the cap.
    const overflow = 50;
    const total = MAX_TOOL_LABELS + overflow;
    const names: string[] = [];
    for (let i = 0; i < total; i++) {
      names.push(`fuzz-tool-${i.toString(36)}`);
    }
    const seen = new Set<string>();
    let otherCount = 0;
    for (const n of names) {
      const out = normalizeMcpToolName(n);
      if (out === '(other)') {
        otherCount++;
      } else {
        seen.add(out);
      }
    }
    // The verbatim-bucket cardinality is bounded.
    expect(seen.size).toBeLessThanOrEqual(MAX_TOOL_LABELS);
    // Everything past the cap collapsed to "(other)".
    expect(otherCount).toBeGreaterThanOrEqual(overflow);
  });
});
