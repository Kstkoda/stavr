/**
 * OOM leak-hunt: emit a `daemon_memory` event every 60s. Carries the four
 * canonical process.memoryUsage() numbers plus broker-side counters that the
 * pre-run recon flagged as suspect (events table size, SSE session count).
 *
 * Wired in src/daemon.ts startDaemonForeground after the broker is ready;
 * the returned dispose fn is called during shutdown so the interval doesn't
 * keep the process alive past SIGTERM.
 */
import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';

export interface MemoryPollerOpts {
  intervalMs?: number;
  /** Test seam — overrides setInterval/clearInterval. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Test seam — overrides process.memoryUsage. */
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** Optional: extra getter for live SSE session count (mountTransports owns the Map). */
  sseSessionCount?: () => number;
}

export type MemoryPollerStop = () => void;

export function startMemoryPoller(broker: Broker, opts: MemoryPollerOpts = {}): MemoryPollerStop {
  const intervalMs = opts.intervalMs ?? 60_000;
  const scheduler = opts.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage());

  const tick = (): void => {
    const m = memoryUsage();
    const payload = {
      rss: m.rss,
      heapTotal: m.heapTotal,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      eventCount: safeCount(() => broker.store.eventCount()),
      sseSessions: opts.sseSessionCount ? safeCount(opts.sseSessionCount) : safeCount(() => broker.sessionCount()),
    };
    // Publish via the broker so dashboards and `stavr tail` see it. publish()
    // never throws — persistence failures fan out via synthesized events.
    void broker
      .publish({
        kind: 'daemon_memory',
        at: new Date().toISOString(),
        source_agent: 'stavr-daemon',
        payload,
      })
      .catch((err) => {
        getLogger().warn('daemon_memory publish failed', { error: (err as Error).message });
      });
  };

  // First tick immediately so the first sample lands at boot, not 60s later.
  tick();
  const handle = scheduler.setInterval(tick, intervalMs);
  // Stops the interval from keeping the event loop alive on SIGTERM. The
  // returned stop fn still clears it, but unref is belt-and-braces in case
  // the caller forgets to call it.
  const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') maybeUnref.call(handle);
  return () => scheduler.clearInterval(handle);
}

function safeCount(fn: () => number): number | null {
  try {
    const n = fn();
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
