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

describe('trust scope — revoke', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('revoking mid-execution stops covered actions from auto-approving', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/9' }),
    });

    const scopeId = await proposeAndGrant(h, {
      title: 'will be revoked',
      description: 'x',
      allowed_actions: [{ tool: 'github_create_issue' }],
      expires_after_actions: 99,
    });

    // First call: auto-approved.
    const r1 = await callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 'first',
      body: 'x',
    });
    expect(r1.parsed.ok).toBe(true);

    // Revoke.
    const rev = await callTool(h.client, 'trust_scope_revoke', { id: scopeId, reason: 'changed mind' });
    expect(rev.parsed.ok).toBe(true);
    expect(rev.parsed.scope.status).toBe('revoked');
    expect(eventsOfKind(h, 'trust_scope_revoked').length).toBe(1);

    // Second call: now gates normally.
    const promise = callTool(h.client, 'github.create_issue', {
      repo: 'Kstkoda/privacy-tracker',
      title: 'second',
      body: 'x',
    });
    const cid = await waitForOpenDecision(h.broker);
    approve(h.broker, cid);
    const r2 = await promise;
    expect(r2.parsed.ok).toBe(true);
  });
});
