import { EventEmitter } from 'node:events';
import type { Broker } from '../broker.js';
import type { StoredEvent } from '../persistence.js';
import type { TrustStore } from './store.js';
import type { TrustScope } from './types.js';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * In-process emitter the broker pushes every published event into. We attach
 * this once per broker (see attachReporterToBroker) and the reporter subscribes
 * to it. Keeping it out of the Broker class itself avoids touching the existing
 * fanout path.
 */
const reporterEmitters = new WeakMap<Broker, EventEmitter>();

export function getReporterEmitter(broker: Broker): EventEmitter {
  let em = reporterEmitters.get(broker);
  if (!em) {
    em = new EventEmitter();
    em.setMaxListeners(0);
    reporterEmitters.set(broker, em);
  }
  return em;
}

/**
 * Patch the broker's `publish` to also feed our in-process emitter. Idempotent.
 */
export function ensureBrokerReporterTap(broker: Broker): void {
  const tagged = broker as Broker & { __trustReporterTapped?: true };
  if (tagged.__trustReporterTapped) return;
  const emitter = getReporterEmitter(broker);
  const originalPublish = broker.publish.bind(broker);
  broker.publish = async (event) => {
    const stored = await originalPublish(event);
    try {
      emitter.emit('event', stored);
    } catch {
      // never let reporter side-effects break publish
    }
    return stored;
  };
  tagged.__trustReporterTapped = true;
}

interface ReporterState {
  // Per-scope tracking
  granted: Map<string, GrantedScopeState>;
}

interface GrantedScopeState {
  scope: TrustScope;
  actionsSinceLastReport: number;
  timer?: NodeJS.Timeout;
  finalized?: boolean;
}

const reporterStates = new WeakMap<Broker, ReporterState>();

export interface TrustReporterOptions {
  /** Override the 15-min interval for testing (ms). */
  timeIntervalMs?: number;
  /** Test hook — replaces setTimeout. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Test hook — replaces clearTimeout. */
  clearTimer?: (h: NodeJS.Timeout) => void;
}

/**
 * Initialise the reporter for a broker. Idempotent per broker.
 */
export function initTrustReporter(
  broker: Broker,
  store: TrustStore,
  opts: TrustReporterOptions = {},
): void {
  if (reporterStates.has(broker)) return;
  ensureBrokerReporterTap(broker);

  const state: ReporterState = { granted: new Map() };
  reporterStates.set(broker, state);

  const interval = opts.timeIntervalMs ?? FIFTEEN_MINUTES_MS;
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  const emitter = getReporterEmitter(broker);

  emitter.on('event', (ev: StoredEvent) => {
    void handleEvent(broker, store, state, ev, { interval, setTimer, clearTimer });
  });
}

async function handleEvent(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  ev: StoredEvent,
  timer: {
    interval: number;
    setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimer: (h: NodeJS.Timeout) => void;
  },
): Promise<void> {
  if (ev.kind === 'trust_scope_granted') {
    const payload = ev.payload as { scope_id: string };
    const scope = store.get(payload.scope_id);
    if (!scope) return;
    onGranted(broker, store, state, scope, timer);
    return;
  }
  if (ev.kind === 'trust_scope_action_authorized') {
    const payload = ev.payload as { scope_id: string };
    await onAuthorized(broker, store, state, payload.scope_id);
    return;
  }
  if (ev.kind === 'trust_scope_revoked') {
    const payload = ev.payload as { scope_id: string };
    await onTerminal(broker, store, state, payload.scope_id, 'revoked');
    return;
  }
}

function onGranted(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  scope: TrustScope,
  timer: {
    interval: number;
    setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimer: (h: NodeJS.Timeout) => void;
  },
): void {
  if (state.granted.has(scope.id)) return;
  const s: GrantedScopeState = { scope, actionsSinceLastReport: 0 };
  state.granted.set(scope.id, s);

  if (scope.reporting.cadence === 'every-15-min') {
    armTimeTimer(broker, store, state, scope.id, timer);
  }
}

