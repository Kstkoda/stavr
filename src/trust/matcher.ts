import type { ActionMatcher, TrustScope } from './types.js';

/**
 * Returns true if the tool+args pair satisfies AT LEAST ONE matcher.
 * Per ADR-023:
 *   - tool name must match exactly
 *   - param_constraints values: string starting with '^' = regex (tested against String(value)),
 *     anything else = strict equality against the arg value.
 *   - omitted param_constraints = "any args" for the named tool.
 */
export function matchesAny(
  matchers: ActionMatcher[] | undefined,
  tool: string,
  args: unknown,
): boolean {
  if (!matchers || matchers.length === 0) return false;
  return matchers.some((m) => matchesOne(m, tool, args));
}

export function matchesOne(matcher: ActionMatcher, tool: string, args: unknown): boolean {
  if (matcher.tool !== tool) return false;
  const constraints = matcher.param_constraints;
  if (!constraints) return true;
  if (!isRecord(args)) return false;
  for (const [key, expected] of Object.entries(constraints)) {
    const actual = (args as Record<string, unknown>)[key];
    if (!constraintMatches(expected, actual)) return false;
  }
  return true;
}

function constraintMatches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string' && expected.startsWith('^')) {
    if (actual === undefined || actual === null) return false;
    try {
      return new RegExp(expected).test(String(actual));
    } catch {
      return false;
    }
  }
  return deepEqual(expected, actual);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Scope covers a tool+args call if:
 *   - status === 'active'
 *   - matches an allowed_actions matcher
 *   - does NOT match any forbidden_actions matcher
 *
 * Expiration is checked by the caller against the live clock; pure matcher
 * cannot know "now". See store.findActiveScopeFor for the combined check.
 */
export function scopeCovers(scope: TrustScope, tool: string, args: unknown): boolean {
  if (scope.status !== 'active') return false;
  if (matchesAny(scope.forbidden_actions, tool, args)) return false;
  return matchesAny(scope.allowed_actions, tool, args);
}
