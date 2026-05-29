/**
 * tests/jobs/orchestrator-grant.test.ts
 *
 * worker-dispatch Phase 4 — JobOrchestrator grant gate.
 *
 * Locked composition (operator 10-3-1, 2026-05-29 — option C):
 *  - peer:* actors MUST pass explicit grant_id; missing → 'grant_required'.
 *  - Operator-shape actors auto-resolve; no match → sentinel (always allow,
 *    no budget decrement, no grant_consumed event, JobRecord.grant_id
 *    stays undefined).
 *  - Coverage check: covered_tools must include 'job_dispatch' AND
 *    covered_targets must include the binding_target.
 *  - Budget decrement is atomic (better-sqlite3 transaction).
 *  - Failed grants do NOT burn per-actor concurrency slots.
 *  - All denials emit grant_denied with structured reason; successes emit
 *    grant_consumed (sentinel resolutions do NOT emit grant_consumed).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator, OrchestratorError } from '../../src/jobs/orchestrator.js';
import { JobEventBus } from '../../src/jobs/event-bus.js';
import type { BindingHandle, ExecutorBinding } from '../../src/jobs/types.js';
import { TrustStore } from '../../src/trust/store.js';
import type { TrustScope } from '../../src/trust/types.js';
import type { HostCeiling } from '../../src/types/host-ceiling.js';

interface MockBinding {
  binding: ExecutorBinding;
  buses: JobEventBus[];
  dispatches: number;
}

function makeMockBinding(target = 'claude-code-subprocess'): MockBinding {
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
        async terminate(_force: boolean) {
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
      };
    },
  };
  handle.binding = binding;
  return handle;
}

let store: EventStore;
let broker: Broker;
let trustStore: TrustStore;
let events: Array<{ kind: string; payload: unknown }> = [];

beforeEach(() => {
  store = new EventStore();
  store.init(':memory:');
  broker = new Broker(store);
  trustStore = new TrustStore(store);
  events = [];
  const origPublish = broker.publish.bind(broker);
  broker.publish = async (event) => {
    const stored = await origPublish(event);
    events.push({ kind: stored.kind, payload: stored.payload });
    return stored;
  };
});

afterEach(() => {
  store.close();
});

function newOrch(): JobOrchestrator {
  const orch = new JobOrchestrator({
    broker,
    store,
    trustStore,
    idleAfterMs: null,
  });
  const m = makeMockBinding();
  orch.register(m.binding);
  return orch;
}

function grantNow(over: Partial<{
  actor_id: string;
  covered_tools: string[];
  covered_targets: string[];
  budget_remaining: number;
}> = {}): TrustScope {
  const proposal = trustStore.createProposal({
    title: 'test',
    description: 'test',
    allowed_actions: [{ tool: 'job_dispatch' }],
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    actor_id: over.actor_id,
    covered_tools: over.covered_tools,
    covered_targets: over.covered_targets,
    budget_remaining: over.budget_remaining,
  });
  return trustStore.grant(proposal.id, 'test-operator')!;
}

function findEvents(kind: string): Array<{ kind: string; payload: any }> {
  return events.filter((e) => e.kind === kind);
}

describe('JobOrchestrator grant gate — peer:* explicit-grant path', () => {
  it('peer:* with no grant_id is denied with grant_required', async () => {
    const orch = newOrch();
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-1',
        params: {},
        actor_id: 'peer:alice',
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    const denied = findEvents('grant_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].payload.reason).toBe('grant_required');
    expect(denied[0].payload.actor_id).toBe('peer:alice');
    expect(denied[0].payload.tool).toBe('job_dispatch');
    // No JobRecord row inserted; no grant_consumed.
    expect(findEvents('grant_consumed')).toHaveLength(0);
    expect(findEvents('job_dispatched')).toHaveLength(0);
  });

  it('peer:* with a valid grant + matching coverage dispatches and decrements budget', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
      budget_remaining: 3,
    });
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-ok',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(job.grant_id).toBe(scope.id);
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(2);
    const consumed = findEvents('grant_consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0].payload).toMatchObject({
      actor_id: 'peer:alice',
      grant_id: scope.id,
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      budget_before: 3,
      budget_after: 2,
    });
  });

  it('grant_not_for_actor when peer:alice tries to use peer:bobs grant', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:bob',
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-x',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    const denied = findEvents('grant_denied');
    expect(denied[0].payload.reason).toBe('grant_not_for_actor');
    expect(denied[0].payload.grant_id).toBe(scope.id);
  });

  it('tool_not_covered when grant covers a different tool', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['job_inject'],
      covered_targets: ['*'],
    });
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-x',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    expect(findEvents('grant_denied')[0].payload.reason).toBe('tool_not_covered');
  });

  it('target_not_covered when grant covers a different binding target', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['ollama-local'],
    });
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-x',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    expect(findEvents('grant_denied')[0].payload.reason).toBe('target_not_covered');
  });

  it('budget_exhausted on the (N+1)-th dispatch when budget started at N', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
      budget_remaining: 2,
    });
    // Two successful dispatches.
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-1',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-2',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(0);
    // Third dispatch is denied.
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-3',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    const denied = findEvents('grant_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].payload.reason).toBe('budget_exhausted');
  });
});

describe('JobOrchestrator grant gate — operator-shape auto-resolve', () => {
  it('operator with no covering grant dispatches via sentinel (no event, undefined grant_id)', async () => {
    const orch = newOrch();
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-local',
      params: {},
      actor_id: 'operator',
    });
    expect(job.grant_id).toBeUndefined();
    // Sentinel path does NOT emit grant_consumed (lock #4).
    expect(findEvents('grant_consumed')).toHaveLength(0);
    expect(findEvents('grant_denied')).toHaveLength(0);
  });

  it('unstamped-loopback (stdio default) takes the sentinel path with no actor_id passed', async () => {
    const orch = newOrch();
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-stdio',
      params: {},
      // no actor_id → defaults to 'unstamped-loopback' (operator-shape)
    });
    expect(job.grant_id).toBeUndefined();
    expect(findEvents('grant_consumed')).toHaveLength(0);
  });

  it('operator auto-resolves to a matching global grant and decrements budget', async () => {
    const orch = newOrch();
    const scope = grantNow({
      // actor_id NULL — global capability
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
      budget_remaining: 5,
    });
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-auto',
      params: {},
      actor_id: 'operator',
    });
    expect(job.grant_id).toBe(scope.id);
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
    expect(findEvents('grant_consumed')).toHaveLength(1);
  });

  it('operator auto-resolves to an actor-specific grant when available', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'operator',
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-auto-2',
      params: {},
      actor_id: 'operator',
    });
    expect(job.grant_id).toBe(scope.id);
  });
});

describe('JobOrchestrator grant gate — interaction with other admission gates', () => {
  it('failed grant does NOT burn a per-actor concurrency slot', async () => {
    const orch = new JobOrchestrator({
      broker,
      store,
      trustStore,
      idleAfterMs: null,
      maxConcurrentPerActor: 1,
    });
    orch.register(makeMockBinding().binding);
    // First dispatch from peer:alice fails on grant_required (no grant
    // passed). If the grant gate burned the concurrency slot before the
    // failure, the SECOND dispatch (with a valid grant) would refuse on
    // concurrent_jobs_per_actor_exceeded — that's the bug we're guarding.
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-fail',
        params: {},
        actor_id: 'peer:alice',
      }),
    ).rejects.toMatchObject({ code: 'grant_denied' });
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    // Second dispatch with a valid grant must succeed — proving the
    // per-actor slot was NOT reserved by the failed first attempt. If
    // the failed-grant path had burned the slot, this would throw
    // concurrent_jobs_per_actor_exceeded under the maxConcurrentPerActor=1
    // ceiling. The internal actor-key for the slot is `grant:<id>` (per
    // resolveActorId precedence), not 'peer:alice', so we assert on the
    // observable property: dispatch succeeds and the orchestrator's
    // total live count is 1.
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-ok',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(job.lifecycle_state).toBe('running');
    expect(orch.liveCount()).toBe(1);
  });

  it('matrix-tier NO_GO is upstream and out of scope (grant cannot lift it)', async () => {
    // The operator's lock: "NO_GO from matrix is closure-by-default;
    // grant cannot lift it (the chokepoint already denied before
    // JobOrchestrator was reached)." This test documents the
    // architectural property — JobOrchestrator never sees a NO_GO call
    // because chokepoint denies first. We assert that the orchestrator
    // itself doesn't check the matrix tier; the grant gate is purely
    // additive. (No chokepoint here; we're testing the orchestrator in
    // isolation.) A peer:* dispatch with a valid grant succeeds; a real
    // deployment would have had chokepoint deny first if the matrix
    // said NO_GO. The orchestrator has no matrix-tier knowledge.
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-ok',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(job.lifecycle_state).toBe('running');
  });
});

describe('JobOrchestrator grant gate — budget integrity on post-resolve admission throws', () => {
  // Regression for the decrement-before-admission leak: resolveGrant must
  // not be paired with decrementBudget until AFTER per-actor concurrency
  // and host ceiling pass. If a gate throws between resolve and decrement,
  // the grant's budget_remaining must be unchanged and no grant_consumed
  // event must fire — otherwise the DB budget drains on dispatches that
  // never produced a running job, AND the DB/audit log diverge.

  it('per-actor concurrency throw after resolve leaves budget untouched and emits no grant_consumed', async () => {
    const orch = new JobOrchestrator({
      broker,
      store,
      trustStore,
      idleAfterMs: null,
      maxConcurrentPerActor: 1,
    });
    orch.register(makeMockBinding().binding);
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
      budget_remaining: 5,
    });
    // First dispatch fills the per-actor slot (actor key is 'grant:<id>' per
    // resolveActorId precedence). Budget goes 5 → 4 via decrement.
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-1',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
    expect(findEvents('grant_consumed')).toHaveLength(1);

    // Second dispatch resolves the grant successfully, then trips on the
    // per-actor concurrency cap. Pre-fix this would have decremented the
    // budget to 3 before the throw and emitted grant_consumed for a job
    // that never ran. Post-fix: decrement is deferred until after admission.
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-2',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'concurrent_jobs_per_actor_exceeded' });

    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
    expect(findEvents('grant_consumed')).toHaveLength(1);
    // The first dispatch's job_dispatched is the only one.
    expect(findEvents('job_dispatched')).toHaveLength(1);
  });

  it('host admission throw after resolve leaves budget untouched and emits no grant_consumed', async () => {
    const ceiling: HostCeiling = {
      max_host_ram_pct: 0.75,
      min_free_ram_gb: 2.0,
      max_sustained_cpu_pct: 0.85,
      max_concurrent_workers: 1,
      headroom_window_ms: 10_000,
      shed_threshold_pct: 0.95,
      shed_min_free_ram_gb: 0.5,
      enabled: true,
    };
    const orch = new JobOrchestrator({
      broker,
      store,
      trustStore,
      idleAfterMs: null,
      ceiling,
      // No headroomMonitor: only the max_concurrent_workers branch of
      // computeAdmissionRefusal fires (the RAM/CPU branches early-return
      // when no monitor is wired).
    });
    orch.register(makeMockBinding().binding);
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
      budget_remaining: 5,
    });
    // First dispatch fills the global worker slot (live.size goes to 1).
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-1',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
    expect(findEvents('grant_consumed')).toHaveLength(1);

    // Second dispatch resolves the grant, passes per-actor concurrency
    // (no cap configured), then trips host admission on max_concurrent_workers.
    // Budget MUST stay at 4; no grant_consumed for the failed dispatch.
    await expect(
      orch.dispatch({
        binding_kind: 'process-spawn',
        binding_target: 'claude-code-subprocess',
        name: 'j-2',
        params: {},
        actor_id: 'peer:alice',
        grant_id: scope.id,
      }),
    ).rejects.toMatchObject({ code: 'headroom_exceeded' });

    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
    expect(findEvents('grant_consumed')).toHaveLength(1);
    expect(findEvents('job_dispatched')).toHaveLength(1);
  });

  it('happy path decrements exactly once and emits exactly one grant_consumed', async () => {
    const orch = newOrch();
    const scope = grantNow({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
      budget_remaining: 3,
    });
    await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-happy',
      params: {},
      actor_id: 'peer:alice',
      grant_id: scope.id,
    });
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(2);
    expect(findEvents('grant_consumed')).toHaveLength(1);
    expect(findEvents('grant_denied')).toHaveLength(0);
  });
});

describe('JobOrchestrator grant gate — fail-open when trustStore is unwired', () => {
  it('orchestrator without trustStore preserves the pre-Phase-4 contract', async () => {
    // Existing callers (tests, programmatic) that don't construct with
    // trustStore continue to work; the gate is a no-op. JobRecord.grant_id
    // reflects what the caller passed in.
    const orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
    orch.register(makeMockBinding().binding);
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'claude-code-subprocess',
      name: 'j-unwired',
      params: {},
      actor_id: 'peer:alice', // peer:* would normally need grant_id
      grant_id: 'caller-supplied-id',
    });
    expect(job.grant_id).toBe('caller-supplied-id');
    expect(findEvents('grant_consumed')).toHaveLength(0);
    expect(findEvents('grant_denied')).toHaveLength(0);
  });
});
