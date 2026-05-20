/**
 * Host-headroom poller (Phase 2 of host-resource-ceiling BOM).
 *
 * Extends the family of process-level pollers (memory-poller, rss-watchdog,
 * perf-poller, event-loop) with a host-level sample. Where the others ask
 * "how is THIS process doing?", this one asks "how is the HOST doing?" —
 * because the 2026-05-20 incident wasn't a process leak, it was the whole
 * machine being booked solid.
 *
 * Samples every `intervalMs`:
 *   - host RAM total / free / used / pct in use (`node:os` totalmem/freemem)
 *   - host CPU % busy (delta across `node:os` cpus() between ticks)
 *
 * Emits a `daemon_host_headroom` broker event every tick. Maintains an in-memory
 * EWMA so admission control (Phase 3) and load-shedding (Phase 5) can read a
 * stable "current" snapshot without re-doing the math.
 *
 * Same shape as memory-poller.ts on purpose — same scheduler seam, same
 * `node:os` seam for tests, same unref + dispose pattern.
 */
import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from 'node:os';
import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';
import type { HostCeiling } from '../types/host-ceiling.js';

export interface HeadroomSnapshot {
  /** ISO timestamp this sample was taken. */
  at: string;
  /** Total host RAM in bytes. */
  ram_total_bytes: number;
  /** Free host RAM in bytes — node:os.freemem(). */
  ram_free_bytes: number;
  /** Used host RAM in bytes = total - free. */
  ram_used_bytes: number;
  /** Fraction of host RAM in use, 0..1. */
  ram_used_pct: number;
  /** Free RAM in GB, rounded to 3 decimals — operator-readable. */
  ram_free_gb: number;
  /**
   * Instantaneous CPU % busy across all cores, 0..1. Computed from the delta
   * of os.cpus() times since the last sample. Null on the very first sample
   * (no delta yet) and any sample where cpu hotplug / vm rescale changed the
   * core count.
   */
  cpu_busy_pct: number | null;
  /**
   * EWMA-smoothed CPU % busy over the configured headroom window. Null when
   * we don't have enough samples yet (cold start).
   */
  cpu_busy_pct_ewma: number | null;
  /**
   * EWMA-smoothed RAM used pct over the configured headroom window. Always
   * filled in (single-sample seed is the current value).
   */
  ram_used_pct_ewma: number;
}

export interface HostHeadroomMonitor {
  /**
   * Current best-estimate headroom snapshot. Returns null only before the
   * very first tick — after that the poller always has a sample to hand
   * back. Admission control treats `null` as "no data yet, allow" (fail-open)
   * so we don't refuse spawns during boot.
   */
  current(): HeadroomSnapshot | null;
}

export interface HostHeadroomPollerOpts {
  /** Polling interval in ms. Default 2000 — small so EWMA reacts to real overruns. */
  intervalMs?: number;
  /** Ceiling block — only the headroom_window_ms is used here (for the EWMA alpha). */
  ceiling: HostCeiling;
  /** Test seam — overrides node:os calls. */
  osMetrics?: {
    totalmem: () => number;
    freemem: () => number;
    cpus: () => Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  };
  /** Test seam — overrides setInterval/clearInterval. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Optional broker — when undefined, events are not published (useful in tests / when broker not ready). */
  broker?: Broker;
}

