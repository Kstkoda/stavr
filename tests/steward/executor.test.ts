// tests/steward/executor.test.ts
//
// Unit tests for the BomExecutor — happy path, replan within envelope,
// replan escalates risk class, resume after restart.

import { describe, it, expect, vi } from 'vitest';

import { BomExecutor } from '../../src/steward/executor.js';
import type {
  ExecutorBomStore,
  ExecutorEventSubscriber,
  ExecutorScopeManager,
} from '../../src/steward/executor.js';
import type {
  Connector,
  ConnectorCapability,
  ConnectorRegistry,
  ExecResult,
} from '../../src/connectors/index.js';
import type { Bom, BomStep, BomStepStatus, RiskClass } from '../../src/types/stavr-bom.js';
import type { PlannerEventEmitter, StewardPlanner } from '../../src/steward/planner.js';

// ============================================================
// FIXTURES
// ============================================================

interface StepRow extends BomStep {
  status: BomStepStatus;
  cost_actual: number;
  tokens_in: number;
  tokens_out: number;
  worker_id?: string;
  error_message?: string;
  retry_count: number;
  started_at?: string;
  ended_at?: string;
}

function makeStore(bom: Bom, stepsByVersion: Map<number, StepRow[]>): ExecutorBomStore {
  return {
    getBom: () => bom,
    listBoms: (filter) => (!filter?.status || filter.status === bom.status ? [bom] : []),
    getActiveVersion: () => ({ steps: stepsByVersion.get(bom.active_version) ?? [] }),
    updateBomStatus: (id, patch) => {
      Object.assign(bom, patch);
    },
    updateBomStep: (id, version, stepNo, patch) => {
      const steps = stepsByVersion.get(version);
      const step = steps?.find((s) => s.step_no === stepNo);
      if (step) Object.assign(step, patch);
    },
    listBomSteps: (id, version) => (stepsByVersion.get(version) ?? []).map((s) => ({ ...s })),
  };
}

function fakeConnector(
  id: string,
  exec: (capabilityId: string, args: Record<string, unknown>) => Promise<ExecResult>,
): Connector {
  const cap: ConnectorCapability = {
    id: 'test_cap',
    description: 'test',
    capabilityTag: 'reading',
    riskClass: 'read-only',
    argsSchema: [],
    enabled: true,
  };
  return {
    id,
    kind: 'test',
    displayName: id,
    position: 'below',
    logoPath: null,
    configSchema: () => [],
    applyConfig: async () => ({ kind: 'ok', detail: 'configured', lastChecked: new Date().toISOString() }),
    testConnection: async () => ({ kind: 'ok', detail: 'reachable', lastChecked: new Date().toISOString() }),
    status: () => ({ kind: 'ok', detail: 'ok', lastChecked: new Date().toISOString() }),
    capabilities: () => [cap],
    exec: (capId, args) => exec(capId, args),
  };
}

function makeRegistry(): ConnectorRegistry {
  const map = new Map<string, Connector>();
  return {
    register: (c) => {
      map.set(c.id, c);
    },
    unregister: (id) => map.delete(id),
    get: (id) => map.get(id),
    list: () => Array.from(map.values()),
    listByKind: () => [],
    allCapabilities: () => [],
  };
}

function makeEvents() {
  const seen: Array<{ kind: string; payload: unknown }> = [];
  const emitter: PlannerEventEmitter = {
    publish: async (kind, payload) => {
      seen.push({ kind, payload });
    },
  };
  return { emitter, seen };
}

function fakeSubscribe(): { subscribe: ExecutorEventSubscriber; fire: (event: { kind: string; payload: unknown }) => void } {
  const handlers = new Map<string, Set<(e: { kind: string; payload: unknown; correlation_id?: string }) => void>>();
  const subscribe: ExecutorEventSubscriber = (kind, handler) => {
    if (!handlers.has(kind)) handlers.set(kind, new Set());
    handlers.get(kind)!.add(handler);
    return () => handlers.get(kind)?.delete(handler);
  };
  const fire = (event: { kind: string; payload: unknown; correlation_id?: string }) => {
    handlers.get(event.kind)?.forEach((h) => h(event));
  };
  return { subscribe, fire };
}

