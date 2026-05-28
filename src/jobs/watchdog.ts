/**
 * Job watchdog (Phase 3a of worker-dispatch BOM).
 *
 * Parallel to src/workers/watchdog.ts. Reads listJobsForWatchdog() from
 * the persistence layer and emits `job_stuck` for any job whose
 * `last_activity_at` is older than the configured threshold. The
 * legacy `worker_stuck` parallel is emitted via src/jobs/dual-emit.ts
 * so dashboards / federation subscribers tuned to the old kind keep
 * working through the deprecation window.
 *
 * Behaviour preserves the worker watchdog's idempotency model:
 *  - Per-job emit record keyed on job id.
 *  - Same `last_activity_at` + within `reEmitIntervalMs` → skip.
 *  - `last_activity_at` advanced → reset the record, re-emit immediately.
 *  - Per-job override via `metadata.stuck_threshold_sec` (positive number).
 *
 * Wiring: daemon.ts starts this alongside the worker watchdog during 3a.
 * In 3c, when the bespoke worker subsystem is deleted, the worker
 * watchdog goes with it and this becomes the sole stuck-detector.
 */
import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';
import { dualEmitLegacy } from './dual-emit.js';

export interface JobWatchdogOptions {
  intervalMs?: number;
  stuckThresholdSec?: number;
  reEmitIntervalMs?: number;
}

export interface JobWatchdogHandle {
  stop(): void;
}

interface EmitRecord {
  last_activity_at: string;
  emitted_at: number;
}

const SOURCE_AGENT = 'stavr-job-watchdog';

export function start(
  broker: Broker,
  store: EventStore,
  opts: JobWatchdogOptions = {},
): JobWatchdogHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const stuckThresholdSec = opts.stuckThresholdSec ?? 300;
  const reEmitIntervalMs = opts.reEmitIntervalMs ?? 15 * 60_000;

  const emitted = new Map<string, EmitRecord>();

  const tick = async (): Promise<void> => {
    const now = Date.now();
    const jobs = store.listJobsForWatchdog();
    const liveIds = new Set(jobs.map((j) => j.id));

    for (const id of emitted.keys()) {
      if (!liveIds.has(id)) emitted.delete(id);
    }

    for (const j of jobs) {
      const lastActivity = j.last_activity_at ?? j.started_at;
      const idleSec = Math.floor((now - new Date(lastActivity).getTime()) / 1000);

      // Per-job threshold override via metadata.stuck_threshold_sec.
      const full = store.getJob(j.id);
      const threshold =
        typeof full?.metadata?.stuck_threshold_sec === 'number' &&
        (full.metadata.stuck_threshold_sec as number) > 0
          ? (full.metadata.stuck_threshold_sec as number)
          : stuckThresholdSec;

      if (idleSec <= threshold) continue;

      const prev = emitted.get(j.id);
      if (prev) {
        if (prev.last_activity_at === lastActivity && now - prev.emitted_at < reEmitIntervalMs) {
          continue;
        }
      }

      emitted.set(j.id, { last_activity_at: lastActivity, emitted_at: now });

      const idleMin = Math.floor(idleSec / 60);
      const hint =
        idleSec > 3600
          ? `Job has been idle for ${idleMin} minutes — may be waiting for input or hung`
          : `Job has been idle for ${idleSec}s — consider checking process status`;

      const pid =
        typeof full?.metadata?.pid === 'number' ? (full.metadata.pid as number) : undefined;

      const payload: Record<string, unknown> = {
        job_id: j.id,
        job_name: j.name,
        binding_kind: j.binding_kind,
        binding_target: j.binding_target,
        started_at: j.started_at,
        last_activity_at: lastActivity,
        idle_seconds: idleSec,
        hint,
      };
      if (pid !== undefined) payload.pid = pid;

      await broker.publish({
        kind: 'job_stuck',
        at: new Date().toISOString(),
        source_agent: SOURCE_AGENT,
        payload,
      });
      // Dual-emit: legacy worker_stuck parallel for subscribers tuned to
      // the old kind. Translation in src/jobs/dual-emit.ts.
      await dualEmitLegacy(broker, {
        kind: 'job_stuck',
        payload,
        sourceAgent: SOURCE_AGENT,
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
