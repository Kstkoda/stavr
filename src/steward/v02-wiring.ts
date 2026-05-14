// src/steward/v02-wiring.ts
//
// Bootstrap for the v0.2 substrate: planner + executor + connector registry +
// scope adapter. Gated behind `experimental.planner` in stavr.yaml.
//
// Loaded from src/daemon.ts on boot. When the flag is off, this module isn't
// touched.

import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';
import { InMemoryConnectorRegistry, type ConnectorRegistry } from '../connectors/index.js';
import { getLogger } from '../log.js';
import type { ProfileMode, RiskClass } from '../types/stavr-bom.js';
import { BomExecutor, type ExecutorEventSubscriber, type ExecutorScopeManager } from './executor.js';
import {
  StewardPlanner,
  type PlannerEventEmitter,
  type PlannerLlm,
  type PlannerLlmResult,
} from './planner.js';
import { TrustStore } from '../trust/store.js';

export interface V02SubsystemHandle {
  planner: StewardPlanner;
  executor: BomExecutor;
  connectors: ConnectorRegistry;
  stop(): void;
}

export interface V02WiringOpts {
  broker: Broker;
  store: EventStore;
  /** Optional LLM callback for the planner. Defaults to a stub that errors. */
  plannerLlm?: PlannerLlm;
  /** Optional concurrency override. */
  stepConcurrency?: number;
  /** Override for tests. */
  trustStore?: TrustStore;
}

/**
 * Instantiate the v0.2 subsystem. Safe to call once per daemon boot.
 * Returns a handle whose .stop() unsubscribes the executor.
 */
export function wireV02Subsystem(opts: V02WiringOpts): V02SubsystemHandle {
  const { broker, store } = opts;
  const trustStore = opts.trustStore ?? new TrustStore(store);
  const connectors = new InMemoryConnectorRegistry();

  const events: PlannerEventEmitter = {
    publish: async (kind, payload, correlationId) => {
      await broker.publish({
        kind: kind as Parameters<typeof broker.publish>[0]['kind'],
        at: new Date().toISOString(),
        source_agent: 'stavr-steward',
        correlation_id: correlationId,
        payload,
      });
    },
  };

  const subscribe: ExecutorEventSubscriber = (kind, handler) => {
    return broker.onEvent((ev) => {
      if (ev.kind !== kind) return;
      handler({ kind: ev.kind, payload: ev.payload, correlation_id: ev.correlation_id });
    });
  };

  const scopes: ExecutorScopeManager = {
    createBomScope: (bomId, riskEnvelope, stepCount) => {
      const proposal = trustStore.createProposal({
        title: `BOM ${bomId}`,
        description: `Auto-derived from BOM risk envelope: [${riskEnvelope.join(', ')}]. Steps: ${stepCount}.`,
        allowed_actions: riskEnvelopeToMatchers(riskEnvelope),
        expires_at: new Date(Date.now() + 10 * 3600_000).toISOString(),
        expires_after_actions: Math.max(4, 4 * stepCount),
        reporting: { cadence: 'every-5-actions', channels: ['event-log'] },
      });
      const granted = trustStore.grant(proposal.id, 'bom-approval');
      return granted?.id ?? proposal.id;
    },
    closeBomScope: (scopeId) => {
      const scope = trustStore.get(scopeId);
      if (!scope) return;
      if (scope.status === 'active') trustStore.markCompleted(scopeId);
    },
  };

  const llm: PlannerLlm = opts.plannerLlm ?? defaultPlannerLlm();
  const planner = new StewardPlanner(
    events,
    {
      saveBom: (bom) => store.saveBom(bom),
      saveBomVersion: (v) => store.saveBomVersion(v),
      saveBomSteps: (id, version, steps) => store.saveBomSteps(id, version, steps),
      getBom: (id) => store.getBom(id),
      getActiveVersion: (id) => store.getActiveVersion(id),
      setActiveVersion: (id, v) => store.setActiveVersion(id, v),
      updateBomStatus: (id, patch) => store.updateBomStatus(id, patch),
    },
    llm,
    () => store.getActiveProfileMode() as ProfileMode,
  );

  const executor = new BomExecutor(
    {
      events,
      subscribe,
      store: {
        getBom: (id) => store.getBom(id),
        listBoms: (filter) => store.listBoms(filter),
        getActiveVersion: (id) => store.getActiveVersion(id),
        updateBomStatus: (id, patch) => store.updateBomStatus(id, patch),
        updateBomStep: (id, version, stepNo, patch) =>
          store.updateBomStep(id, version, stepNo, patch),
        listBomSteps: (id, version) => store.listBomSteps(id, version),
      },
      connectors,
      scopes,
      planner,
      getProfileMode: () => store.getActiveProfileMode() as ProfileMode,
    },
    { stepConcurrency: opts.stepConcurrency ?? 1 },
  );

  executor.start();
  getLogger().info('v0.2 subsystem wired (planner + executor)', {
    connectors: connectors.list().length,
  });

  return {
    planner,
    executor,
    connectors,
    stop: () => executor.stop(),
  };
}

/**
 * Map a BOM's risk envelope to TrustStore ActionMatchers. v0.2 uses one
 * matcher per risk class with a `__risk_class:<rc>` tool token so the
 * existing matcher infrastructure has something to grip onto. Concrete
 * matchers come once connectors are gated through trust scopes (follow-up).
 */
function riskEnvelopeToMatchers(envelope: RiskClass[]): Array<{ tool: string; reason?: string }> {
  return envelope.map((rc) => ({
    tool: `__risk_class:${rc}`,
    reason: `Allowed by BOM-derived scope: ${rc}`,
  }));
}

function defaultPlannerLlm(): PlannerLlm {
  return async () => {
    throw new Error(
      'no planner LLM configured. Wire one via wireV02Subsystem({ plannerLlm: ... }) or set up the steward provider.',
    );
  };
}

/**
 * Shape the planner expects back. Exported for callers wiring a real LLM.
 */
export type { PlannerLlmResult };
