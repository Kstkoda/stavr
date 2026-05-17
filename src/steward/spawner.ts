// v0.5 P3 — Steward-agent subprocess spawner.
//
// Forks src/steward-agent/main.js, wraps with the existing IpcDaemonLink
// (src/steward/ipc.ts). Maintains a heartbeat: ping every 10s, marks unhealthy
// after 3 missed pongs. Does NOT auto-restart — PM2 owns lifecycle per
// ADR-032 §rule 8 and ecosystem.config.cjs.
//
// Lives ALONGSIDE wireV02Subsystem during the P5 shadow window. The cutover
// commit (Kenneth's call, separate PR) is where daemon.ts swaps the in-process
// wiring for the spawner.

import { fork, type ChildProcess } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeDaemonLink, type IpcDaemonLink } from './ipc.js';
import { getLogger } from '../log.js';
import type {
  StewardAgentRequestPlan,
  StewardAgentRequestDecide,
} from '../steward-agent/loop.js';

export type StewardAgentStatus = 'starting' | 'up' | 'unhealthy' | 'down';

export interface SpawnedStewardHandle {
  /** Process id of the forked subprocess, or null if not yet spawned / exited. */
  pid: number | null;
  status: () => StewardAgentStatus;
  lastHeartbeatAt: () => string | null;
  /** Request a planned BOM. Resolves with the steward-agent's emitted result envelope. */
  requestPlan: (req: Omit<StewardAgentRequestPlan, 'type' | 'request_id'>) => Promise<unknown>;
  /** Subscribe to all emit_event envelopes from the agent (parity shadow consumes). */
  onEvent: (handler: (kind: string, payload: unknown, correlation_id?: string) => void) => () => void;
  /** Graceful stop: shutdown envelope + SIGTERM fallback. */
  shutdown: () => Promise<void>;
}

export interface SpawnerOpts {
  /** Override for tests — absolute path to the entry script. */
  scriptPath?: string;
  /** STAVR_HOME passed to the subprocess. */
  stavrHome?: string;
  /** Optional daemon URL passed via --daemon-url (informational; subprocess uses IPC). */
  daemonUrl?: string;
  /** Override fork() for tests. */
  forker?: (script: string, args: string[]) => ChildProcess;
  /** Override the heartbeat interval (ms). Default 10000. */
  heartbeatIntervalMs?: number;
  /** Override the missed-pong threshold. Default 3. */
  missedPongThreshold?: number;
}

function resolveDefaultScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Both layouts:
  //   dist/steward/spawner.js → ../steward-agent/main.js
  //   src/steward/spawner.ts (ts-node tests) → ../../dist/steward-agent/main.js
  const candidates = [
    resolve(here, '..', 'steward-agent', 'main.js'),
    resolve(here, '..', '..', 'dist', 'steward-agent', 'main.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the first candidate; fork() will report the missing-file error.
  return candidates[0];
}

export function spawnStewardAgent(opts: SpawnerOpts = {}): SpawnedStewardHandle {
  const log = getLogger();
  const script = opts.scriptPath ?? resolveDefaultScript();
  const args: string[] = [];
  if (opts.daemonUrl) args.push('--daemon-url', opts.daemonUrl);
  if (opts.stavrHome) args.push('--stavr-home', opts.stavrHome);

  // Explicit stdio: 'pipe' on stdout/stderr + 'ipc' for the message channel.
  // Footgun #10 in the BOM — `silent: true` is unreliable on Windows.
  const forker =
    opts.forker ??
    ((s, a) =>
      fork(s, a, {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
      }));

  const child = forker(script, args);
  const link = makeDaemonLink(child);

  let status: StewardAgentStatus = 'starting';
  let lastHeartbeatAt: string | null = null;
  let missedPongs = 0;
  const heartbeatMs = opts.heartbeatIntervalMs ?? 10_000;
  const missedThreshold = opts.missedPongThreshold ?? 3;
  const eventHandlers = new Set<(kind: string, payload: unknown, correlation_id?: string) => void>();
  const pendingPlans = new Map<string, (payload: unknown) => void>();

  // Capture stdout/stderr lines into the daemon log so we don't lose subprocess
  // output to PM2 file rotation between heartbeats.
  child.stdout?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) log.info(`[steward-agent] ${line.trim()}`);
    }
  });
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) log.warn(`[steward-agent stderr] ${line.trim()}`);
    }
  });

  const offMessage = link.onMessage((msg) => {
    if (msg.type === 'pong') {
      missedPongs = 0;
      status = 'up';
      lastHeartbeatAt = new Date().toISOString();
      return;
    }
    if (msg.type === 'ready') {
      status = 'up';
      lastHeartbeatAt = new Date().toISOString();
      log.info('steward-agent ready', { pid: child.pid ?? null });
      return;
    }
    if (msg.type === 'emit_event') {
      const env = msg as { type: 'emit_event'; kind: string; payload: unknown; correlation_id?: string };
      const payload = env.payload as { request_id?: string } | undefined;
      if (payload?.request_id && pendingPlans.has(payload.request_id)) {
        const resolver = pendingPlans.get(payload.request_id)!;
        pendingPlans.delete(payload.request_id);
        resolver(env.payload);
      }
      for (const h of eventHandlers) {
        try { h(env.kind, env.payload, env.correlation_id); } catch { /* ignore */ }
      }
      return;
    }
    if (msg.type === 'log') {
      const lev = (msg as { level: 'info' | 'warn' | 'error' }).level;
      log[lev]?.(`[steward-agent] ${(msg as { message: string }).message}`);
    }
  });

  const offClose = link.onClose(() => {
    status = 'down';
    for (const r of pendingPlans.values()) r({ error: 'agent exited before reply' });
    pendingPlans.clear();
  });

  const heartbeatTimer = setInterval(() => {
    if (status === 'down') return;
    const sent = link.send({ type: 'ping' });
    if (!sent) {
      missedPongs++;
    } else {
      // We sent — pong not yet received; only count missed when threshold of
      // intervals elapse without one. The check runs on the NEXT tick.
    }
    // If the most recent heartbeat is stale by N * interval, mark unhealthy.
    if (lastHeartbeatAt) {
      const stale = Date.now() - new Date(lastHeartbeatAt).getTime();
      if (stale > missedThreshold * heartbeatMs) {
        status = 'unhealthy';
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    get pid() { return child.pid ?? null; },
    status: () => status,
    lastHeartbeatAt: () => lastHeartbeatAt,
    requestPlan(req): Promise<unknown> {
      const requestId = randomUUID();
      return new Promise((resolveFn, rejectFn) => {
        const timeout = setTimeout(() => {
          if (pendingPlans.delete(requestId)) {
            rejectFn(new Error('steward-agent plan request timed out'));
          }
        }, 60_000);
        pendingPlans.set(requestId, (payload) => {
          clearTimeout(timeout);
          resolveFn(payload);
        });
        const envelope = {
          type: 'event' as const,
          kind: 'steward_agent_request',
          payload: {
            type: 'request_plan' as const,
            request_id: requestId,
            ctx: req.ctx,
            tools: req.tools,
            shadow: req.shadow,
          } satisfies StewardAgentRequestPlan,
        };
        const sent = link.send(envelope);
        if (!sent) {
          pendingPlans.delete(requestId);
          clearTimeout(timeout);
          rejectFn(new Error('steward-agent IPC link closed'));
        }
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    async shutdown() {
      clearInterval(heartbeatTimer);
      offMessage();
      offClose();
      try {
        await link.shutdown();
      } catch {
        /* link may already be gone */
      }
      status = 'down';
    },
  };
}

// Re-export the decide request type for callers that build envelopes directly.
export type { StewardAgentRequestPlan, StewardAgentRequestDecide };
