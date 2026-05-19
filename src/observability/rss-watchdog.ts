/**
 * In-process RSS watchdog (v0.6.x memory-leak fix Phase 3).
 *
 * Belt-and-braces alongside PM2's `max_memory_restart`. PM2 polls
 * `process.memoryUsage().rss` every ~10s; if the daemon's event loop is
 * stalled (as during a V8 GC death-spiral plateau), PM2 may miss the
 * window before V8 itself OOMs. An in-process `setInterval` runs even
 * when the loop is degraded and gives us a chance to capture a heap
 * snapshot + emit an event before the wheels come off.
 *
 * Threshold is `STAVR_RSS_WATCHDOG_MB` (default 4000 MB). Set the env to
 * 0 to disable.
 *
 * Modelled on `memory-poller.ts` — same shape so tests can use the same
 * scheduler / memoryUsage test seams.
 */
import { writeHeapSnapshot } from 'node:v8';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';

export interface RssWatchdogOpts {
  intervalMs?: number;
  thresholdMb?: number;
  snapshotDir?: string;
  /** Test seam — overrides setInterval/clearInterval. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Test seam — overrides process.memoryUsage. */
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** Test seam — overrides v8.writeHeapSnapshot. */
  writeHeapSnapshot?: (filename: string) => string;
  /** Test seam — overrides mkdir for the snapshot dir. */
  mkdir?: (dir: string) => void;
}

export type RssWatchdogStop = () => void;

const DEFAULT_THRESHOLD_MB = 4000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SNAPSHOT_DIR = './tmp/rss-watchdog-snapshots';

function resolveThresholdMb(override: number | undefined): number {
  if (typeof override === 'number') return override;
  const raw = process.env.STAVR_RSS_WATCHDOG_MB;
  if (!raw) return DEFAULT_THRESHOLD_MB;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD_MB;
  return n;
}

export function startRssWatchdog(broker: Broker, opts: RssWatchdogOpts = {}): RssWatchdogStop {
  const thresholdMb = resolveThresholdMb(opts.thresholdMb);
  if (thresholdMb === 0) {
    // Explicitly disabled.
    return () => undefined;
  }
  const thresholdBytes = thresholdMb * 1024 * 1024;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduler = opts.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage());
  const writeSnap = opts.writeHeapSnapshot ?? writeHeapSnapshot;
  const mkdir = opts.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const snapshotDir = resolve(opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR);

  // Edge-trigger: only snapshot on the LEADING edge of each threshold crossing.
  // Once we've fired, don't fire again until RSS drops below the threshold and
  // crosses back up — otherwise a sustained leak would spam snapshots every
  // 30s and burn disk space.
  let armed = true;

  const tick = (): void => {
    let m: NodeJS.MemoryUsage;
    try {
      m = memoryUsage();
    } catch {
      return;
    }
    const overThreshold = m.rss > thresholdBytes;
    if (!overThreshold) {
      armed = true;
      return;
    }
    if (!armed) return;
    armed = false;

    let snapshotPath: string | null = null;
    let snapshotError: string | null = null;
    try {
      mkdir(snapshotDir);
      const filename = join(snapshotDir, `rss-watchdog-${Date.now()}.heapsnapshot`);
      snapshotPath = writeSnap(filename);
    } catch (err) {
      snapshotError = (err as Error).message;
      getLogger().warn('rss-watchdog: heap snapshot failed', { error: snapshotError });
    }

    void broker
      .publish({
        kind: 'daemon_rss_watchdog',
        at: new Date().toISOString(),
        source_agent: 'stavr-daemon',
        payload: {
          rss_bytes: m.rss,
          rss_mb: Math.round(m.rss / 1024 / 1024),
          threshold_mb: thresholdMb,
          heap_used_bytes: m.heapUsed,
          heap_total_bytes: m.heapTotal,
          snapshot_path: snapshotPath,
          snapshot_error: snapshotError,
        },
      })
      .catch((err) => {
        getLogger().warn('rss-watchdog publish failed', { error: (err as Error).message });
      });
  };

  const handle = scheduler.setInterval(tick, intervalMs);
  const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') maybeUnref.call(handle);
  return () => scheduler.clearInterval(handle);
}