export interface HostHeadroomPollerHandle extends HostHeadroomMonitor {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 2_000;
const BYTES_PER_GB = 1024 * 1024 * 1024;

interface CpuTotals {
  busy: number;
  total: number;
  coreCount: number;
}

function sumCpus(snapshot: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTotals {
  let busy = 0;
  let total = 0;
  for (const c of snapshot) {
    const t = c.times;
    const procTotal = t.user + t.nice + t.sys + t.idle + t.irq;
    busy += procTotal - t.idle;
    total += procTotal;
  }
  return { busy, total, coreCount: snapshot.length };
}

/**
 * EWMA alpha derived from the headroom window. With intervalMs samples
 * and a window W, alpha ≈ 1 - exp(-intervalMs/W). Cheap approximation
 * that gets the half-life right without depending on Math.exp at the
 * call site (we want a stable, testable number).
 */
function ewmaAlpha(intervalMs: number, windowMs: number): number {
  if (windowMs <= 0) return 1;
  const ratio = intervalMs / windowMs;
  // 1 - e^{-ratio} via series for small ratio, else clamp.
  const a = 1 - Math.exp(-ratio);
  if (!Number.isFinite(a)) return 1;
  return Math.min(Math.max(a, 0), 1);
}

export function startHostHeadroomPoller(opts: HostHeadroomPollerOpts): HostHeadroomPollerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const osMetrics = opts.osMetrics ?? {
    totalmem: () => osTotalmem(),
    freemem: () => osFreemem(),
    cpus: () => osCpus(),
  };
  const scheduler = opts.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const alpha = ewmaAlpha(intervalMs, opts.ceiling.headroom_window_ms);

  let last: HeadroomSnapshot | null = null;
  let lastCpuTotals: CpuTotals | null = null;

  const tick = (): void => {
    let totalRam: number;
    let freeRam: number;
    let cpuSnapshot: ReturnType<typeof osMetrics.cpus>;
    try {
      totalRam = osMetrics.totalmem();
      freeRam = osMetrics.freemem();
      cpuSnapshot = osMetrics.cpus();
    } catch (err) {
      getLogger().warn('host-headroom: os metrics threw', { error: (err as Error).message });
      return;
    }
    const usedRam = Math.max(0, totalRam - freeRam);
    const ramPct = totalRam > 0 ? usedRam / totalRam : 0;

    const cpuTotals = sumCpus(cpuSnapshot);

    let cpuPct: number | null = null;
    if (lastCpuTotals && lastCpuTotals.coreCount === cpuTotals.coreCount) {
      const dBusy = cpuTotals.busy - lastCpuTotals.busy;
      const dTotal = cpuTotals.total - lastCpuTotals.total;
      if (dTotal > 0 && dBusy >= 0) {
        cpuPct = Math.min(1, dBusy / dTotal);
      }
    }
    lastCpuTotals = cpuTotals;

    const ramEwma = last
      ? alpha * ramPct + (1 - alpha) * last.ram_used_pct_ewma
      : ramPct;

    let cpuEwma: number | null = null;
    if (cpuPct !== null) {
      cpuEwma = last && last.cpu_busy_pct_ewma !== null
        ? alpha * cpuPct + (1 - alpha) * last.cpu_busy_pct_ewma
        : cpuPct;
    } else if (last) {
      cpuEwma = last.cpu_busy_pct_ewma;
    }

    const snapshot: HeadroomSnapshot = {
      at: new Date().toISOString(),
      ram_total_bytes: totalRam,
      ram_free_bytes: freeRam,
      ram_used_bytes: usedRam,
      ram_used_pct: ramPct,
      ram_free_gb: Math.round((freeRam / BYTES_PER_GB) * 1000) / 1000,
      cpu_busy_pct: cpuPct,
      cpu_busy_pct_ewma: cpuEwma,
      ram_used_pct_ewma: ramEwma,
    };
    last = snapshot;

    if (opts.broker) {
      void opts.broker
        .publish({
          kind: 'daemon_host_headroom',
          at: snapshot.at,
          source_agent: 'stavr-daemon',
          payload: snapshot,
        })
        .catch((err) => {
          getLogger().warn('daemon_host_headroom publish failed', { error: (err as Error).message });
        });
    }
  };

  // Seed sample so `current()` returns something useful before the first
  // interval fires. The CPU delta is null until the second tick.
  tick();

  const handle = scheduler.setInterval(tick, intervalMs);
  const maybeUnref = (handle as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === 'function') maybeUnref.call(handle);

  return {
    current: () => last,
    stop: () => scheduler.clearInterval(handle),
  };
}

/**
 * Test helper — build a synthetic monitor that always returns the supplied
 * snapshot. Used by orchestrator admission-control tests to inject "host
 * is over the ceiling" without spinning a real poller.
 */
export function staticHostHeadroomMonitor(snapshot: HeadroomSnapshot | null): HostHeadroomMonitor {
  return { current: () => snapshot };
}
