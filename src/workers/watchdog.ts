import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';

export interface WorkerWatchdogOptions {
  intervalMs?: number;
  stuckThresholdSec?: number;
  reEmitIntervalMs?: number;
}

export interface WorkerWatchdogHandle {
  stop(): void;
}

interface EmitRecord {
  last_activity_at: string;
  emitted_at: number;
}

export function start(
  broker: Broker,
  store: EventStore,
  opts: WorkerWatchdogOptions = {},
): WorkerWatchdogHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const stuckThresholdSec = opts.stuckThresholdSec ?? 300;
  const reEmitIntervalMs = opts.reEmitIntervalMs ?? 15 * 60_000;

  // Per-worker idempotency map: worker_id → last emit record
  const emitted = new Map<string, EmitRecord>();

  const tick = async (): Promise<void> => {
    const now = Date.now();
    const workers = store.listWorkersForWatchdog();
    const liveIds = new Set(workers.map((w) => w.id));

    // Evict records for workers that are no longer active
    for (const id of emitted.keys()) {
      if (!liveIds.has(id)) emitted.delete(id);
    }

    for (const w of workers) {
      const lastActivity = w.last_activity_at ?? w.started_at;
      const idleSec = Math.floor((now - new Date(lastActivity).getTime()) / 1000);

      // Per-worker threshold override via metadata
      const fullRecord = store.getWorker(w.id);
      const thresholdSec =
        typeof fullRecord?.metadata?.stuck_threshold_sec === 'number' &&
        fullRecord.metadata.stuck_threshold_sec > 0
          ? (fullRecord.metadata.stuck_threshold_sec as number)
          : stuckThresholdSec;

      if (idleSec <= thresholdSec) continue;

      // Idempotency: same last_activity_at + within re-emit window → skip
      const prev = emitted.get(w.id);
      if (prev) {
        if (prev.last_activity_at === lastActivity && now - prev.emitted_at < reEmitIntervalMs) {
          continue;
        }
        // last_activity_at advanced: reset record and allow re-emit immediately
      }

      emitted.set(w.id, { last_activity_at: lastActivity, emitted_at: now });

      const idleMin = Math.floor(idleSec / 60);
      const hint =
        idleSec > 3600
          ? `Worker has been idle for ${idleMin} minutes — may be waiting for input or hung`
          : `Worker has been idle for ${idleSec}s — consider checking process status`;

      await broker.publish({
        kind: 'worker_stuck',
        at: new Date().toISOString(),
        source_agent: 'stavr-watchdog',
        payload: {
          worker_id: w.id,
          worker_name: w.name,
          worker_type: w.type,
          pid: w.pid ?? undefined,
          started_at: w.started_at,
          last_activity_at: lastActivity,
          idle_seconds: idleSec,
          hint,
        },
      });
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
