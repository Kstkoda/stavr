import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOfKind,
  makeTrustHarness,
  proposeAndGrant,
  type TrustHarness,
} from './harness.js';

describe('trust scope — reporter cadences', () => {
  let h: TrustHarness;
  afterEach(async () => h?.close());

  it('every-5-actions emits a progress event at action 5 and 10, plus one trust_scope_completed at cap', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/1' }),
    });

    await proposeAndGrant(h, {
      title: 'cadence-5',
      description: '12 actions, cap 12',
      allowed_actions: [
        { tool: 'github.create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 12,
      reporting: { cadence: 'every-5-actions', channels: ['event-log'] },
    });

    for (let i = 0; i < 12; i++) {
      const r = await callTool(h.client, 'github.create_issue', {
        repo: 'Kstkoda/privacy-tracker',
        title: `i-${i}`,
        body: 'x',
      });
      expect(r.parsed.ok).toBe(true);
    }

    const progress = eventsOfKind(h, 'trust_scope_progress');
    // Action 5 and action 10 should produce progress events.
    expect(progress.length).toBe(2);
    expect((progress[0].payload as any).actions_executed).toBe(5);
    expect((progress[1].payload as any).actions_executed).toBe(10);

    // Completion at action 12 produces exactly one trust_scope_completed.
    const completed = eventsOfKind(h, 'trust_scope_completed');
    expect(completed.length).toBe(1);
    expect((completed[0].payload as any).actions_executed).toBe(12);
  });

  it('every-action emits one progress event per authorized action', async () => {
    h = await makeTrustHarness({
      ghPlan: () => ({ stdout: 'https://github.com/Kstkoda/privacy-tracker/issues/1' }),
    });

    await proposeAndGrant(h, {
      title: 'cadence-each',
      description: 'one progress per action',
      allowed_actions: [
        { tool: 'github.create_issue', param_constraints: { repo: 'Kstkoda/privacy-tracker' } },
      ],
      expires_after_actions: 100,
      reporting: { cadence: 'every-action', channels: ['event-log'] },
    });

    for (let i = 0; i < 3; i++) {
      await callTool(h.client, 'github.create_issue', {
        repo: 'Kstkoda/privacy-tracker',
        title: `i-${i}`,
        body: 'x',
      });
    }

    const progress = eventsOfKind(h, 'trust_scope_progress');
    expect(progress.length).toBe(3);
  });
});
