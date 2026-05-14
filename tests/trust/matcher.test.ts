import { describe, expect, it } from 'vitest';
import { matchesAny, matchesOne, scopeCovers } from '../../src/trust/matcher.js';
import type { TrustScope } from '../../src/trust/types.js';

function activeScope(over: Partial<TrustScope> = {}): TrustScope {
  return {
    id: 'ts-1',
    title: 't',
    description: 'd',
    granted_by: 'user-direct',
    granted_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    allowed_actions: [],
    reporting: { cadence: 'every-action', channels: ['event-log'] },
    status: 'active',
    actions_executed: 0,
    ...over,
  };
}

describe('trust matcher', () => {
  it('exact tool name + no constraints matches any args', () => {
    expect(matchesOne({ tool: 'github.create_issue' }, 'github.create_issue', { repo: 'a/b' })).toBe(true);
    expect(matchesOne({ tool: 'github.create_issue' }, 'github.merge_pr', { repo: 'a/b' })).toBe(false);
  });

  it('exact-value constraint requires deep equality', () => {
    const m = { tool: 'github.create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } };
    expect(matchesOne(m, 'github.create_issue', { repo: 'Kstkoda/privacy-tracker', title: 'x' })).toBe(true);
    expect(matchesOne(m, 'github.create_issue', { repo: 'stenlund/stavr', title: 'x' })).toBe(false);
  });

  it('regex constraint with ^ prefix matches by RegExp', () => {
    const m = { tool: 'github.create_issue', param_constraints: { repo: '^Kstkoda/.*' } };
    expect(matchesOne(m, 'github.create_issue', { repo: 'Kstkoda/privacy-tracker' })).toBe(true);
    expect(matchesOne(m, 'github.create_issue', { repo: 'Kstkoda/stavr' })).toBe(true);
    expect(matchesOne(m, 'github.create_issue', { repo: 'someone-else/repo' })).toBe(false);
  });

  it('multiple matchers OR together via matchesAny', () => {
    const ms = [
      { tool: 'github.create_issue' },
      { tool: 'github.add_labels', param_constraints: { repo: 'a/b' } },
    ];
    expect(matchesAny(ms, 'github.create_issue', {})).toBe(true);
    expect(matchesAny(ms, 'github.add_labels', { repo: 'a/b' })).toBe(true);
    expect(matchesAny(ms, 'github.add_labels', { repo: 'c/d' })).toBe(false);
    expect(matchesAny(ms, 'github.merge_pr', {})).toBe(false);
  });

  it('forbidden override blocks otherwise-allowed actions', () => {
    const scope = activeScope({
      allowed_actions: [{ tool: 'github.merge_pr' }],
      forbidden_actions: [{ tool: 'github.merge_pr', param_constraints: { repo: 'a/protected' } }],
    });
    expect(scopeCovers(scope, 'github.merge_pr', { repo: 'a/b' })).toBe(true);
    expect(scopeCovers(scope, 'github.merge_pr', { repo: 'a/protected' })).toBe(false);
  });

  it('scopeCovers returns false for non-active status', () => {
    const proposed = activeScope({ status: 'proposed', allowed_actions: [{ tool: 'x' }] });
    expect(scopeCovers(proposed, 'x', {})).toBe(false);
  });
});
