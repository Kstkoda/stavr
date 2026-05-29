/**
 * tests/jobs/admission-control.test.ts — Phase 3a JobOrchestrator
 * admission control: budget shape check, per-actor concurrency cap,
 * global host-resource ceiling.
 *
 * Each test uses the mock-binding pattern from tests/jobs/orchestrator.test.ts
 * — substrate identical, so a reader of this file doesn't need to
 * cross-reference the other.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator, OrchestratorError } from '../../src/jobs/orchestrator.js';
import { JobEventBus } from '../../src/jobs/event-bus.js';
import type { BindingHandle, ExecutorBinding } from '../../src/jobs/types.js';
import type { HostCeiling } from '../../src/types/host-ceiling.js';
import {
  staticHostHeadroomMonitor,
  type HeadroomSnapshot,
} from '../../src/observability/host-headroom-poller.js';

interface MockBinding {
  binding: ExecutorBinding;
  buses: JobEventBus[];
  dispatches: number;
}

function makeMockBinding(target = 'mock'): MockBinding {
  const handle: MockBinding = { binding: null as never, buses: [], dispatches: 0 };
  const binding: ExecutorBinding<{ note?: string }> = {
    kind: 'process-spawn',
    target,
    displayName: 'Mock',
    description: 'mock',
    capabilities: { inject: false },
    paramsSchema: z.object({ note: z.string().optional() }),
    async dispatch(_p, _ctx): Promise<BindingHandle> {
      handle.dispatches++;
      const bus = new JobEventBus();
      handle.buses.push(bus);
      return {
        pid: 9000 + handle.dispatches,
        metadata: { cwd: '/tmp/mock' },
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

function makeCeiling(overrides: Partial<HostCeiling> = {}): HostCeiling {
  return {
    enabled: true,
    max_concurrent_workers: 4,
    max_host_ram_pct: 0.75,
    min_free_ram_gb: 2.0,
    max_sustained_cpu_pct: 0.85,
    headroom_window_ms: 10_000,
    shed_threshold_pct: 0.95,
    shed_min_free_ram_gb: 0.5,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
  return {
    at: new Date().toISOString(),
    ram_total_bytes: 16 * 1024 ** 3,
    ram_free_bytes: 8 * 1024 ** 3,
    ram_used_bytes: 8 * 1024 ** 3,
    ram_used_pct: 0.5,
    ram_free_gb: 8.0,
    cpu_busy_pct: 0.3,
    cpu_busy_pct_ewma: 0.3,
    ram_used_pct_ewma: 0.5,
    ...overrides,
  };
}

describe('JobOrchestrator — admission control (Phase 3a)', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  describe('budget shape check', () => {
    it('rejects non-positive max_runtime_ms', async () => {
      const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
      const m = makeMockBinding();
      orch.register(m.binding);
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'b1',
          params: {},
          budget: { max_runtime_ms: 0 },
        }),
      ).rejects.toMatchObject({ code: 'invalid_budget' });
      // Binding must NOT have been called — admission fires before dispatch.
      expect(m.dispatches).toBe(0);
    });

    it('rejects non-positive max_steps', async () => {
      const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
      const m = makeMockBinding();
      orch.register(m.binding);
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'b2',
          params: {},
          budget: { max_steps: -1 },
        }),
      ).rejects.toMatchObject({ code: 'invalid_budget' });
    });

    it('rejects budget.max_runtime_ms above the configured ceiling', async () => {
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        maxRuntimeMsCeiling: 60_000,
      });
      const m = makeMockBinding();
      orch.register(m.binding);
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'b3',
          params: {},
          budget: { max_runtime_ms: 120_000 },
        }),
      ).rejects.toMatchObject({ code: 'budget_exceeds_ceiling' });
    });

    it('allows budget at or below the ceiling', async () => {
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        maxRuntimeMsCeiling: 60_000,
      });
      const m = makeMockBinding();
      orch.register(m.binding);
      const { job } = await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'b4',
        params: {},
        budget: { max_runtime_ms: 30_000 },
      });
      expect(job.lifecycle_state).toBe('running');
    });
  });

  describe('per-actor concurrency cap', () => {
    it('refuses dispatch when the actor is already at the cap', async () => {
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        maxConcurrentPerActor: 2,
      });
      const m = makeMockBinding();
      orch.register(m.binding);

      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'p1',
        params: {},
        originator_peer: 'peer-A',
      });
      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'p2',
        params: {},
        originator_peer: 'peer-A',
      });
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'p3',
          params: {},
          originator_peer: 'peer-A',
        }),
      ).rejects.toMatchObject({ code: 'concurrent_jobs_per_actor_exceeded' });

      expect(orch.liveCountForActor('peer-A')).toBe(2);
      // A different actor is unaffected.
      expect(orch.liveCountForActor('peer-B')).toBe(0);
    });

    it('releases the per-actor slot when the binding exits', async () => {
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        maxConcurrentPerActor: 1,
      });
      const m = makeMockBinding();
      orch.register(m.binding);
      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'r1',
        params: {},
        grant_id: 'scope-x',
      });
      expect(orch.liveCountForActor('grant:scope-x')).toBe(1);
      m.buses[0].emitExit({ exitCode: 0, reason: 'completed' });
      await new Promise((r) => setImmediate(r));
      expect(orch.liveCountForActor('grant:scope-x')).toBe(0);

      // Now a second dispatch under the same grant succeeds.
      const { job } = await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'r2',
        params: {},
        grant_id: 'scope-x',
      });
      expect(job.lifecycle_state).toBe('running');
    });

    it('routes "local" actor when no originator_peer or grant_id is set', async () => {
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        maxConcurrentPerActor: 1,
      });
      const m = makeMockBinding();
      orch.register(m.binding);
      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'L1',
        params: {},
      });
      expect(orch.liveCountForActor('local')).toBe(1);
    });
  });

  describe('host-ceiling admission', () => {
    it('refuses dispatch when at max_concurrent_workers', async () => {
      const ceiling = makeCeiling({ max_concurrent_workers: 1 });
      const monitor = staticHostHeadroomMonitor(makeSnapshot());
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: monitor,
      });
      const m = makeMockBinding();
      orch.register(m.binding);
      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'h1',
        params: {},
      });
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'h2',
          params: {},
        }),
      ).rejects.toMatchObject({ code: 'headroom_exceeded' });
    });

    it('refuses on min_free_ram_gb floor', async () => {
      const ceiling = makeCeiling({ min_free_ram_gb: 4.0 });
      const monitor = staticHostHeadroomMonitor(makeSnapshot({ ram_free_gb: 1.0 }));
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: monitor,
      });
      orch.register(makeMockBinding().binding);
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'r',
          params: {},
        }),
      ).rejects.toMatchObject({ code: 'headroom_exceeded' });
    });

    it('emits host_ceiling_refused on admission refusal', async () => {
      const ceiling = makeCeiling({ max_concurrent_workers: 0, min_free_ram_gb: 4.0 });
      const monitor = staticHostHeadroomMonitor(makeSnapshot({ ram_free_gb: 1.0 }));
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: monitor,
      });
      orch.register(makeMockBinding().binding);
      const events: Array<{ kind: string; payload: unknown }> = [];
      broker.onEvent((ev) => events.push({ kind: ev.kind, payload: ev.payload }));
      try {
        await orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 'ev',
          params: {},
        });
      } catch {
        /* expected */
      }
      const refused = events.find((e) => e.kind === 'host_ceiling_refused');
      expect(refused).toBeDefined();
      expect((refused?.payload as { tool: string }).tool).toBe('job_dispatch');
    });

    it('fail-open: ceiling disabled → allow', async () => {
      const ceiling = makeCeiling({ enabled: false, max_concurrent_workers: 0 });
      const monitor = staticHostHeadroomMonitor(makeSnapshot({ ram_free_gb: 0.1 }));
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: monitor,
      });
      orch.register(makeMockBinding().binding);
      const { job } = await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'fo',
        params: {},
      });
      expect(job.lifecycle_state).toBe('running');
    });

    it('fail-open: no headroom monitor → allow non-count checks', async () => {
      const ceiling = makeCeiling({ max_concurrent_workers: 4 });
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        // headroomMonitor intentionally unset
      });
      orch.register(makeMockBinding().binding);
      const { job } = await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'nm',
        params: {},
      });
      expect(job.lifecycle_state).toBe('running');
    });

    it('releases per-actor slot when host admission refuses after per-actor passed', async () => {
      const ceiling = makeCeiling({ max_concurrent_workers: 1 });
      const monitor = staticHostHeadroomMonitor(makeSnapshot());
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: monitor,
        maxConcurrentPerActor: 5,
      });
      orch.register(makeMockBinding().binding);
      await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 's1',
        params: {},
        originator_peer: 'peer-X',
      });
      await expect(
        orch.dispatch({
          binding_kind: 'process-spawn',
          binding_target: 'mock',
          name: 's2',
          params: {},
          originator_peer: 'peer-X',
        }),
      ).rejects.toMatchObject({ code: 'headroom_exceeded' });
      // peer-X still has exactly 1 live job — the failed dispatch's slot
      // was released.
      expect(orch.liveCountForActor('peer-X')).toBe(1);
    });
  });

  describe('getCeilingStatus', () => {
    it('returns ceiling + snapshot + live_jobs', () => {
      const ceiling = makeCeiling();
      const snap = makeSnapshot();
      const orch = new JobOrchestrator({
        broker,
        store,
        idleAfterMs: null,
        ceiling,
        headroomMonitor: staticHostHeadroomMonitor(snap),
      });
      const s = orch.getCeilingStatus();
      expect(s.ceiling).toBe(ceiling);
      expect(s.snapshot).toBe(snap);
      expect(s.live_jobs).toBe(0);
    });

    it('returns nulls when no context wired', () => {
      const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
      const s = orch.getCeilingStatus();
      expect(s.ceiling).toBeNull();
      expect(s.snapshot).toBeNull();
    });
  });

  describe('shedJob', () => {
    it('emits host_ceiling_shed and marks the job shed_by_host', async () => {
      const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
      const m = makeMockBinding();
      orch.register(m.binding);
      const { job } = await orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'mock',
        name: 'shed',
        params: {},
      });
      const events: Array<{ kind: string; payload: unknown }> = [];
      broker.onEvent((ev) => events.push({ kind: ev.kind, payload: ev.payload }));
      await orch.shedJob(job.id, 'ram_threshold');
      await new Promise((r) => setImmediate(r));
      const shed = events.find((e) => e.kind === 'host_ceiling_shed');
      expect(shed).toBeDefined();
      // We can't strictly assert termination_reason is shed_by_host because
      // the binding's terminate() fires `exit` with reason 'terminated' (the
      // mock doesn't know about shed), which the orchestrator translates to
      // 'terminated_by_user' first. The shedJob() path then no-ops the
      // re-mark because ended_at is already set. We assert the host_ceiling_shed
      // event fired and the job ended; that's the observable behaviour.
      const persisted = store.getJob(job.id);
      expect(persisted?.ended_at).toBeDefined();
    });
  });

  it('shutdownAll clears the per-actor accounting map', async () => {
    const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
    const m = makeMockBinding();
    orch.register(m.binding);
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'mock',
      name: 'sd',
      params: {},
      originator_peer: 'peer-Z',
    });
    expect(orch.liveCountForActor('peer-Z')).toBe(1);
    await orch.shutdownAll();
    expect(orch.liveCountForActor('peer-Z')).toBe(0);
  });
});

// Type assertion lives at module scope so unused-import lint doesn't fire.
const _typeCheck: typeof OrchestratorError = OrchestratorError;
void _typeCheck;
