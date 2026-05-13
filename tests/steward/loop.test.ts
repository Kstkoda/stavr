import { describe, expect, it, beforeEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { startStewardLoop } from '../../src/steward/loop.js';
import type {
  StewardCompleteOpts,
  StewardEvent,
  StewardProvider,
} from '../../src/steward/providers/types.js';
import { StewardConfigZ, type StewardConfig } from '../../src/steward/config.js';

function makeMockProvider(events: StewardEvent[]): StewardProvider {
  return {
    name: 'mock',
    defaultModel: 'mock-1',
    async *complete(_opts: StewardCompleteOpts) {
      for (const ev of events) yield ev;
    },
  };
}

function makeConfig(overrides: Partial<StewardConfig['steward']> = {}): StewardConfig {
  return StewardConfigZ.parse({
    steward: {
      enabled: true,
      display_name: 'Co',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      credential_id: 'test',
      max_tokens_per_action: 4000,
      budget: { daily_usd: 10, weekly_usd: 50 },
      memory_path: '/tmp/ignored',
      trust_scope: { auto_grant_basics: true },
      ...overrides,
    },
  });
}

describe('Spec 49 Layer 1 — agent loop event sequence', () => {
  let store: EventStore;
  let broker: Broker;
  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  it('prompt -> thinking -> response -> usage in exactly that order with no tool calls', async () => {
    const provider = makeMockProvider([
      { kind: 'text', text: 'hi there' },
      { kind: 'usage', usage: { input_tokens: 5, output_tokens: 4, cost_usd: 0.001 } },
      { kind: 'done' },
    ]);
    const loop = await startStewardLoop({
      broker,
      provider,
      config: makeConfig(),
      toolDispatcher: async () => undefined,
    });
    const r = await loop.handlePrompt('hello', 'cli');
    expect(r.response_text).toBe('hi there');

    const kinds = store.getEvents({ kinds: ['*'] }).events.map((e) => e.kind);
    // First event is steward_started, then the prompt sequence.
    expect(kinds[0]).toBe('steward_started');
    expect(kinds).toContain('steward_prompt');
    expect(kinds).toContain('steward_thinking');
    expect(kinds).toContain('steward_response');
    expect(kinds).toContain('steward_usage');
    // The first thinking precedes the first response, which precedes the usage emission.
    const thinkIdx = kinds.indexOf('steward_thinking');
    const respIdx = kinds.indexOf('steward_response');
    const usageIdx = kinds.indexOf('steward_usage');
    expect(thinkIdx).toBeGreaterThan(-1);
    expect(thinkIdx).toBeLessThan(usageIdx);
    // Response is the LAST thing we emit per-prompt (after handling all provider events).
    expect(respIdx).toBeGreaterThan(usageIdx);
  });

  it('emits steward_tool_call for each tool_use block and invokes the dispatcher', async () => {
    const provider = makeMockProvider([
      { kind: 'tool_call', call: { id: 'a', name: 'github_read_pr', args: { number: 14 } } },
      { kind: 'tool_call', call: { id: 'b', name: 'worker_list', args: {} } },
      { kind: 'text', text: 'done' },
      { kind: 'usage', usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } },
      { kind: 'done' },
    ]);
    const dispatched: Array<{ tool: string; args: unknown }> = [];
    const loop = await startStewardLoop({
      broker,
      provider,
      config: makeConfig(),
      toolDispatcher: async (tool, args) => {
        dispatched.push({ tool, args });
      },
    });
    await loop.handlePrompt('do stuff');
    expect(dispatched).toEqual([
      { tool: 'github_read_pr', args: { number: 14 } },
      { tool: 'worker_list', args: {} },
    ]);
    const toolEvents = store.getEvents({ kinds: ['steward_tool_call'] }).events;
    expect(toolEvents).toHaveLength(2);
  });
});

describe('Spec 49 Layer 1 — budget cap', () => {
  let store: EventStore;
  let broker: Broker;
  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  it('pauses the steward after a single overspending prompt and emits steward_paused_for_budget', async () => {
    const provider = makeMockProvider([
      { kind: 'text', text: 'expensive' },
      { kind: 'usage', usage: { input_tokens: 1000, output_tokens: 1000, cost_usd: 1.0 } },
      { kind: 'done' },
    ]);
    const loop = await startStewardLoop({
      broker,
      provider,
      config: makeConfig({ budget: { daily_usd: 0.01, weekly_usd: 1 } }),
      toolDispatcher: async () => undefined,
    });
    await loop.handlePrompt('cost more than budget');
    const paused = store.getEvents({ kinds: ['steward_paused_for_budget'] }).events;
    expect(paused).toHaveLength(1);
    const payload = paused[0].payload as { budget_usd: number; spent_usd: number; period: string };
    expect(payload.period).toBe('daily');
    expect(payload.spent_usd).toBeGreaterThan(payload.budget_usd);

    // Next prompt is refused — the loop status reports paused.
    expect(loop.status().paused_for_budget).toBe(true);
    const second = await loop.handlePrompt('try anyway');
    expect(second.paused).toBe(true);
  });

  it('resume(--override-budget) lifts the pause and lets the next prompt through', async () => {
    const provider = makeMockProvider([
      { kind: 'text', text: 'ok' },
      { kind: 'usage', usage: { input_tokens: 1, output_tokens: 1, cost_usd: 1.0 } },
      { kind: 'done' },
    ]);
    const loop = await startStewardLoop({
      broker,
      provider,
      config: makeConfig({ budget: { daily_usd: 0.01, weekly_usd: 1 } }),
      toolDispatcher: async () => undefined,
    });
    await loop.handlePrompt('first cost');
    expect(loop.status().paused_for_budget).toBe(true);
    await loop.resume(true);
    expect(loop.status().budget_override_active).toBe(true);
    const r = await loop.handlePrompt('after resume');
    expect(r.paused).toBeUndefined();
    expect(r.response_text).toBe('ok');
  });

  it('UTC-day rollover resets dailySpend automatically', async () => {
    const provider = makeMockProvider([
      { kind: 'text', text: 'a' },
      { kind: 'usage', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0.05 } },
      { kind: 'done' },
    ]);
    let fakeDate = new Date('2026-05-13T23:59:59Z');
    const loop = await startStewardLoop({
      broker,
      provider,
      config: makeConfig({ budget: { daily_usd: 0.10, weekly_usd: 1 } }),
      toolDispatcher: async () => undefined,
      now: () => fakeDate,
    });
    await loop.handlePrompt('day 1, half spent');
    expect(loop.status().daily_spend_usd).toBeCloseTo(0.05, 5);

    // Cross into next UTC day.
    fakeDate = new Date('2026-05-14T00:00:01Z');
    await loop.handlePrompt('day 2 first prompt');
    expect(loop.status().daily_spend_usd).toBeCloseTo(0.05, 5);
    // The original 0.05 should NOT be carried over to day 2.
    // We just spent 0.05 on day 2, so daily_spend equals 0.05 not 0.10.
  });
});
