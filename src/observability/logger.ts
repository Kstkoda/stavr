// src/observability/logger.ts
//
// Pino-backed structured JSON logger + AsyncLocalStorage for correlation_id
// propagation. Spec: bom-diagnostics-2026.md C1.5.
//
// Two interfaces are exported:
//   - `pinoLogger`: the raw pino instance, for code that wants `.info({...}, 'msg')`
//     shape directly.
//   - `logContext` / `runWithCorrelation`: AsyncLocalStorage wrappers. Anything
//     emitted via the legacy `getLogger()` API (see ../log.ts) while inside a
//     `runWithCorrelation()` scope automatically gains a `correlation_id` field.
//
// Output is one JSON object per line on stderr. `pino-pretty` is opt-in via
// STAVR_LOG_PRETTY=1 (developer ergonomics; the worker-thread transport is
// heavy and vitest dislikes it, so it stays off by default).

import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import { STAVR_VERSION } from '../version.generated.js';

export interface LogCtx {
  correlation_id?: string;
  source_agent?: string;
  /**
   * Calling actor for the chokepoint gate (Phase 2). HTTP middleware stamps
   * this from `req.device.name` for paired remote callers and
   * `loopback:<correlation_id>` for local /mcp callers. stdio sessions
   * inherit nothing and the gate falls through to its own default — see
   * `src/server.ts` chokepoint construction.
   */
  actor_id?: string;
}

export const logContext = new AsyncLocalStorage<LogCtx>();

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  const existing = logContext.getStore() ?? {};
  return logContext.run({ ...existing, correlation_id: correlationId }, fn);
}

export function withLogContext<T>(ctx: LogCtx, fn: () => T): T {
  const existing = logContext.getStore() ?? {};
  return logContext.run({ ...existing, ...ctx }, fn);
}

export function getCorrelationId(): string | undefined {
  return logContext.getStore()?.correlation_id;
}

// Bombardment Phase 0 — version is baked at build time from
// package.json#version (see scripts/generate-version.mjs). Recon
// defect #5 sibling: pre-fix this walked up to find package.json on
// disk and fell back to STAVR_VERSION env / '0.0.0'. The walk fails
// in the SEA bundle (no package.json on disk) and the env var is
// never populated, so the logger reported '0.0.0' on every SEA /
// sidecar / Windows Service launch path.

let activePino: PinoLogger | null = null;

function buildPino(): PinoLogger {
  const level = process.env.STAVR_LOG_LEVEL ?? 'info';
  const usePretty = process.env.STAVR_LOG_PRETTY === '1';
  const options: pino.LoggerOptions = {
    level,
    base: {
      service: 'stavr',
      version: STAVR_VERSION,
      pid: process.pid,
    },
    mixin() {
      const ctx = logContext.getStore();
      if (!ctx) return {};
      const out: Record<string, unknown> = {};
      if (ctx.correlation_id) out.correlation_id = ctx.correlation_id;
      if (ctx.source_agent) out.source_agent = ctx.source_agent;
      if (ctx.actor_id) out.actor_id = ctx.actor_id;
      return out;
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  if (usePretty) {
    options.transport = { target: 'pino-pretty', options: { destination: 2 } };
    return pino(options);
  }
  return pino(options, process.stderr);
}

export function getPinoLogger(): PinoLogger {
  if (!activePino) activePino = buildPino();
  return activePino;
}

/** Test seam: install a custom pino instance (e.g. one writing to a test sink). */
export function setPinoLogger(instance: PinoLogger): void {
  activePino = instance;
}

/** Test seam: build a fresh pino instance writing to the provided sink. */
export function makePinoForSink(write: (line: string) => void): PinoLogger {
  return pino(
    {
      level: 'trace',
      base: {
        service: 'stavr',
        version: STAVR_VERSION,
        pid: process.pid,
      },
      mixin() {
        const ctx = logContext.getStore();
        if (!ctx) return {};
        const out: Record<string, unknown> = {};
        if (ctx.correlation_id) out.correlation_id = ctx.correlation_id;
        if (ctx.source_agent) out.source_agent = ctx.source_agent;
        return out;
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    { write },
  );
}

/** Convenience: route a legacy logger call (msg + metadata) through pino. */
export function pinoLog(level: 'info' | 'warn' | 'error', msg: string, metadata?: Record<string, unknown>): void {
  const lg = getPinoLogger();
  if (metadata && Object.keys(metadata).length > 0) lg[level](metadata, msg);
  else lg[level](msg);
}
