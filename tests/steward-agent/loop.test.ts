import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStewardDbs } from '../../src/steward-agent/db/init.js';
import { startStewardAgentLoop } from '../../src/steward-agent/loop.js';
import type { IpcDaemonMessage, IpcStewardLink, IpcStewardMessage } from '../../src/steward/ipc.js';
import type { ModelRuntime } from '../../src/steward-agent/runtimes/types.js';

function makeMockLink() {
  const sent: IpcStewardMessage[] = [];
  let onMessageHandler: ((m: IpcDaemonMessage) => void) | null = null;
  let onShutdownHandler: (() => void) | null = null;
  const link: IpcStewardLink = {
    send(m) { sent.push(m); return true; },
    onMessage(h) { onMessageHandler = h; return () => { onMessageHandler = null; }; },
    onShutdown(h) { onShutdownHandler = h; return () => { onShutdownHandler = null; }; },
  };
  return {
    link,
    sent,
    inject: (m: IpcDaemonMessage) => onMessageHandler?.(m),
    shutdown: () => onShutdownHandler?.(),
  };
}

function makeMockRuntime(planResult: unknown): ModelRuntime {
  return {
    name: 'mock',
    costPerKtoken: { in: 0, out: 0 },
    contextWindow: 1000,
    plan: async () => planResult as never,
    decide: async () => ({ chosen_option_id: 'a', reason: 'r', confidence: 1, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } }) as never,
    summarize: async () => ({ summary: 's', highlights: [], recommendations: [], usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } }) as never,
  };
}

