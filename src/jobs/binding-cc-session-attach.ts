/**
 * cc-session-attach binding — Phase 2 of worker-dispatch-bom.md.
 *
 * Attaches to an already-running Claude Code session. The session is NOT
 * spawned by stavR (that's the process-spawn binding's role); the binding
 * just opens a side channel to a running session, observes its events,
 * forwards mid-flight messages, and detaches on terminate.
 *
 * Why this is the preferred CC binding (per the BOM):
 *   "spawn made stavR own the CC lifecycle, the crash surface that took
 *    down the operator's PC (2026-05-20)."
 *   Attach decouples lifecycle. The CC session crashing does NOT crash
 *   stavR; stavR detaching does NOT kill the CC session.
 *
 * Capability declaration:
 *   inject = true. Mid-flight injection is the model use case for an
 *   attached session — that's what the operator attaches FOR.
 *
 * Generic substrate / specific implementation:
 *   Phase 2 ships the contract — the `CcSessionAdapter` interface. The
 *   actual IPC (Unix domain socket / TCP / file-based bridge / etc.) is
 *   downstream — the operator supplies an adapter that knows how to talk
 *   to their CC sessions. Tests use a fake adapter. The follow-up
 *   claude-execute-mcp-tool BOM registers a specific target with a real
 *   adapter implementation.
 *
 * Lifecycle nuance: terminate() detaches but does NOT kill the session.
 * exit(reason='terminated') fires when we detach. exit(reason='completed')
 * fires when the adapter signals the session itself ended.
 */
import { z } from 'zod';
import { JobEventBus } from './event-bus.js';
import type {
  BindingCapabilities,
  BindingContext,
  BindingHandle,
  ExecutorBinding,
} from './types.js';

export const CcSessionAttachParams = z.object({
  /** Identifier of the running CC session to attach to. Format is adapter-
   *  specific — could be a PID, a socket path, an opaque token. */
  session_id: z.string().min(1),
  /** Optional first message to send to the session right after attach
   *  succeeds. The CC session's response surfaces through the normal
   *  log / progress channel. */
  initial_message: z.string().optional(),
});

export type CcSessionAttachParamsT = z.infer<typeof CcSessionAttachParams>;

/**
 * Event the adapter delivers to the binding for each unit of session
 * output. `kind` discriminates: 'log' is a raw line (stdout/stderr style);
 * 'progress' is a structured status update; 'metadata' is a key/value
 * patch (e.g. `{ tokens_used: 1234 }`); 'closed' is the session signaling
 * its own exit.
 */
export type CcSessionEvent =
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'progress'; message: string; payload?: unknown }
  | { kind: 'metadata'; patch: Record<string, unknown> }
  | { kind: 'closed'; exit_code?: number; reason: 'completed' | 'crashed' };

/** A handle the adapter returns from connect(). */
export interface AttachedSession {
  /** Echo of the session_id, in case the adapter normalized it. */
  id: string;
  /** Send a mid-flight message into the session. Throws if the session
   *  is no longer alive. */
  send(message: { id: string; body: unknown }): Promise<void>;
  /** Register a callback for session events. Returns an unsubscribe fn. */
  onEvent(cb: (ev: CcSessionEvent) => void): () => void;
  /** Detach from the session. The session itself keeps running. */
  detach(): Promise<void>;
  /** Optional adapter-pinned metadata to surface on the JobRecord. */
  metadata?: Record<string, unknown>;
}

export interface CcSessionAdapter {
  /** Open a side channel to the running CC session identified by
   *  session_id. Throws if the session can't be reached. */
  connect(session_id: string): Promise<AttachedSession>;
}

export interface CcSessionAttachBindingOptions {
  target: string;
  displayName: string;
  description: string;
  adapter: CcSessionAdapter;
}

const CAPABILITIES: BindingCapabilities = { inject: true };

export function createCcSessionAttachBinding(
  opts: CcSessionAttachBindingOptions,
): ExecutorBinding<CcSessionAttachParamsT> {
  return {
    kind: 'cc-session-attach',
    target: opts.target,
    displayName: opts.displayName,
    description: opts.description,
    capabilities: CAPABILITIES,
    paramsSchema: CcSessionAttachParams,

    async dispatch(params, _ctx: BindingContext): Promise<BindingHandle> {
      const bus = new JobEventBus();
      let attached: AttachedSession;
      try {
        attached = await opts.adapter.connect(params.session_id);
      } catch (err) {
        // Connection failure surfaces as a binding-dispatch failure — the
        // orchestrator catches and marks the job crashed without ever
        // entering 'running'.
        throw new Error(
          `cc-session-attach:${opts.target} failed to connect to session ${params.session_id}: ${(err as Error).message}`,
        );
      }

      let exited = false;
      let detached = false;

      // Subscribe to session events; fan into the binding's event bus.
      const offEvents = attached.onEvent((ev) => {
        if (exited) return;
        switch (ev.kind) {
          case 'log':
            bus.emitLog({ stream: ev.stream, line: ev.line, format: 'raw' });
            break;
          case 'progress':
            bus.emitProgress({
              message: ev.message,
              ...(ev.payload !== undefined ? { payload: ev.payload } : {}),
            });
            break;
          case 'metadata':
            bus.emitMetadata({ patch: ev.patch });
            break;
          case 'closed':
            // Session ended on its own. We emit exit (completed | crashed)
            // and unsubscribe so adapter events post-close are ignored.
            exited = true;
            offEvents();
            bus.emitExit({ reason: ev.reason, exitCode: ev.exit_code });
            break;
        }
      });

      // Optional first message — fire-and-forget. If send() throws we
      // surface a recoverable error but don't tear the binding down.
      if (params.initial_message !== undefined) {
        // Use a stable-ish id; the orchestrator's inject() generates real
        // UUIDs for its own messages. The initial message uses a
        // deterministic id so the operator can correlate it.
        attached
          .send({ id: 'initial', body: params.initial_message })
          .catch((err) => {
            bus.emitError({ message: (err as Error).message, recoverable: true });
          });
      }

      const handle: BindingHandle = {
        pid: undefined,
        metadata: {
          session_id: attached.id,
          attached_at: new Date().toISOString(),
          ...(attached.metadata ?? {}),
        },
        events: bus,
        async terminate(_force: boolean) {
          if (detached) return {};
          detached = true;
          offEvents();
          try {
            await attached.detach();
          } catch {
            /* detach failed — session may already be gone */
          }
          if (!exited) {
            exited = true;
            // Detach is operator-initiated; reason='terminated' maps to
            // killed-by-operator on the orchestrator side.
            bus.emitExit({ reason: 'terminated' });
          }
          return {};
        },
        async inject(message): Promise<void> {
          if (exited || detached) {
            throw new Error(
              `cc-session-attach:${opts.target} session ${attached.id} is no longer attached`,
            );
          }
          await attached.send(message);
        },
      };
      return handle;
    },
  };
}
