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

describe('trust scope — outside-scope action still gates', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('covered tool auto-approves; different tool opens await_decision', async () => {
    h = await makeTrustHarness({
      ghPlan: (args) => {
        if (args[0] === 'issue' && args[1] === 'create') {
          return { stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/1' };
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          return { stdout: '' };
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return { stdout: '{"mergeCommit":{"oid":"abc"}}' };
        }
        return { stdout: '' };
      },
    });

    await proposeAndGrant(h, {
      title: 'issues only',
      description: 'create issues in privacy-tracker',
      allowed_actions: [
        { tool: 'github.create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 10,
    });

    // Covered: should not gate.
    const decisionsBefore = eventsOfKind(h, 'decision_request').length;
    const create = await callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 'in scope',
      body: 'x',
    });
    expect(create.parsed.ok).toBe(true);
    expect(eventsOfKind(h, 'decision_request').length).toBe(decisionsBefore);

    // Out of scope: merge_pr is NOT allowed → must gate.
    const mergePromise = callTool(h.client, 'github.merge_pr', {
      repo: 'Kstkoda/privacy-tracker',
      number: 5,
    });
    const cid = await waitForOpenDecision(h.broker);
    approve(h.broker, cid);
    const merge = await mergePromise;
    expect(merge.parsed.ok).toBe(true);

    // Different repo: same tool but the constraint blocks → must gate.
    const otherRepoPromise = callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/cowire',
      title: 'wrong repo',
      body: 'x',
    });
    const cid2 = await waitForOpenDecision(h.broker);
    approve(h.broker, cid2);
    const otherRepo = await otherRepoPromise;
    expect(otherRepo.parsed.ok).toBe(true);
  });
});
