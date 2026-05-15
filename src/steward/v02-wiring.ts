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
import { createBrickInstaller, defaultBricksRoot, type BrickInstaller } from '../bricks/installer.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface V02SubsystemHandle {
  planner: StewardPlanner;
  executor: BomExecutor;
  connectors: ConnectorRegistry;
  bricks: BrickInstaller;
  stop(): void;
}

const handlesByBroker = new WeakMap<Broker, V02SubsystemHandle>();

/**
 * Retrieve the v0.2 subsystem handle for a broker, or undefined if the
 * flag is off / wiring hasn't been called. Used by createSwitchServer
 * to register the `propose_plan` tool only when planner is on.
 */
export function getV02Subsystem(broker: Broker): V02SubsystemHandle | undefined {
  return handlesByBroker.get(broker);
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
  /** Override the directory where installed bricks live. Defaults to ~/.stavr/bricks. */
  bricksRoot?: string;
  /**
   * Skip rehydrating installed bricks at startup. Tests use this to avoid
   * spawning module loads against ephemeral file systems.
   */
  skipBrickRehydrate?: boolean;
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
      if (granted) {
        // Mirror the trust_scope_granted event emitted by the MCP-tool path
        // (src/trust/tools.ts). Audit log must record BOM-derived scopes the
        // same way it records user-initiated ones. Fire-and-forget so the
        // sync createBomScope contract is preserved; correlate by bomId.
        void events
          .publish(
            'trust_scope_granted',
            {
              scope_id: granted.id,
              title: granted.title,
              granted_by: granted.granted_by,
              granted_at: granted.granted_at,
              expires_at: granted.expires_at,
              expires_after_actions: granted.expires_after_actions,
            },
            bomId,
          )
          .catch((err) => {
            getLogger().warn('failed to emit trust_scope_granted for BOM scope', {
              bom_id: bomId,
              scope_id: granted.id,
              error: (err as Error).message,
            });
          });
      }
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

  // Brick installer + re-hydration of previously installed local bricks.
  const stavrHome = process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr');
  const bricksRoot = opts.bricksRoot ?? defaultBricksRoot(stavrHome);
  const bricks = createBrickInstaller({ store, registry: connectors, bricksRoot });
  if (!opts.skipBrickRehydrate) {
    void bricks
      .rehydrate()
      .then(({ loaded, failed }) => {
        if (loaded > 0 || failed.length > 0) {
          getLogger().info('brick rehydration complete', { loaded, failed: failed.length });
        }
        for (const f of failed) {
          getLogger().warn('brick rehydrate failed', { id: f.id, error: f.error });
        }
      })
      .catch((err) => {
        getLogger().error('brick rehydration crashed', { error: (err as Error).message });
      });
  }

  executor.start();
  getLogger().info('v0.2 subsystem wired (planner + executor)', {
    connectors: connectors.list().length,
  });

  const handle: V02SubsystemHandle = {
    planner,
    executor,
    connectors,
    bricks,
    stop: () => {
      executor.stop();
      handlesByBroker.delete(broker);
    },
  };
  handlesByBroker.set(broker, handle);
  return handle;
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
