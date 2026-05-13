import { describe, expect, it, beforeEach } from 'vitest';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import {
  computeUsage,
  fetchAnthropicBalance,
  _resetAdminBalanceCache,
} from '../src/usage.js';

describe('Spec 50 Layer 1 — usage aggregator', () => {
  let store: EventStore;
  let broker: Broker;
  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  async function emitWorkerResult(opts: {
    at?: Date;
    workerId?: string;
    model: string;
    input: number;
    output: number;
    cost: number;
  }): Promise<void> {
    await broker.publish({
      kind: 'worker_progress',
      at: (opts.at ?? new Date()).toISOString(),
      source_agent: 'cc',
      payload: {
        id: opts.workerId ?? 'w1',
        message: 'claude:result',
        payload: {
          format: 'stream-json',
          event: {
            type: 'result',
            model: opts.model,
            usage: { input_tokens: opts.input, output_tokens: opts.output },
            cost_usd: opts.cost,
          },
        },
      },
    });
  }

  it('rolls up cost across worker_progress result events, splits by_model', async () => {
    await emitWorkerResult({ model: 'claude-opus-4-7', input: 1000, output: 200, cost: 0.05 });
    await emitWorkerResult({ model: 'claude-sonnet-4-6', input: 2000, output: 300, cost: 0.02 });
    await emitWorkerResult({ model: 'claude-opus-4-7', input: 500, output: 100, cost: 0.03 });

    const report = computeUsage(store, { window: '24h', granularity: 'hour' });
    expect(report.totals.cost_usd).toBeCloseTo(0.1, 4);
    expect(report.totals.input_tokens).toBe(3500);
    expect(report.totals.output_tokens).toBe(600);
    expect(report.by_model['claude-opus-4-7'].cost_usd).toBeCloseTo(0.08, 4);
    expect(report.by_model['claude-sonnet-4-6'].cost_usd).toBeCloseTo(0.02, 4);
    expect(report.totals.events).toBe(3);
  });

  it('buckets by granularity and respects the window cutoff', async () => {
    const now = new Date('2026-05-13T10:30:00Z');
    // 1h ago (inside 24h window)
    await emitWorkerResult({ at: new Date(now.getTime() - 60 * 60_000), model: 'claude-opus-4-7', input: 100, output: 50, cost: 0.01 });
    // 5h ago (inside 24h window, different bucket)
    await emitWorkerResult({ at: new Date(now.getTime() - 5 * 60 * 60_000), model: 'claude-opus-4-7', input: 200, output: 75, cost: 0.02 });
    // 50h ago (outside 24h window)
    await emitWorkerResult({ at: new Date(now.getTime() - 50 * 60 * 60_000), model: 'claude-opus-4-7', input: 999, output: 999, cost: 9.99 });

    const report = computeUsage(store, { window: '24h', granularity: 'hour', now });
    expect(report.totals.cost_usd).toBeCloseTo(0.03, 4);
    expect(report.buckets).toHaveLength(2);
  });

  it('burn_rate projects from the most-recent 15 minutes', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    // 1 minute ago — counts toward last_15_min
    await emitWorkerResult({ at: new Date(now.getTime() - 60_000), model: 'claude-opus-4-7', input: 100, output: 50, cost: 1.0 });
    // 20 minutes ago — outside the 15-min window
    await emitWorkerResult({ at: new Date(now.getTime() - 20 * 60_000), model: 'claude-opus-4-7', input: 100, output: 50, cost: 5.0 });

    const report = computeUsage(store, { window: '24h', granularity: 'hour', now });
    expect(report.burn_rate.last_15_min_usd).toBeCloseTo(1.0, 4);
    // $1 in 15 min → $4/hour → $96/day
    expect(report.burn_rate.projected_daily_usd).toBeCloseTo(96, 1);
  });

  it('returns api_balance unavailable when ANTHROPIC_ADMIN_API_KEY is unset', async () => {
    _resetAdminBalanceCache();
    delete process.env.ANTHROPIC_ADMIN_API_KEY;
    const balance = await fetchAnthropicBalance();
    expect(balance.source).toBe('unavailable');
    expect(balance.estimated_usd).toBeNull();
  });

  it('honors an injected fetch when ANTHROPIC_ADMIN_API_KEY is set, caches for 5 min', async () => {
    _resetAdminBalanceCache();
    let calls = 0;
    const stubFetch = (async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return { balance_usd: 42.5 };
        },
      } as unknown as Response;
    }) as typeof fetch;
    const first = await fetchAnthropicBalance({ envKey: 'sk-admin-test', fetchImpl: stubFetch });
    expect(first.estimated_usd).toBe(42.5);
    expect(first.source).toBe('anthropic_admin_api');
    const second = await fetchAnthropicBalance({ envKey: 'sk-admin-test', fetchImpl: stubFetch });
    expect(calls).toBe(1); // cached
    expect(second.estimated_usd).toBe(42.5);
  });
});