describe('v0.5 P3 — steward-agent loop', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stavr-p3-loop-'));
  });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('emits "ready" on start, responds to ping with pong', () => {
    const bundle = openStewardDbs(home);
    try {
      const mock = makeMockLink();
      startStewardAgentLoop({
        memory: bundle.memory,
        lessons: bundle.lessons,
        prefs: bundle.prefs,
        link: mock.link,
      });
      expect(mock.sent[0]).toEqual({ type: 'ready' });
      mock.inject({ type: 'ping' });
      expect(mock.sent.find((m) => m.type === 'pong')).toBeDefined();
    } finally { bundle.close(); }
  });

  it('handles request_plan event and emits bom_proposed back via emit_event', async () => {
    const bundle = openStewardDbs(home);
    try {
      const mock = makeMockLink();
      const validResult = {
        goal: 'g',
        steps: [{
          step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
          brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [],
        }],
        cost_estimate: 0,
        cost_max: 1,
        duration_sec_est: 1,
        risk_envelope: ['read-only'],
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      };
      const handle = startStewardAgentLoop({
        memory: bundle.memory,
        lessons: bundle.lessons,
        prefs: bundle.prefs,
        link: mock.link,
        resolveRuntime: () => makeMockRuntime(validResult),
      });
      await handle.dispatch({
        type: 'event',
        kind: 'steward_agent_request',
        payload: {
          type: 'request_plan',
          request_id: 'r1',
          ctx: { goal: 'g', profile_mode: 'balanced', correlation_id: 'c1' },
          tools: [],
        },
      } as unknown as IpcDaemonMessage);
      const proposed = mock.sent.find((m) => m.type === 'emit_event' && m.kind === 'bom_proposed');
      expect(proposed).toBeDefined();
      // episodic_log captured the outcome
      expect(bundle.memory.latestEpisodicSeq()).toBeGreaterThan(0);
    } finally { bundle.close(); }
  });

  it('shadow=true emits bom_proposed_shadow, not bom_proposed', async () => {
    const bundle = openStewardDbs(home);
    try {
      const mock = makeMockLink();
      const validResult = {
        goal: 'g',
        steps: [{ step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
          brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [] }],
        cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      };
      const handle = startStewardAgentLoop({
        memory: bundle.memory,
        lessons: bundle.lessons,
        prefs: bundle.prefs,
        link: mock.link,
        resolveRuntime: () => makeMockRuntime(validResult),
      });
      await handle.dispatch({
        type: 'event',
        kind: 'steward_agent_request',
        payload: {
          type: 'request_plan',
          request_id: 'rs',
          ctx: { goal: 'g', profile_mode: 'balanced' },
          tools: [],
          shadow: true,
        },
      } as unknown as IpcDaemonMessage);
      const shadow = mock.sent.find((m) => m.type === 'emit_event' && m.kind === 'bom_proposed_shadow');
      expect(shadow).toBeDefined();
      const liveProposed = mock.sent.find((m) => m.type === 'emit_event' && m.kind === 'bom_proposed');
      expect(liveProposed).toBeUndefined();
    } finally { bundle.close(); }
  });

  it('runtime throw surfaces as bom_proposed_error', async () => {
    const bundle = openStewardDbs(home);
    try {
      const mock = makeMockLink();
      const handle = startStewardAgentLoop({
        memory: bundle.memory,
        lessons: bundle.lessons,
        prefs: bundle.prefs,
        link: mock.link,
        resolveRuntime: () => ({
          name: 'broken',
          costPerKtoken: { in: 0, out: 0 },
          contextWindow: 1,
          plan: async () => { throw new Error('boom'); },
          decide: async () => { throw new Error('x'); },
          summarize: async () => { throw new Error('x'); },
        }),
      });
      await handle.dispatch({
        type: 'event',
        kind: 'steward_agent_request',
        payload: {
          type: 'request_plan',
          request_id: 'r-fail',
          ctx: { goal: 'g', profile_mode: 'balanced' },
          tools: [],
        },
      } as unknown as IpcDaemonMessage);
      const err = mock.sent.find((m) => m.type === 'emit_event' && m.kind === 'bom_proposed_error');
      expect(err).toBeDefined();
    } finally { bundle.close(); }
  });

  it('enriches plan ctx with lessons + working_memory from stores when missing', async () => {
    const bundle = openStewardDbs(home);
    try {
      bundle.memory.setWorking('focus', 'topology');
      bundle.lessons.insertLesson({
        id: 'L1', title: 'A', body: 'body',
        source: 'self-critique', distilled_from_json: '[]', status: 'active',
      });
      const mock = makeMockLink();
      let seenCtx: { working_memory?: Record<string, unknown>; lessons?: Array<{ id: string }> } | undefined;
      const rt: ModelRuntime = {
        name: 'capture',
        costPerKtoken: { in: 0, out: 0 },
        contextWindow: 1000,
        plan: async (ctx) => {
          seenCtx = { working_memory: ctx.working_memory, lessons: ctx.lessons };
          return {
            goal: ctx.goal, steps: [{
              step_no: 1, title: 't', capability: 'reading', risk_class: 'read-only',
              brick_id: 'b', model: 'm', cost_estimate: 0, duration_sec_est: 1, depends_on: [],
            }],
            cost_estimate: 0, cost_max: 1, duration_sec_est: 1, risk_envelope: ['read-only'],
            usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
          };
        },
        decide: async () => ({}) as never,
        summarize: async () => ({}) as never,
      };
      const handle = startStewardAgentLoop({
        memory: bundle.memory,
        lessons: bundle.lessons,
        prefs: bundle.prefs,
        link: mock.link,
        resolveRuntime: () => rt,
      });
      await handle.dispatch({
        type: 'event',
        kind: 'steward_agent_request',
        payload: {
          type: 'request_plan',
          request_id: 'r2',
          ctx: { goal: 'g', profile_mode: 'balanced' },
          tools: [],
        },
      } as unknown as IpcDaemonMessage);
      expect(seenCtx?.working_memory).toEqual({ focus: 'topology' });
      expect(seenCtx?.lessons).toHaveLength(1);
      expect(seenCtx?.lessons?.[0].id).toBe('L1');
    } finally { bundle.close(); }
  });
});