function fakeScopes(): ExecutorScopeManager {
  let counter = 0;
  return {
    createBomScope: () => `scope_${++counter}`,
    closeBomScope: () => {},
  };
}

function makeBom(overrides: Partial<Bom> = {}): Bom {
  return {
    id: 'bom_test',
    goal: 'test goal',
    requester: 'corr_1',
    correlation_id: 'corr_1',
    status: 'approved',
    active_version: 1,
    cost_estimate: 0.01,
    cost_max: 0.05,
    duration_sec: 60,
    cost_actual: 0,
    steps_done: 0,
    steps_total: 3,
    profile_mode: 'balanced',
    risk_envelope: ['read-only', 'write-local'],
    proposed_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    is_draft: false,
    ...overrides,
  };
}

function makeStep(stepNo: number, overrides: Partial<StepRow> = {}): StepRow {
  return {
    step_no: stepNo,
    title: `step ${stepNo}`,
    capability: 'reading',
    risk_class: 'read-only',
    brick_id: 'test-brick',
    model: 'claude-haiku-4-5',
    cost_estimate: 0.001,
    duration_sec_est: 10,
    depends_on: [],
    status: 'pending',
    cost_actual: 0,
    tokens_in: 0,
    tokens_out: 0,
    retry_count: 0,
    ...overrides,
  };
}

function fakePlanner(impl?: Partial<StewardPlanner>): StewardPlanner {
  return {
    proposePlan: vi.fn(async () => ({ bomId: 'bom_unused' })),
    replan: vi.fn(async () => ({ newVersion: 2, willEscalateRiskClass: false })),
    ...(impl as object),
  } as unknown as StewardPlanner;
}

// ============================================================
// TESTS
// ============================================================

