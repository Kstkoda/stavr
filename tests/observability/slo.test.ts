import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSloState,
  recordSloSample,
  refreshSloBurnRates,
  snapshotWindow,
  SLO_DEFS,
  sloErrorBudgetBurnRate,
} from '../../src/observability/slo.js';

afterEach(() => {
  _resetSloState();
});

describe('SLO burn-rate', () => {
  it('zero traffic = zero burn rate', () => {
    const snap = snapshotWindow('gateway_availability', 5 * 60_000);
    expect(snap.total).toBe(0);
    expect(snap.burnRate).toBe(0);
  });

  it('all-success traffic = zero burn rate', () => {
    for (let i = 0; i < 1000; i++) recordSloSample('gateway_availability', true);
    const snap = snapshotWindow('gateway_availability', 5 * 60_000);
    expect(snap.total).toBe(1000);
    expect(snap.good).toBe(1000);
    expect(snap.failureRatio).toBe(0);
    expect(snap.burnRate).toBe(0);
  });

  it('100% failure traffic = burn rate = 1 / errorBudget', () => {
    for (let i = 0; i < 100; i++) recordSloSample('gateway_availability', false);
    const snap = snapshotWindow('gateway_availability', 5 * 60_000);
    expect(snap.failureRatio).toBe(1);
    // gateway_availability budget is 0.001 → burn rate 1000×.
    expect(snap.burnRate).toBeCloseTo(1 / SLO_DEFS.gateway_availability.errorBudgetRatio, 5);
  });

  it('mixed traffic computes burn rate proportionally', () => {
    // 990 success, 10 failure → failure ratio = 1%. llm_provider_availability
    // budget is 1% → burn rate = 1.0.
    for (let i = 0; i < 990; i++) recordSloSample('llm_provider_availability', true);
    for (let i = 0; i < 10; i++) recordSloSample('llm_provider_availability', false);
    const snap = snapshotWindow('llm_provider_availability', 5 * 60_000);
    expect(snap.failureRatio).toBeCloseTo(0.01, 5);
    expect(snap.burnRate).toBeCloseTo(1.0, 5);
  });

  it('refreshSloBurnRates writes both 5m and 1h windows for every SLO', async () => {
    recordSloSample('gateway_availability', true);
    recordSloSample('gateway_latency_p95', true);
    recordSloSample('llm_provider_availability', true);
    refreshSloBurnRates();
    const v = await sloErrorBudgetBurnRate.get();
    const windows = new Set<string>();
    const slos = new Set<string>();
    for (const sample of v.values) {
      slos.add(String(sample.labels.slo));
      windows.add(String(sample.labels.window));
    }
    expect(slos).toEqual(new Set(['gateway_availability', 'gateway_latency_p95', 'llm_provider_availability']));
    expect(windows).toEqual(new Set(['5m', '1h']));
  });
});
