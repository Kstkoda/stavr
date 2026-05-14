import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  callTool,
  eventsOfKind,
  makeTrustHarness,
  waitForOpenDecision,
  type TrustHarness,
} from './harness.js';

describe('trust scope — grant itself gates on await_decision', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('propose does not open a decision; grant does', async () => {
    h = await makeTrustHarness();

    const prop = await callTool(h.client, 'trust_scope_propose', {
      title: 'demo',
      description: 'd',
      allowed_actions: [{ tool: 'github_create_issue' }],
    });
    expect(prop.parsed.scope_id).toBeTruthy();

    // No decision_request from propose.
    expect(eventsOfKind(h, 'decision_request').length).toBe(0);
    const proposed = eventsOfKind(h, 'trust_scope_proposed');
    expect(proposed.length).toBe(1);

    // Grant opens a decision.
    const id = prop.parsed.scope_id as string;
    const grantPromise = callTool(h.client, 'trust_scope_grant', { id, timeout_sec: 5 });
    const cid = await waitForOpenDecision(h.broker);
    expect(eventsOfKind(h, 'decision_request').length).toBe(1);
    approve(h.broker, cid);
    const granted = await grantPromise;
    expect(granted.parsed.ok).toBe(true);
    expect(eventsOfKind(h, 'trust_scope_granted').length).toBe(1);
  });

  it('param-constraint matching: same tool, wrong repo, gates; right repo, auto-approves', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/x/y/issues/1' }),
    });

    // Grant scope for privacy-tracker only.
    const prop = await callTool(h.client, 'trust_scope_propose', {
      title: 'pt only',
      description: 'd',
      allowed_actions: [
        { tool: 'github_create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 10,
    });
    const id = prop.parsed.scope_id as string;
    const grantPromise = callTool(h.client, 'trust_scope_grant', { id, timeout_sec: 5 });
    const cid = await waitForOpenDecision(h.broker);
    approve(h.broker, cid);
    await grantPromise;

    // In-repo: auto-approves.
    const decisionsBefore = eventsOfKind(h, 'decision_request').length;
    const inRepo = await callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 'in',
      body: 'x',
    });
    expect(inRepo.parsed.ok).toBe(true);
    expect(eventsOfKind(h, 'decision_request').length).toBe(decisionsBefore);

    // Wrong repo: gates.
    const outPromise = callTool(h.client, 'github.create_issue', {
      repo: 'stenlund/stavr',
      title: 'out',
      body: 'x',
    });
    const cid2 = await waitForOpenDecision(h.broker);
    approve(h.broker, cid2);
    const out = await outPromise;
    expect(out.parsed.ok).toBe(true);
  });
});