describe('BomExecutor', () => {
  it('runs a 3-step BOM happily, transitions status, emits start+complete events', async () => {
    const bom = makeBom();
    const steps = [makeStep(1), makeStep(2, { depends_on: [1] }), makeStep(3, { depends_on: [2] })];
    const store = makeStore(bom, new Map([[1, steps]]));
    const registry = makeRegistry();
    registry.register(
      fakeConnector('test-brick', async () => ({ ok: true, durationMs: 5, cost: 0.0005 })),
    );
    const { emitter, seen } = makeEvents();
    const sub = fakeSubscribe();
    const planner = fakePlanner();
    const exec = new BomExecutor({
      events: emitter,
      subscribe: sub.subscribe,
      store,
      connectors: registry,
      scopes: fakeScopes(),
      planner,
    });

    await exec.runBom(bom.id);

    expect(bom.status).toBe('done');
    expect(steps.every((s) => s.status === 'done')).toBe(true);
    expect(seen.filter((e) => e.kind === 'bom_step_started').length).toBe(3);
    expect(seen.filter((e) => e.kind === 'bom_step_completed').length).toBe(3);
    expect(seen.find((e) => e.kind === 'bom_completed')).toBeDefined();
    expect(bom.cost_actual).toBeCloseTo(0.0015, 4);
  });

  it('on step failure beyond retry cap, calls planner.replan and resumes when envelope is fine', async () => {
    const bom = makeBom();
    const v1Steps = [makeStep(1), makeStep(2, { depends_on: [1] })];
    const v2Steps = [
      { ...makeStep(1), status: 'done' as BomStepStatus },
      makeStep(2, { depends_on: [1] }),
    ];
    const stepsByVersion = new Map<number, StepRow[]>([
      [1, v1Steps],
      [2, v2Steps],
    ]);
    const store = makeStore(bom, stepsByVersion);

    let step2Calls = 0;
    const registry = makeRegistry();
    registry.register(
      fakeConnector('test-brick', async (_capId, args) => {
        // step 1 always succeeds; step 2 fails on v1 (4 attempts → exhaust retries → replan), succeeds on v2
        const isStep2 = (args as { step?: number }).step === 2 || stepIsCurrentlyFailing();
        function stepIsCurrentlyFailing() {
          // Heuristic: we set args differently per step below
          return false;
        }
        if (isStep2 && bom.active_version === 1) {
          step2Calls += 1;
          return { ok: false, durationMs: 5, error: 'simulated failure on step 2 v1' };
        }
        return { ok: true, durationMs: 5, cost: 0.0005 };
      }),
    );

    // Tag step 2 args so the connector knows it's step 2
    (v1Steps[1] as unknown as { args: Record<string, unknown> }).args = { step: 2 };
    (v2Steps[1] as unknown as { args: Record<string, unknown> }).args = { step: 2, retried: true };

    const { emitter, seen } = makeEvents();
    const sub = fakeSubscribe();
    const planner = fakePlanner({
      replan: vi.fn(async () => {
        bom.active_version = 2;
        return { newVersion: 2, willEscalateRiskClass: false };
      }),
    });
    const exec = new BomExecutor(
      {
        events: emitter,
        subscribe: sub.subscribe,
        store,
        connectors: registry,
        scopes: fakeScopes(),
        planner,
      },
      { maxRetriesPerStep: 3 },
    );

    await exec.runBom(bom.id);

    expect(bom.status).toBe('done');
    expect(planner.replan).toHaveBeenCalledTimes(1);
    expect(step2Calls).toBeGreaterThanOrEqual(4); // initial + 3 retries
    expect(seen.find((e) => e.kind === 'bom_completed')).toBeDefined();
  });

  it('marks bom failed when replan would escalate risk class', async () => {
    const bom = makeBom();
    const steps = [makeStep(1)];
    const store = makeStore(bom, new Map([[1, steps]]));
    const registry = makeRegistry();
    registry.register(
      fakeConnector('test-brick', async () => ({ ok: false, durationMs: 5, error: 'always fails' })),
    );
    const { emitter, seen } = makeEvents();
    const sub = fakeSubscribe();
    const planner = fakePlanner({
      replan: vi.fn(async () => ({ newVersion: 2, willEscalateRiskClass: true })),
    });
    const exec = new BomExecutor(
      {
        events: emitter,
        subscribe: sub.subscribe,
        store,
        connectors: registry,
        scopes: fakeScopes(),
        planner,
      },
      { maxRetriesPerStep: 0 }, // trigger replan immediately
    );

    await exec.runBom(bom.id);

    expect(bom.status).toBe('failed');
    expect(planner.replan).toHaveBeenCalledTimes(1);
    const failedEvent = seen.find((e) => e.kind === 'bom_failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { reason: string }).reason).toMatch(/escalate/);
  });

  it('on start(), resumes BOMs already in running status and finishes them', async () => {
    const bom = makeBom({ status: 'running', scope_id: 'scope_existing' });
    const steps = [makeStep(1, { status: 'done' }), makeStep(2, { depends_on: [1] })];
    const store = makeStore(bom, new Map([[1, steps]]));
    const registry = makeRegistry();
    registry.register(
      fakeConnector('test-brick', async () => ({ ok: true, durationMs: 5, cost: 0.0002 })),
    );
    const { emitter, seen } = makeEvents();
    const sub = fakeSubscribe();
    const planner = fakePlanner();
    const exec = new BomExecutor({
      events: emitter,
      subscribe: sub.subscribe,
      store,
      connectors: registry,
      scopes: fakeScopes(),
      planner,
    });

    exec.start();
    // Allow scheduled async runBom to finish.
    await new Promise((r) => setTimeout(r, 30));
    exec.stop();

    expect(bom.status).toBe('done');
    // Step 1 was already done at startup, only step 2 runs.
    expect(seen.filter((e) => e.kind === 'bom_step_started').length).toBe(1);
    expect((seen.find((e) => e.kind === 'bom_step_started')?.payload as { step_no: number }).step_no).toBe(2);
  });
});

// Ensure RiskClass is referenced so eslint/ts don't warn on unused.
const _typeCheck: RiskClass = 'read-only';
void _typeCheck;
