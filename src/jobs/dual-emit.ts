/**
 * Dual-emit translator for the worker-dispatch Phase 3a deprecation window.
 *
 * Bilateral pattern: every job_* broker event the JobOrchestrator publishes
 * (and every job_stuck the watchdog publishes) gets a parallel legacy
 * worker_* emission with the payload translated to the legacy schema. The
 * window length is `DEPRECATION_WINDOW_RELEASES` (event-types.ts) — one
 * minor release. Past that, this whole file is deleted and the legacy
 * worker_* event kinds along with it.
 *
 * Why not just rename in place: the broker is a public surface. The
 * dashboard, the federation receiver, and any operator-side `stavr tail`
 * tuned to `--kind worker_*` would break the moment we flip the emitter.
 * Dual-emit gives one minor-release window for those subscribers to
 * follow the rename.
 *
 * Translation rules:
 *
 *   job_dispatched          → (no legacy parallel — pre-running)
 *   job_started             → worker_spawned
 *   job_progress            → worker_progress       (drops `payload`)
 *   job_metadata_changed    → worker_metadata_changed
 *   job_heartbeat           → worker_activity
 *   job_log                 → worker_log            (renames job_id → worker_id)
 *   job_error               → worker_error
 *   job_terminated          → worker_terminated     (legacy enum drops the
 *                                                    new reasons — see below)
 *   job_stuck               → worker_stuck
 *
 * `job_terminated.reason` carries two reasons the legacy `worker_terminated`
 * enum doesn't know about: `budget_exceeded` and `shed_by_host`. Both map
 * to `terminated_by_user` in the legacy schema — closest semantic match
 * (the operator's policy fired, not a graceful completion or crash). The
 * full reason is still visible on the job_terminated event for new
 * consumers.
 *
 * `worker_spawned` requires a `type` string and a `cwd` string. We
 * synthesise `type = ${binding_kind}:${binding_target}` (matches the
 * binding registry key format) and `cwd = metadata.cwd ?? ''`.
 */
import type { Broker } from '../broker.js';
import type { EventKindT } from '../event-types.js';

interface PublishArgs {
  kind: EventKindT;
  payload: unknown;
  correlationId?: string;
  sourceAgent: string;
}

/**
 * Publish the legacy worker_* event paired with a freshly-published
 * job_* event, if a translation exists. Fire-and-forget — the caller
 * already published the primary event.
 */
export async function dualEmitLegacy(broker: Broker, args: PublishArgs): Promise<void> {
  const translated = translateToLegacy(args);
  if (!translated) return;
  await broker.publish({
    kind: translated.kind,
    at: new Date().toISOString(),
    correlation_id: args.correlationId,
    source_agent: args.sourceAgent,
    payload: translated.payload,
  });
}

interface TranslatedEvent {
  kind: EventKindT;
  payload: Record<string, unknown>;
}

function translateToLegacy(args: PublishArgs): TranslatedEvent | undefined {
  const p = args.payload as Record<string, unknown> | undefined;
  if (!p) return undefined;
  switch (args.kind) {
    case 'job_started': {
      const md = (p.metadata as Record<string, unknown> | undefined) ?? {};
      const legacy: Record<string, unknown> = {
        id: p.id,
        name: p.name,
        type: `${p.binding_kind}:${p.binding_target}`,
        cwd: typeof md.cwd === 'string' ? md.cwd : '',
        metadata: md,
      };
      if (typeof p.pid === 'number') legacy.pid = p.pid;
      return { kind: 'worker_spawned', payload: legacy };
    }
    case 'job_progress': {
      // WorkerProgressPayload has {id, message, detail?} — no `payload` slot.
      // Drop p.payload; new consumers read it off job_progress directly.
      const legacy: Record<string, unknown> = { id: p.id, message: p.message };
      return { kind: 'worker_progress', payload: legacy };
    }
    case 'job_metadata_changed':
      return { kind: 'worker_metadata_changed', payload: { id: p.id, patch: p.patch } };
    case 'job_heartbeat': {
      const legacy: Record<string, unknown> = { id: p.id };
      if (p.detail !== undefined) legacy.detail = p.detail;
      return { kind: 'worker_activity', payload: legacy };
    }
    case 'job_log': {
      const legacy: Record<string, unknown> = {
        worker_id: p.job_id,
        worker_name: p.job_name,
        stream: p.stream,
      };
      if (p.format !== undefined) legacy.format = p.format;
      if (p.event !== undefined) legacy.event = p.event;
      if (p.line !== undefined) legacy.line = p.line;
      if (p.truncated !== undefined) legacy.truncated = p.truncated;
      return { kind: 'worker_log', payload: legacy };
    }
    case 'job_error':
      return {
        kind: 'worker_error',
        payload: { id: p.id, message: p.message, recoverable: p.recoverable },
      };
    case 'job_terminated': {
      const reason = mapTerminationReason(p.reason as string | undefined);
      const legacy: Record<string, unknown> = { id: p.id, reason };
      if (typeof p.exit_code === 'number') legacy.exit_code = p.exit_code;
      return { kind: 'worker_terminated', payload: legacy };
    }
    case 'job_stuck': {
      const legacy: Record<string, unknown> = {
        worker_id: p.job_id,
        worker_name: p.job_name,
        // legacy `worker_type` slot — fold kind + target.
        worker_type: `${p.binding_kind}:${p.binding_target}`,
        started_at: p.started_at,
        last_activity_at: p.last_activity_at,
        idle_seconds: p.idle_seconds,
        hint: p.hint,
      };
      if (typeof p.pid === 'number') legacy.pid = p.pid;
      return { kind: 'worker_stuck', payload: legacy };
    }
    default:
      return undefined;
  }
}

// LOSSY: `budget_exceeded` and `shed_by_host` both fold to `terminated_by_user`
// in the legacy enum. Audit consumers that need to distinguish these MUST
// read `job_terminated` directly — the `worker_terminated` shadow drops the
// distinction.
function mapTerminationReason(reason: string | undefined): 'completed' | 'crashed' | 'terminated_by_user' {
  if (reason === 'completed') return 'completed';
  if (reason === 'crashed') return 'crashed';
  return 'terminated_by_user';
}
