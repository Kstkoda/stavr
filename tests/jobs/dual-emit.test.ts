/**
 * tests/jobs/dual-emit.test.ts — Phase 3a broker-event dual-emit window.
 *
 * Every job_* event the JobOrchestrator publishes should be shadowed by a
 * legacy worker_* event so subscribers tuned to the old kinds keep
 * working through the deprecation window. These tests fix the
 * translation contract per src/jobs/dual-emit.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator } from '../../src/jobs/orchestrator.js';
import { JobEventBus } from '../../src/jobs/event-bus.js';
import { DEPRECATION_WINDOW_RELEASES } from '../../src/event-types.js';
import type { BindingHandle, ExecutorBinding } from '../../src/jobs/types.js';

interface MockBinding {
  binding: ExecutorBinding;
  buses: JobEventBus[];
}

function makeMockBinding(): MockBinding {
  const handle: MockBinding = { binding: null as never, buses: [] };
  const binding: ExecutorBinding<{ note?: string }> = {
    kind: 'process-spawn',
    target: 'mock',
    displayName: 'Mock',
    description: 'mock',
    capabilities: { inject: false },
    paramsSchema: z.object({ note: z.string().optional() }),
    async dispatch(_p, _ctx): Promise<BindingHandle> {
      const bus = new JobEventBus();
      handle.buses.push(bus);
      return {
        pid: 9001,
        metadata: { cwd: '/tmp/mock', whatever: 1 },
        events: bus,
        async terminate(force: boolean) {
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
      };
    },
  };
  handle.binding = binding;
  return handle;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('Phase 3a — broker dual-emit', () => {
  let store: EventStore;
  let broker: Broker;
  let orch: JobOrchestrator;
  let events: Array<{ kind: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
    events = [];
    broker.onEvent((ev) => events.push({ kind: ev.kind, payload: ev.payload as Record<string, unknown> }));
  });

  afterEach(() => {
    store.close();
  });

  it('DEPRECATION_WINDOW_RELEASES is 1 (Phase 3a window length)', () => {
    expect(DEPRECATION_WINDOW_RELEASES).toBe(1);
  });

  it('job_started shadows as worker_spawned with synthesised type + cwd', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'dual-start',
      params: {},
    });
    await flush();
    const job = events.find((e) => e.kind === 'job_started');
    const worker = events.find((e) => e.kind === 'worker_spawned');
    expect(job).toBeDefined();
    expect(worker).toBeDefined();
    expect((worker?.payload as { type: string }).type).toBe('process-spawn:mock');
    expect((worker?.payload as { cwd: string }).cwd).toBe('/tmp/mock');
    expect((worker?.payload as { pid: number }).pid).toBe(9001);
  });

  it('job_progress shadows as worker_progress (drops payload slot)', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'prog',
      params: {},
    });
    m.buses[0].emitProgress({ message: 'tick', payload: { i: 5 } });
    await flush();
    const wp = events.find((e) => e.kind === 'worker_progress');
    expect(wp).toBeDefined();
    expect((wp?.payload as { message: string }).message).toBe('tick');
    expect((wp?.payload as Record<string, unknown>).payload).toBeUndefined();
  });

  it('job_heartbeat shadows as worker_activity', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'hb',
      params: {},
    });
    m.buses[0].emitActivity({ detail: 'still alive' });
    await flush();
    const wa = events.find((e) => e.kind === 'worker_activity');
    expect(wa).toBeDefined();
    expect((wa?.payload as { detail: string }).detail).toBe('still alive');
  });

  it('job_log shadows as worker_log with renamed id slots', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'logj',
      params: {},
    });
    m.buses[0].emitLog({ stream: 'stdout', line: 'hello' });
    await flush();
    const wl = events.find((e) => e.kind === 'worker_log');
    expect(wl).toBeDefined();
    expect((wl?.payload as { worker_id: string }).worker_id).toBe(job.id);
    expect((wl?.payload as { worker_name: string }).worker_name).toBe('logj');
    expect((wl?.payload as { stream: string }).stream).toBe('stdout');
    expect((wl?.payload as { line: string }).line).toBe('hello');
  });

  it('job_terminated shadows as worker_terminated with mapped reason', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'term',
      params: {},
    });
    m.buses[0].emitExit({ exitCode: 0, reason: 'completed' });
    await flush();
    const wt = events.find((e) => e.kind === 'worker_terminated');
    expect(wt).toBeDefined();
    expect((wt?.payload as { reason: string }).reason).toBe('completed');
    expect((wt?.payload as { exit_code: number }).exit_code).toBe(0);
  });

  it('job_dispatched does NOT shadow (no legacy parallel)', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'pre',
      params: {},
    });
    await flush();
    // job_dispatched is a Phase 1 concept that has no worker_* analogue.
    // It must fire on the new kind but NOT generate a phantom legacy event.
    expect(events.find((e) => e.kind === 'job_dispatched')).toBeDefined();
    // worker_dispatch_request is a different concept (mid-flight injection)
    // and must not appear without an actual inject() call.
    expect(events.find((e) => e.kind === 'worker_dispatch_request')).toBeUndefined();
  });
});
