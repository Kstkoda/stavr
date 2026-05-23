import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOfKind,
  makeTrustHarness,
  proposeAndGrant,
  type TrustHarness,
} from './harness.js';

describe('trust scope — grant + execute happy path', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('covered action runs without a decision_request and emits trust_scope_action_authorized', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/42' }),
    });

    const scopeId = await proposeAndGrant(h, {
      title: 'BUGS migration',
      description: 'Create issues from BUGS.md',
      allowed_actions: [
        { tool: 'github_create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 5,
    });

    const beforeCount = eventsOfKind(h, 'decision_request').length;

    const res = await callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 'B-001 something',
      body: 'body',
    });
    expect(res.parsed.ok).toBe(true);
    expect(res.parsed.issue_number).toBe(42);

    // No new decision_request was opened for the covered action.
    expect(eventsOfKind(h, 'decision_request').length).toBe(beforeCount);

    const authEvents = eventsOfKind(h, 'trust_scope_action_authorized');
    expect(authEvents.length).toBe(1);
    expect((authEvents[0].payload as any).scope_id).toBe(scopeId);
    expect((authEvents[0].payload as any).tool).toBe('github_create_issue');

    const status = await callTool(h.client, 'trust_scope_status', { id: scopeId });
    expect(status.parsed.scope.actions_executed).toBe(1);
    expect(status.parsed.actions.length).toBe(1);
    expect(status.parsed.actions[0].tool_name).toBe('github_create_issue');
  });

  it('rejecting the grant decision leaves the scope proposed and uncovered', async () => {
    h = await makeTrustHarness();

    const prop = await callTool(h.client, 'trust_scope_propose', {
      title: 'never granted',
      description: 'foo',
      allowed_actions: [{ tool: 'github_create_issue' }],
    });
    const id = prop.parsed.scope_id as string;

    // Try to grant; reject the decision.
    const grantPromise = callTool(h.client, 'trust_scope_grant', { id, timeout_sec: 5 });
    // Wait for the open decision.
    const start = Date.now();
    let cid: string | undefined;
    while (!cid && Date.now() - start < 2000) {
      cid = h.broker.store.listRecentDecisions(5).find((d) => d.status === 'open')?.correlation_id;
      if (!cid) await new Promise((r) => setTimeout(r, 10));
    }
    if (!cid) throw new Error('no open decision');
    // Phase 4.5 — operator-shape check rejects 'cowork-user'; use 'user-direct'.
    h.broker.store.respondToDecision(cid, 'reject', 'no', 'user-direct');
    const granted = await grantPromise;
    expect(granted.parsed.ok).toBe(false);

    // Scope should remain in 'proposed' status.
    const status = await callTool(h.client, 'trust_scope_status', { id });
    expect(status.parsed.scope.status).toBe('proposed');
  });
});
