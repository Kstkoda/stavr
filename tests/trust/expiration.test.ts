import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOfKind,
  makeTrustHarness,
  proposeAndGrant,
  type TrustHarness,
} from './harness.js';

describe('trust scope — expiration', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('time-based expiry: scope becomes inactive and subsequent calls fall back to gating', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/1' }),
    });

    // Propose with a far-future expiry so grant succeeds; then back-date it.
    const scopeId = await proposeAndGrant(h, {
      title: 'short-lived',
      description: 'time-based',
      allowed_actions: [{ tool: 'github_create_issue' }],
      expires_after_actions: 99,
    });

    // Force the scope past expiry by writing directly to the store.
    (h.trustStore as any).db
      .prepare(`UPDATE trust_scopes SET expires_at=? WHERE id=?`)
      .run(new Date(Date.now() - 60_000).toISOString(), scopeId);

    // findActiveScopeFor should mark it expired and return undefined.
    const found = h.trustStore.findActiveScopeFor({ tool: 'github_create_issue', args: { repo: 'a/b' } });
    expect(found).toBeUndefined();

    const after = h.trustStore.get(scopeId)!;
    expect(after.status).toBe('expired');
  });

  it('action-count expiry: hits cap, status flips to completed, trust_scope_completed fires', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/1' }),
    });

    const scopeId = await proposeAndGrant(h, {
      title: 'tiny cap',
      description: 'cap=3',
      allowed_actions: [
        { tool: 'github_create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 3,
      reporting: { cadence: 'on-completion-only', channels: ['event-log'] },
    });

    for (let i = 0; i < 3; i++) {
      const r = await callTool(h.client, 'github.create_issue', {
        repo: 'Kstkoda/privacy-tracker',
        title: `i-${i}`,
        body: 'x',
      });
      expect(r.parsed.ok).toBe(true);
    }

    const after = h.trustStore.get(scopeId)!;
    expect(after.status).toBe('completed');
    expect(after.actions_executed).toBe(3);

    // trust_scope_completed should have fired exactly once.
    const completedEvents = eventsOfKind(h, 'trust_scope_completed');
    expect(completedEvents.length).toBe(1);
    expect((completedEvents[0].payload as any).reason).toBe('action_cap_reached');
  });
});
