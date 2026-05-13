import type { ChildProcess } from 'node:child_process';

/**
 * Spec 49 Layer 1 — in-process IPC channel between daemon and Steward subprocess.
 *
 * The Steward subprocess is spawned with `child_process.fork(...)`, which gives
 * us a built-in JSON-message IPC channel via `process.send` / `'message'` events.
 * Cross-platform out of the box; no UDS / named-pipe framing required.
 *
 * Wire format: every message is a JSON envelope with a `type` discriminator.
 * The daemon side speaks `IpcDaemonMessage`; the steward side speaks
 * `IpcStewardMessage`. Both sides also accept a generic `Pong` so a watchdog
 * heartbeat can prove the link is alive.
 */

export type IpcStewardMessage =
  | { type: 'tool_invoke'; id: string; tool: string; args: Record<string, unknown> }
  | { type: 'emit_event'; kind: string; payload: unknown; correlation_id?: string }
  | { type: 'await_decision_subscribe'; correlation_id: string }
  | { type: 'pong' }
  | { type: 'ready' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type IpcDaemonMessage =
  | { type: 'tool_invoke_result'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'event'; kind: string; payload: unknown; correlation_id?: string }
  | { type: 'decision_response'; correlation_id: string; chosen_option_id: string; responder: string }
  | { type: 'ping' }
  | { type: 'shutdown' };

export interface IpcDaemonLink {
  send: (msg: IpcDaemonMessage) => boolean;
  onMessage: (handler: (msg: IpcStewardMessage) => void) => () => void;
  onClose: (handler: () => void) => () => void;
  shutdown: () => Promise<void>;
}

/**
 * Wrap a forked child as a daemon-side IPC link. Returns send / onMessage /
 * onClose / shutdown. Caller must own the ChildProcess lifecycle.
 */
export function makeDaemonLink(child: ChildProcess): IpcDaemonLink {
  const handlers = new Set<(m: IpcStewardMessage) => void>();
  const closeHandlers = new Set<() => void>();

  child.on('message', (m: unknown) => {
    if (m && typeof m === 'object' && 'type' in (m as Record<string, unknown>)) {
      for (const h of handlers) {
        try {
          h(m as IpcStewardMessage);
        } catch {
          /* ignore handler errors */
        }
      }
    }
  });
  child.on('exit', () => {
    for (const h of closeHandlers) h();
  });

  return {
    send(msg) {
      if (!child.connected) return false;
      return child.send(msg) ?? false;
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    async shutdown() {
      if (!child.connected) return;
      try {
        child.send({ type: 'shutdown' } satisfies IpcDaemonMessage);
      } catch {
        /* connection might be half-gone */
      }
      // Give the subprocess up to 2 seconds to flush + exit; SIGTERM otherwise.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export interface IpcStewardLink {
  send: (msg: IpcStewardMessage) => boolean;
  onMessage: (handler: (msg: IpcDaemonMessage) => void) => () => void;
  onShutdown: (handler: () => void) => () => void;
}

/**
 * Wrap the subprocess side. Call from within the Steward loop; binds to
 * `process.send` / `process.on('message')`. If the process wasn't forked
 * (no IPC channel attached), every send returns false and onMessage is a
 * no-op — the loop can detect that and exit cleanly.
 */
export function makeStewardLink(): IpcStewardLink {
  const handlers = new Set<(m: IpcDaemonMessage) => void>();
  const shutdownHandlers = new Set<() => void>();

  process.on('message', (m: unknown) => {
    if (!m || typeof m !== 'object' || !('type' in (m as Record<string, unknown>))) return;
    const msg = m as IpcDaemonMessage;
    if (msg.type === 'shutdown') {
      for (const h of shutdownHandlers) h();
      return;
    }
    for (const h of handlers) {
      try {
        h(msg);
      } catch {
        /* ignore */
      }
    }
  });

  return {
    send(msg) {
      if (typeof process.send !== 'function') return false;
      return process.send(msg);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onShutdown(handler) {
      shutdownHandlers.add(handler);
      return () => shutdownHandlers.delete(handler);
    },
  };
}

export function ipcAvailable(): boolean {
  return typeof process.send === 'function';
}
