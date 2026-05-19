/**
 * v0.6.11 Phase 3 — emit a `perf_sample` event every 60s carrying the
 * current per-endpoint stats snapshot. Mirrors the daemon_memory poller in
 * `src/observability/memory-poller.ts`: same scheduling shape, same unref
 * pattern, same dispose return.
 */
import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';
import { perfSnapshot } from './perf-metrics.js';

export interface PerfPollerOpts {
  intervalMs?: number;
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export type PerfPollerStop = () => void;

export function startPerfPoller(broker: Broker, opts: PerfPollerOpts = {}): PerfPollerStop {
  const intervalMs = opts.intervalMs ?? 60_000;
  const scheduler = opts.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  const tick = (): void => {
    const snap = perfSnapshot();
    // Skip the publish if nothing's been recorded yet — keeps event-store
    // cardinality clean during cold boot.
    if (Object.keys(snap.endpoints).length === 0) return;
    void broker
      .publish({
        kind: 'perf_sample',
        at: snap.at,
        source_agent: 'stavr-daemon',
        payload: { endpoints: snap.endpoints },
      })
      .catch((err) => {
        getLogger().warn('perf_sample publish failed', { error: (err as Error).message });
      });
  };

  const handle = scheduler.setInterval(tick, intervalMs);
  const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') maybeUnref.call(handle);
  return () => scheduler.clearInterval(handle);
}
