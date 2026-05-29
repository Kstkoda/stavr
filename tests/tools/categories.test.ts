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

  it('falls back to prefix-based categorisation for known prefixes', () => {
    expect(categorize('github_some_new_tool')).toBe('github');
    expect(categorize('steward_quiet')).toBe('steward');
    expect(categorize('credential_revoke_all')).toBe('credentials');
    expect(categorize('trust_scope_grant')).toBe('scope');
  });

  it('routes job_* prefix to the worker category bucket', () => {
    // worker-dispatch Phase 3c.2 — only job_* routes to the 'worker'
    // category symbol now (the legacy worker_*/worker. prefix variants
    // deleted with the bespoke worker subsystem). The category symbol
    // itself stays 'worker' for back-compat with persisted rows; the
    // operator-visible label flipped to "Jobs" in 3c.1.
    expect(categorize('job_dispatch')).toBe('worker');
    expect(categorize('job_status')).toBe('worker');
    expect(categorize('job_inject')).toBe('worker');
    expect(categorize('job.terminate')).toBe('worker');
  });

  // v0.6 Task 4 Phase B — github.create_pr etc. use the MCP-namespace
  // dot separator. They MUST categorize identically to the underscore
  // form (legacy + scopeCheck payloads use the latter).
  it('matches the MCP-namespace dot-prefix form for all adapter families', () => {
    expect(categorize('github.create_pr')).toBe('github');
    expect(categorize('github.read_pr')).toBe('github');
    expect(categorize('github.list_issues')).toBe('github');
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

  it('returns "other" for completely unrecognised tool ids — including legacy worker_* names', () => {
    expect(categorize('completely_made_up_tool')).toBe('other');
    expect(categorize('')).toBe('other');
    // worker-dispatch Phase 3c.2 — legacy worker_* tool ids no longer
    // route to the 'worker' category since the worker_/worker. prefixes
    // were dropped from PREFIX_CATEGORY when the bespoke subsystem
    // deleted. They fall through to 'other'.
    expect(categorize('worker_spawn')).toBe('other');
    expect(categorize('worker.spawn')).toBe('other');
    expect(categorize('worker_anything')).toBe('other');
  });
});

describe('default tier policy', () => {
  it('uses AUTO for read / subscription / event-publish tools', () => {
    expect(defaultTierFor('emit_event')).toBe('AUTO');
    expect(defaultTierFor('subscribe_to_events')).toBe('AUTO');
    expect(defaultTierFor('job_list_bindings')).toBe('AUTO');
    expect(defaultTierFor('job_status')).toBe('AUTO');
    expect(defaultTierFor('steward_ask')).toBe('AUTO');
  });

  it('uses CONFIRM for dispatch / inject / terminate tools', () => {
    expect(defaultTierFor('job_dispatch')).toBe('CONFIRM');
    expect(defaultTierFor('job_inject')).toBe('CONFIRM');
    expect(defaultTierFor('job_terminate')).toBe('CONFIRM');
    expect(defaultTierFor('propose_plan')).toBe('CONFIRM');
  });

  it('uses EXPLICIT for shell + credentials (high-risk irreversible)', () => {
    expect(defaultTierFor('host_exec')).toBe('EXPLICIT');
    // unknown credential_* tool falls through to category-based EXPLICIT
    expect(defaultTierFor('credential_drop_database')).toBe('EXPLICIT');
  });

  it('falls back conservatively to CONFIRM for unrecognised tools', () => {
    expect(defaultTierFor('something_brand_new')).toBe('CONFIRM');
    // Legacy worker_* falls through to the conservative 'other'-category
    // CONFIRM default now that the worker_* prefix is gone.
    expect(defaultTierFor('worker_spawn')).toBe('CONFIRM');
  });

  it('returns a value that is a valid Tier', () => {
    for (const id of ['emit_event', 'job_dispatch', 'host_exec', 'unknown']) {
      const t = defaultTierFor(id);
      expect(TIERS).toContain(t);
    }
  });
});

describe('reversibility policy', () => {
  it('marks reads + subscribes as reversible', () => {
    expect(reversibilityFor('emit_event')).toBe('reversible');
    expect(reversibilityFor('subscribe_to_events')).toBe('reversible');
    expect(reversibilityFor('job_list')).toBe('reversible');
    expect(reversibilityFor('job_status')).toBe('reversible');
    expect(reversibilityFor('propose_plan')).toBe('reversible');
  });

  it('marks dispatch / inject / terminate / host_exec as irreversible', () => {
    expect(reversibilityFor('job_dispatch')).toBe('irreversible');
    expect(reversibilityFor('job_inject')).toBe('irreversible');
    expect(reversibilityFor('job_terminate')).toBe('irreversible');
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