function armTimeTimer(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  scopeId: string,
  timer: {
    interval: number;
    setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimer: (h: NodeJS.Timeout) => void;
  },
): void {
  const entry = state.granted.get(scopeId);
  if (!entry) return;
  if (entry.timer) timer.clearTimer(entry.timer);
  entry.timer = timer.setTimer(() => {
    void onTimeTick(broker, store, state, scopeId, timer);
  }, timer.interval);
}

async function onTimeTick(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  scopeId: string,
  timer: {
    interval: number;
    setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimer: (h: NodeJS.Timeout) => void;
  },
): Promise<void> {
  const entry = state.granted.get(scopeId);
  if (!entry || entry.finalized) return;
  const scope = store.get(scopeId);
  if (!scope) return;
  if (scope.status !== 'active') {
    await onTerminal(broker, store, state, scopeId, scope.status === 'completed' ? 'action_cap_reached' : scope.status === 'expired' ? 'expired' : 'revoked');
    return;
  }
  await emitProgress(broker, scope, 'every-15-min');
  entry.actionsSinceLastReport = 0;
  armTimeTimer(broker, store, state, scopeId, timer);
}

async function onAuthorized(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  scopeId: string,
): Promise<void> {
  const entry = state.granted.get(scopeId);
  const scope = store.get(scopeId);
  if (!scope) return;
  if (!entry) {
    // Granted before the reporter saw it (e.g. restart). Register lazily.
    state.granted.set(scopeId, { scope, actionsSinceLastReport: 0 });
  }
  const live = state.granted.get(scopeId)!;
  live.actionsSinceLastReport += 1;

  const cadence = scope.reporting.cadence;

  if (cadence === 'every-action') {
    await emitProgress(broker, scope, cadence);
    live.actionsSinceLastReport = 0;
  } else if (cadence === 'every-5-actions') {
    if (live.actionsSinceLastReport >= 5) {
      await emitProgress(broker, scope, cadence);
      live.actionsSinceLastReport = 0;
    }
  }

  // After the action, the store may have transitioned scope.status from 'active'
  // to 'completed' when the cap was hit. Emit a final summary in that case.
  if (scope.status === 'completed') {
    await onTerminal(broker, store, state, scopeId, 'action_cap_reached');
  }
}

async function onTerminal(
  broker: Broker,
  store: TrustStore,
  state: ReporterState,
  scopeId: string,
  reason: 'action_cap_reached' | 'expired' | 'revoked',
): Promise<void> {
  const entry = state.granted.get(scopeId);
  if (entry?.finalized) return;
  const scope = store.get(scopeId);
  if (!scope) return;
  if (entry?.timer) clearTimeoutSafe(entry.timer);
  if (entry) entry.finalized = true;

  await broker.publish({
    kind: 'trust_scope_completed',
    at: new Date().toISOString(),
    source_agent: 'switch-trust-reporter',
    payload: {
      scope_id: scope.id,
      reason,
      actions_executed: scope.actions_executed,
      completed_at: scope.completed_at ?? new Date().toISOString(),
    },
  });
}

async function emitProgress(broker: Broker, scope: TrustScope, cadence: TrustScope['reporting']['cadence']): Promise<void> {
  await broker.publish({
    kind: 'trust_scope_progress',
    at: new Date().toISOString(),
    source_agent: 'switch-trust-reporter',
    payload: {
      scope_id: scope.id,
      actions_executed: scope.actions_executed,
      expires_after_actions: scope.expires_after_actions,
      expires_at: scope.expires_at,
      cadence,
      message:
        scope.expires_after_actions !== undefined
          ? `${scope.actions_executed}/${scope.expires_after_actions} actions executed`
          : `${scope.actions_executed} actions executed`,
    },
  });
}

function clearTimeoutSafe(h: NodeJS.Timeout): void {
  try {
    clearTimeout(h);
  } catch {
    // ignore
  }
}

/**
 * Test hook — drop reporter state for a broker. Tests reuse brokers
 * across cases and want fresh state.
 */
export function __resetTrustReporter(broker: Broker): void {
  const st = reporterStates.get(broker);
  if (st) {
    for (const v of st.granted.values()) {
      if (v.timer) clearTimeoutSafe(v.timer);
    }
  }
  reporterStates.delete(broker);
}
