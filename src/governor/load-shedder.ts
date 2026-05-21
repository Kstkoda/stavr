/**
 * Load-shedding watchdog (Phase 5 of host-resource-ceiling BOM).
 *
 * The third layer of host-resource enforcement. Where:
 *  - Phase 3 admission control refuses NEW work that would breach the ceiling
 *  - Phase 4 OS-level cap physically kills a runaway daemon tree
 *  - Phase 5 (this) actively SHEDS existing work when headroom drops below
 *    the shed thresholds — so a slow-leak worker that snuck past admission
 *    doesn't ride the host into the ground.
 *
 * Trigger conditions (either is sufficient):
 *   - snapshot.ram_used_pct_ewma >= ceiling.shed_threshold_pct
 *   - snapshot.ram_free_gb       <  ceiling.shed_min_free_ram_gb
 *
 * Victim selection: the most-recently-spawned worker. The intuition is that
 * the most recent spawn is the one most likely to have caused the headroom
 * drop, and shedding it makes the *least* progress lost (it's also the one
 * the operator will most easily re-launch).
 *
 * Cool-down: after a shed, the watchdog waits one full headroom_window_ms
 * before considering a second shed. That prevents the watchdog from killing
 * three workers in a row when the EWMA hasn't caught up yet.
 */
import { getLogger } from '../log.js';
import type { HostCeiling } from '../types/host-ceiling.js';
import type { HostHeadroomMonitor } from '../observability/host-headroom-poller.js';

export interface SheddableOrchestrator {
  liveCount(): number;
  liveWorkerIdsInSpawnOrder(): string[];
  shedWorker(workerId: string, reason: string): Promise<{ exitCode?: number }>;
}

export interface LoadShedderOpts {
  ceiling: HostCeiling;
  monitor: HostHeadroomMonitor;
  orchestrator: SheddableOrchestrator;
  /** Tick interval ms. Default 5_000. */
  intervalMs?: number;
  /** Test seam — overrides setInterval/clearInterval. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Test seam — overrides Date.now (used for cooldown). */
  now?: () => number;
}

export type LoadShedderStop = () => void;

const DEFAULT_INTERVAL_MS = 5_000;

export function startLoadShedder(opts: LoadShedderOpts): LoadShedderStop {
  // Guard rail: if the ceiling is disabled there is nothing to do.
  if (!opts.ceiling.enabled) {
    return () => undefined;
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduler = opts.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const now = opts.now ?? (() => Date.now());
  let lastShedAt: number | null = null;

  const tick = async (): Promise<void> => {
    const snap = opts.monitor.current();
    if (!snap) return;

    const overPct = snap.ram_used_pct_ewma >= opts.ceiling.shed_threshold_pct;
    const underFree = snap.ram_free_gb < opts.ceiling.shed_min_free_ram_gb;
    if (!overPct && !underFree) {
      // Headroom is healthy. Reset the cooldown so the next stress event
      // gets immediate attention.
      lastShedAt = null;
      return;
    }

    if (lastShedAt !== null) {
      const sinceLast = now() - lastShedAt;
      if (sinceLast < opts.ceiling.headroom_window_ms) {
        // Inside cooldown; let the EWMA catch up to the previous shed.
        return;
      }
    }

    const live = opts.orchestrator.liveWorkerIdsInSpawnOrder();
    if (live.length === 0) {
      // Nothing to shed — the headroom problem isn't from stavR workers.
      // Phase 4 (OS cap) is what we depend on here.
      return;
    }
    const victim = live[live.length - 1];

    const reason = overPct && underFree
      ? `ram_used_pct_ewma=${(snap.ram_used_pct_ewma * 100).toFixed(1)}% over ${(opts.ceiling.shed_threshold_pct * 100).toFixed(0)}% AND ram_free_gb=${snap.ram_free_gb.toFixed(2)} under ${opts.ceiling.shed_min_free_ram_gb}`
      : overPct
        ? `ram_used_pct_ewma=${(snap.ram_used_pct_ewma * 100).toFixed(1)}% over ${(opts.ceiling.shed_threshold_pct * 100).toFixed(0)}%`
        : `ram_free_gb=${snap.ram_free_gb.toFixed(2)} under ${opts.ceiling.shed_min_free_ram_gb}`;

    try {
      await opts.orchestrator.shedWorker(victim, reason);
      lastShedAt = now();
    } catch (err) {
      getLogger().warn('load-shedder: shedWorker threw', {
        worker_id: victim,
        error: (err as Error).message,
      });
    }
  };

  // Don't fire on first tick — wait one interval so the EWMA has a
  // stable sample. Otherwise a slow-boot machine that hasn't loaded
  // its working set yet would be flagged.
  const handle = scheduler.setInterval(() => {
    void tick();
  }, intervalMs);
  const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') maybeUnref.call(handle);

  return () => scheduler.clearInterval(handle);
}
