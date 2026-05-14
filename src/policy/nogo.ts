// src/policy/nogo.ts
//
// No-go list types + matcher. The no-go list is the "always interrupt for
// explicit approval" floor (spec 48 layer 3 generalised to risk classes).
// Even inside an open trust scope, a match here forces a decision_request.
//
// Rules live in the `no_go_list` table. Defaults are seeded by the schema
// migration; users add/disable via the dashboard or CLI. This module is the
// pure matcher — DB persistence is the caller's job.

import type { RiskClass } from '../types/stavr-bom.js';

export interface NoGoRule {
  id: string;
  /** Glob-style pattern: `*` matches any chars. Matched against tool_name or command. */
  action_pattern: string;
  risk_class: RiskClass;
  reason: string;
  source: 'default' | 'user' | 'organization';
  enabled: boolean;
}

export interface NoGoQuery {
  tool_name?: string;
  command?: string;
  risk_class: RiskClass;
}

/**
 * Match an action against the no-go list. Returns the first matching
 * enabled rule, or null. A rule matches when:
 *   - it is enabled
 *   - its risk_class equals the query's risk_class
 *   - its action_pattern glob-matches the query's tool_name OR command
 *
 * Risk class equality is intentional — the same pattern under a different
 * risk class is a different rule. The risk_class is the authoritative axis;
 * the pattern is the specific tool/command guard.
 */
export function matchNoGo(rules: NoGoRule[], query: NoGoQuery): NoGoRule | null {
  const target = query.tool_name ?? query.command ?? '';
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.risk_class !== query.risk_class) continue;
    if (matchGlob(rule.action_pattern, target)) return rule;
  }
  return null;
}

/**
 * Simplified glob matcher — only `*` (greedy any-chars) is supported. Patterns
 * are anchored at both ends, so `git push --force*` matches
 * `git push --force-with-lease origin main` but not `git fetch && git push --force`.
 */
export function matchGlob(pattern: string, target: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + escaped + '$').test(target);
}
