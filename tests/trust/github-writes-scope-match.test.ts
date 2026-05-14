import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  callTool,
  eventsOfKind,
  makeTrustHarness,
  proposeAndGrant,
  waitForOpenDecision,
  type TrustHarness,
} from './harness.js';

// Regression for the scope-matcher tool-name mismatch (dot vs. underscore).
// Scopes are authored against MCP-exposed tool names (underscore-separated,
// e.g. `github_create_pr`). The github-writes adapter must pass the same
// underscore form to the matcher so a covering scope auto-approves.
describe('trust scope — github write tool names match scopes (underscore)', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('github_create_pr in-scope auto-approves with no decision_request', async () => {
    h = await makeTrustHarness({
      ghPlan: (args) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          return { stdout: 'https://github.com/stenlund/stavr/pull/77' };
        }
        return { stdout: '' };
      },
    });

    const scopeId = await proposeAndGrant(h, {
      title: 'stavr PR opens',
      description: 'allow PR creation in stenlund/stavr',
      allowed_actions: [
        { tool: 'github_create_pr', param_constraints: { repo: 'stenlund/stavr' } },
      ],
      expires_after_actions: 3,
    });

    const decisionsBefore = eventsOfKind(h, 'decision_request').length;

    const res = await callTool(h.client, 'github.create_pr', {
      repo: 'stenlund/stavr',
      head: 'feat/x',
      base: 'main',
      title: 'feat: x',
      body: 'b',
    });
    expect(res.parsed.ok).toBe(true);
    expect(res.parsed.pr_number).toBe(77);

    // No new decision_request opened for the covered action.
    expect(eventsOfKind(h, 'decision_request').length).toBe(decisionsBefore);

    const authEvents = eventsOfKind(h, 'trust_scope_action_authorized');
    expect(authEvents.length).toBe(1);
    expect((authEvents[0].payload as any).scope_id).toBe(scopeId);
    expect((authEvents[0].payload as any).tool).toBe('github_create_pr');
  });

  it('github_merge_pr in-scope auto-approves with no decision_request', async () => {
    h = await makeTrustHarness({
      ghPlan: (args) => {
        if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '' };
        if (args[0] === 'pr' && args[1] === 'view') {
          return { stdout: '{"mergeCommit":{"oid":"deadbeef"}}' };
        }
        return { stdout: '' };
      },
    });

    const scopeId = await proposeAndGrant(h, {
      title: 'stavr merges',
      description: 'allow PR merge in stenlund/stavr',
      allowed_actions: [
        { tool: 'github_merge_pr', param_constraints: { repo: 'stenlund/stavr' } },
      ],
      expires_after_actions: 3,
    });

    const decisionsBefore = eventsOfKind(h, 'decision_request').length;

    const res = await callTool(h.client, 'github.merge_pr', {
      repo: 'stenlund/stavr',
      number: 12,
    });
    expect(res.parsed.ok).toBe(true);

    expect(eventsOfKind(h, 'decision_request').length).toBe(decisionsBefore);

    const authEvents = eventsOfKind(h, 'trust_scope_action_authorized');
    expect(authEvents.length).toBe(1);
    expect((authEvents[0].payload as any).scope_id).toBe(scopeId);
    expect((authEvents[0].payload as any).tool).toBe('github_merge_pr');
  });

  it('github_create_pr on a different repo (out of scope) still opens decision_request', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/pull/9' }),
    });

    await proposeAndGrant(h, {
      title: 'stavr PR opens',
      description: 'allow PR creation in stenlund/stavr only',
      allowed_actions: [
        { tool: 'github_create_pr', param_constraints: { repo: 'stenlund/stavr' } },
      ],
      expires_after_actions: 3,
    });

    const promise = callTool(h.client, 'github.create_pr', {
      repo: 'Kstkoda/privacy-tracker',
      head: 'feat/y',
      base: 'main',
      title: 'feat: y',
      body: 'b',
    });

    const cid = await waitForOpenDecision(h.broker);
    expect(eventsOfKind(h, 'decision_request').length).toBeGreaterThan(0);
    approve(h.broker, cid);

    const res = await promise;
    expect(res.parsed.ok).toBe(true);

    // No auto-approval occurred for this out-of-scope call.
    const authEvents = eventsOfKind(h, 'trust_scope_action_authorized');
    expect(authEvents.length).toBe(0);
  });
});
