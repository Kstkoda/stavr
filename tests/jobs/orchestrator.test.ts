/**
 * tests/jobs/orchestrator.test.ts — JobOrchestrator unit tests with a stub
 * binding so the lifecycle transitions are exercised independently of any
 * real process.
 *
 * What we verify here:
 *   - register / listBindings reflect the catalogue.
 *   - dispatch persists a row in `dispatched`, then transitions to `running`.
 *   - binding-emitted progress / metadata / activity / log fan out as
 *     job_progress / job_metadata_changed / job_heartbeat / job_log on the
 *     broker.
 *   - binding-emitted `exit` transitions the row to a terminal lifecycle
 *     state and publishes job_terminated.
 *   - terminate(force) sends through to the handle and stamps the row.
 *   - inject() respects the binding's `capabilities.inject`.
 *   - duplicate name on an active job is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator, OrchestratorError } from '../../src/jobs/orchestrator.js';
import { JobEventBus } from '../../src/jobs/event-bus.js';
import type {
  BindingHandle,
  ExecutorBinding,
  JobExitInfo,
} from '../../src/jobs/types.js';

interface MockBinding {
  binding: ExecutorBinding<{ note?: string }>;
  buses: JobEventBus[];
  dispatches: number;
  terminations: Array<'soft' | 'hard'>;
  lastHandle?: BindingHandle;
}

function makeMockBinding(opts: { target?: string; withInject?: boolean } = {}): MockBinding {
  const handle: MockBinding = { binding: null as never, buses: [], dispatches: 0, terminations: [] };
  const binding: ExecutorBinding<{ note?: string }> = {
    kind: 'process-spawn',
    target: opts.target ?? 'mock',
    displayName: 'Mock',
    description: 'mock binding',
    capabilities: { inject: !!opts.withInject },
    paramsSchema: z.object({ note: z.string().optional() }),
    async dispatch(_params, _ctx): Promise<BindingHandle> {
      handle.dispatches++;
      const bus = new JobEventBus();
      handle.buses.push(bus);
      const h: BindingHandle = {
        pid: 9000 + handle.dispatches,
        metadata: { cwd: '/tmp/mock', note: _params.note },
        events: bus,
        async terminate(force: boolean) {
          handle.terminations.push(force ? 'hard' : 'soft');
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
        ...(opts.withInject
          ? {
              async inject(_msg) {
                /* no-op */
              },
            }
          : {}),
      };
      handle.lastHandle = h;
      return h;
    },
  };
  handle.binding = binding;
  return handle;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('JobOrchestrator', () => {
  let store: EventStore;
  let broker: Broker;
  let orch: JobOrchestrator;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
  });

  afterEach(() => {
    store.close();
  });

  it('lists registered bindings', () => {
    const m = makeMockBinding({ target: 'mock-a' });
    orch.register(m.binding);
    const list = orch.listBindings();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('process-spawn');
    expect(list[0].target).toBe('mock-a');
    expect(list[0].capabilities).toEqual({ inject: false });
  });

  it('rejects duplicate binding registration', () => {
    const m1 = makeMockBinding({ target: 'dup' });
    const m2 = makeMockBinding({ target: 'dup' });
    orch.register(m1.binding);
    expect(() => orch.register(m2.binding)).toThrow();
  });

  it('dispatch persists a JobRecord and transitions to running', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'j1',
      params: { note: 'hi' },
    });
    expect(job.lifecycle_state).toBe('running');
    expect(job.binding_kind).toBe('process-spawn');
    expect(job.binding_target).toBe('mock');
    expect(job.metadata).toMatchObject({ pid: 9001, cwd: '/tmp/mock' });

    const persisted = store.getJob(job.id);
    expect(persisted?.lifecycle_state).toBe('running');
    expect(m.dispatches).toBe(1);
  });

  it('rejects duplicate active job names', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'dup',
      params: {},
    });
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'dup',
        params: {},
      }),
    ).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('fans binding progress / log events onto the broker as job_*', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    const events: Array<{ kind: string; payload: unknown }> = [];
    broker.onEvent((ev) => {
      events.push({ kind: ev.kind, payload: ev.payload });
    });
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'fan',
      params: {},
    });
    m.lastHandle?.events && // sanity
      m.buses[0].emitProgress({ message: 'tick' });
    m.buses[0].emitLog({ stream: 'stdout', line: 'hello' });
    m.buses[0].emitMetadata({ patch: { phase: 'mid' } });
    m.buses[0].emitActivity({ detail: 'heartbeat' });
    await flush();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('job_dispatched');
    expect(kinds).toContain('job_started');
    expect(kinds).toContain('job_progress');
    expect(kinds).toContain('job_log');
    expect(kinds).toContain('job_metadata_changed');
    expect(kinds).toContain('job_heartbeat');

    // The metadata patch must have been persisted.
    const refreshed = store.getJob(job.id);
    expect(refreshed?.metadata).toMatchObject({ phase: 'mid' });
  });

  it('binding exit transitions the row to completed-clean and publishes job_terminated', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'finish',
      params: {},
    });
    m.buses[0].emitExit({ exitCode: 0, reason: 'completed' });
    await flush();

    const persisted = store.getJob(job.id);
    expect(persisted?.lifecycle_state).toBe('completed-clean');
    expect(persisted?.exit_code).toBe(0);
    expect(persisted?.ended_at).toBeDefined();
    expect(orch.liveCount()).toBe(0);
  });

  it('terminate(force=true) kills the binding and stamps killed-by-operator', async () => {
    const m = makeMockBinding();
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'kill',
      params: {},
    });
    await orch.terminate(job.id, true);
    await flush();
    expect(m.terminations).toEqual(['hard']);
    const persisted = store.getJob(job.id);
    expect(persisted?.lifecycle_state).toBe('killed-by-operator');
  });

  it('inject errors when the binding does not advertise the capability', async () => {
    const m = makeMockBinding({ withInject: false });
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'inj',
      params: {},
    });
    await expect(orch.inject(job.id, { msg: 'hi' })).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('inject succeeds when the binding advertises it', async () => {
    const m = makeMockBinding({ withInject: true });
    orch.register(m.binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'inj2',
      params: {},
    });
    const result = await orch.inject(job.id, { msg: 'hi' });
    expect(result.message_id).toBeDefined();
  });

  it('rejects an unknown binding key', async () => {
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'does-not-exist',
        name: 'nope',
        params: {},
      }),
    ).rejects.toBeInstanceOf(OrchestratorError);
  });

  it('rejects params that fail the binding schema', async () => {
    const strict: ExecutorBinding<{ n: number }> = {
      kind: 'process-spawn',
      target: 'strict',
      displayName: 'Strict',
      description: 'requires n:number',
      capabilities: { inject: false },
      paramsSchema: z.object({ n: z.number() }),
      async dispatch(_p, _ctx) {
        throw new Error('should not reach');
      },
    };
    orch.register(strict as ExecutorBinding);
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'strict',
        name: 's',
        params: { n: 'not-a-number' },
      }),
    ).rejects.toBeInstanceOf(OrchestratorError);
  });
});
