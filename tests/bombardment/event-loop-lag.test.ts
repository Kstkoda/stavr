import { describe, expect, it } from 'vitest';
import { startEventLoopLagSampler } from '../../bombardment/observability/event-loop-lag.js';

describe('bombardment/observability/event-loop-lag', () => {
  it('collects samples and reports a summary', async () => {
    const sampler = startEventLoopLagSampler(20);
    await new Promise((r) => setTimeout(r, 200));
    sampler.stop();
    const summary = sampler.summary();
    expect(summary.n).toBeGreaterThan(0);
    expect(summary.p50).toBeGreaterThanOrEqual(0);
    expect(summary.max).toBeGreaterThanOrEqual(summary.p50);
  });

  it('summary returns zeros when no samples', () => {
    const sampler = startEventLoopLagSampler(50);
    sampler.stop();
    // Stop before any tick fires; summary should not throw.
    const s = sampler.summary();
    expect(s.n).toBe(0);
    expect(s.p99).toBe(0);
  });
});
