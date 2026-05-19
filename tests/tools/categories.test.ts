import { describe, expect, it } from 'vitest';
import {
  TIERS,
  categorize,
  defaultTierFor,
  reversibilityFor,
} from '../../src/tools/categories.js';

describe('tool categories', () => {
  it('maps explicit known ids to their category', () => {
    expect(categorize('emit_event')).toBe('event');
    expect(categorize('subscribe_to_events')).toBe('subscription');
    expect(categorize('respond_to_decision')).toBe('decision');
    expect(categorize('host_exec')).toBe('shell');
    expect(categorize('propose_plan')).toBe('plan');
  });

  it('falls back to prefix-based categorisation for unknown ids', () => {
    expect(categorize('worker_anything')).toBe('worker');
    expect(categorize('github_some_new_tool')).toBe('github');
    expect(categorize('steward_quiet')).toBe('steward');
    expect(categorize('credential_revoke_all')).toBe('credentials');
    expect(categorize('trust_scope_grant')).toBe('scope');
  });

  // v0.6 Task 4 Phase B — github.create_pr, worker.spawn etc. use the
  // MCP-namespace dot separator. They MUST categorize identically to
  // the underscore form (legacy + scopeCheck payloads use the latter).
  it('matches the MCP-namespace dot-prefix form for all adapter families', () => {
    expect(categorize('github.create_pr')).toBe('github');
    expect(categorize('github.read_pr')).toBe('github');
    expect(categorize('github.list_issues')).toBe('github');
    expect(categorize('worker.spawn')).toBe('worker');
    expect(categorize('steward.ask_async')).toBe('steward');
    expect(categorize('credential.add')).toBe('credentials');
    expect(categorize('trust_scope.propose')).toBe('scope');
  });

  it('puts the trust_scope_* prefix above worker_/steward_ in priority', () => {
    // longest-prefix wins so `trust_scope_grant` resolves to `scope`,
    // not "tr_*" or anything broader.
    expect(categorize('trust_scope_grant')).toBe('scope');
    expect(categorize('trust_scope_revoke')).toBe('scope');
  });

  it('returns "other" for completely unrecognised tool ids', () => {
    expect(categorize('completely_made_up_tool')).toBe('other');
    expect(categorize('')).toBe('other');
  });
});

describe('default tier policy', () => {
  it('uses AUTO for read / subscription / event-publish tools', () => {
    expect(defaultTierFor('emit_event')).toBe('AUTO');
    expect(defaultTierFor('subscribe_to_events')).toBe('AUTO');
    expect(defaultTierFor('worker_list_types')).toBe('AUTO');
    expect(defaultTierFor('worker_status')).toBe('AUTO');
    expect(defaultTierFor('steward_ask')).toBe('AUTO');
  });

  it('uses CONFIRM for spawn / dispatch / write tools', () => {
    expect(defaultTierFor('worker_spawn')).toBe('CONFIRM');
    expect(defaultTierFor('worker_dispatch')).toBe('CONFIRM');
    expect(defaultTierFor('worker_terminate')).toBe('CONFIRM');
    expect(defaultTierFor('propose_plan')).toBe('CONFIRM');
  });

  it('uses EXPLICIT for shell + credentials (high-risk irreversible)', () => {
    expect(defaultTierFor('host_exec')).toBe('EXPLICIT');
    // unknown credential_* tool falls through to category-based EXPLICIT
    expect(defaultTierFor('credential_drop_database')).toBe('EXPLICIT');
  });

  it('falls back conservatively to CONFIRM for unrecognised tools', () => {
    expect(defaultTierFor('something_brand_new')).toBe('CONFIRM');
  });

  it('returns a value that is a valid Tier', () => {
    for (const id of ['emit_event', 'worker_spawn', 'host_exec', 'unknown']) {
      const t = defaultTierFor(id);
      expect(TIERS).toContain(t);
    }
  });
});

describe('reversibility policy', () => {
  it('marks reads + subscribes as reversible', () => {
    expect(reversibilityFor('emit_event')).toBe('reversible');
    expect(reversibilityFor('subscribe_to_events')).toBe('reversible');
    expect(reversibilityFor('worker_list')).toBe('reversible');
    expect(reversibilityFor('worker_status')).toBe('reversible');
    expect(reversibilityFor('propose_plan')).toBe('reversible');
  });

  it('marks spawns / dispatch / terminate / host_exec as irreversible', () => {
    expect(reversibilityFor('worker_spawn')).toBe('irreversible');
    expect(reversibilityFor('worker_dispatch')).toBe('irreversible');
    expect(reversibilityFor('worker_terminate')).toBe('irreversible');
    expect(reversibilityFor('host_exec')).toBe('irreversible');
  });

  it('treats the github_* family as irreversible at the category level', () => {
    // PR #2's per-tool overrides refine the read tools; the category-
    // wide default keeps the conservative bias.
    expect(reversibilityFor('github_open_pr_new')).toBe('irreversible');
    expect(reversibilityFor('github_merge_some_pr')).toBe('irreversible');
  });

  it('treats trust_scope_* + steward_* + plan + decision as reversible', () => {
    expect(reversibilityFor('trust_scope_grant')).toBe('reversible');
    expect(reversibilityFor('trust_scope_revoke')).toBe('reversible');
    expect(reversibilityFor('steward_quiet')).toBe('reversible');
  });
});
