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

describe('trust scope — forbidden override', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('forbidden matcher blocks the tool even when allowed_actions would cover it', async () => {
    h = await makeTrustHarness({
      ghPlan: (args) => {
        if (args[0] === 'issue' && args[1] === 'create') return { stdout: 'https://github.com/x/y/issues/1' };
        if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '' };
        if (args[0] === 'pr' && args[1] === 'view') return { stdout: '{}' };
        return { stdout: '' };
      },
    });

    await proposeAndGrant(h, {
      title: 'broad with one forbidden',
      description: 'd',
      // Allow any github.* style is not in the matcher language; just allow specific tools:
      allowed_actions: [
        { tool: 'github.create_issue' },
        { tool: 'github.merge_pr' },
      ],
      forbidden_actions: [
        { tool: 'github.merge_pr', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 5,
    });

    // create_issue: still auto.
    const decisionsBefore = eventsOfKind(h, 'decision_request').length;
    const create = await callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 't',
      body: 'b',
    });
    expect(create.parsed.ok).toBe(true);
    expect(eventsOfKind(h, 'decision_request').length).toBe(decisionsBefore);

    // merge_pr on the forbidden repo: must gate.
    const mergePromise = callTool(h.client, 'github.merge_pr', {
      repo: 'Kstkoda/privacy-tracker',
      number: 1,
    });
    const cid = await waitForOpenDecision(h.broker);
    approve(h.broker, cid);
    const merge = await mergePromise;
    expect(merge.parsed.ok).toBe(true);
  });
});
