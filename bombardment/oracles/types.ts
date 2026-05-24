/**
 * Bombardment Phase 1 — oracle types.
 *
 * An oracle is a pure check against daemon state. It runs against either
 * an in-process harness (an EventStore + Broker pair) or a live daemon
 * via HTTP probes. Each invocation returns a structured result so the
 * caller can decide pass/fail + capture evidence on a violation.
 *
 * Continuously-assertable: every oracle MUST be safe to run mid-load —
 * no destructive side-effects, no writes, no long blocking calls. The
 * soak harness invokes the full oracle set at every sample window
 * (default 60s) and at end of run.
 */

import type { Broker } from '../../src/broker.js';
import type { EventStore } from '../../src/persistence.js';

export interface InProcessOracleCtx {
  kind: 'in-process';
  store: EventStore;
  broker: Broker;
  /** Optional baseline captured at workload start, used by baseline-return oracles. */
  baseline?: {
    sessionCount: number;
    subscriptionCount: number;
    eventCount: number;
  };
}

export interface HttpOracleCtx {
  kind: 'http';
  baseUrl: string;
  /** Optional timeout per HTTP probe; default 2 s. */
  timeoutMs?: number;
}

export type OracleCtx = InProcessOracleCtx | HttpOracleCtx;

export interface OracleResult {
  /** Stable identifier — `no_orphan_sessions`, `retention_bounds`, etc. */
  name: string;
  /** Pass/fail. `null` means the oracle declined (wrong ctx kind / signal unavailable). */
  ok: boolean | null;
  /** Short human-readable failure reason; absent on pass. */
  reason?: string;
  /** Structured evidence — captured by preserve-on-failure on the first FAIL. */
  evidence?: Record<string, unknown>;
  /** Wall-clock millis the check took, for soak reporting. */
  durationMs: number;
}

/** Oracle function signature. Pure: same ctx → same result (modulo daemon mutation). */
export type Oracle = (ctx: OracleCtx) => Promise<OracleResult>;
