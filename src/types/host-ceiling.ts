/**
 * Host-resource ceiling schema (Phase 1 of host-resource-ceiling BOM).
 *
 * A configured cap on how much of the host stavR and everything it spawns may
 * consume. Enforced by:
 *   1. Admission control (Phase 3) — refuse / queue work that would breach.
 *   2. OS-level hard cap (Phase 4) — cgroup-v2 / Job Object best-effort.
 *   3. Load-shedding (Phase 5) — stop accepting + terminate the most-expensive
 *      worker when host headroom drops below a runtime threshold.
 *
 * The schema is a top-level addition to `stavr.yaml` under the key
 * `host_ceiling`. Missing block → conservative defaults below apply.
 *
 * Defaults are deliberately conservative: the 2026-05-20 incident showed
 * stavR could spawn until the host hung and PM2 died. The ceiling is on
 * the host, not per-worker — if a single worker is greedy, load-shedding
 * targets it; we don't pre-allocate.
 */
import { z } from 'zod';

export const HostCeilingSchema = z
  .object({
    /**
     * Admission control trips above this fraction of total host RAM in use
     * (across ALL host procs, not just stavR). 0..1 inclusive. The 0.75
     * default leaves 25% headroom for the OS, the IDE, and the browser the
     * operator is reading dashboards in.
     */
    max_host_ram_pct: z.number().min(0).max(1).default(0.75),

    /**
     * Hard floor on free physical RAM in GB. Whichever of `max_host_ram_pct`
     * and `min_free_ram_gb` is MORE restrictive wins (logical AND). Keeps
     * the daemon honest on large hosts where 25% of 64 GB is generous but
     * stavR has already booked a lot.
     */
    min_free_ram_gb: z.number().min(0).default(2.0),

    /**
     * Admission control trips above this fraction of host CPU sustained over
     * `headroom_window_ms`. EWMA smoothed; a single 100% spike does not
     * refuse. 0..1 inclusive.
     */
    max_sustained_cpu_pct: z.number().min(0).max(1).default(0.85),

    /**
     * Hard worker count cap. The 2026-05-20 incident was a spawn explosion;
     * this knob alone would have prevented it. 0 disables the cap (advanced).
     */
    max_concurrent_workers: z.number().int().min(0).default(4),

    /**
     * EWMA / smoothing window for CPU + RAM headroom decisions. Set short
     * enough to react to a real overrun (~10s), long enough to not refuse
     * on a 200ms GC spike.
     */
    headroom_window_ms: z.number().int().min(1_000).default(10_000),

    /**
     * Load-shedding triggers above this fraction of host RAM in use OR
     * below `shed_min_free_ram_gb`. Strictly tighter than the admission
     * thresholds: by the time we are shedding, admission has already been
     * refusing for a while.
     */
    shed_threshold_pct: z.number().min(0).max(1).default(0.95),

    /**
     * Load-shedding free-RAM floor. Companion to `shed_threshold_pct`;
     * either condition triggers shed. Strictly tighter than
     * `min_free_ram_gb`.
     */
    shed_min_free_ram_gb: z.number().min(0).default(0.5),

    /**
     * Top-level enable switch. When false, admission control / OS cap /
     * load-shedding are all no-ops (the host-headroom poller still runs
     * for observability). Defaults to true — the whole point of this BOM
     * is to prevent another host hang.
     */
    enabled: z.boolean().default(true),
  })
  .default({
    max_host_ram_pct: 0.75,
    min_free_ram_gb: 2.0,
    max_sustained_cpu_pct: 0.85,
    max_concurrent_workers: 4,
    headroom_window_ms: 10_000,
    shed_threshold_pct: 0.95,
    shed_min_free_ram_gb: 0.5,
    enabled: true,
  });

export type HostCeiling = z.infer<typeof HostCeilingSchema>;

export const DEFAULT_HOST_CEILING: HostCeiling = {
  max_host_ram_pct: 0.75,
  min_free_ram_gb: 2.0,
  max_sustained_cpu_pct: 0.85,
  max_concurrent_workers: 4,
  headroom_window_ms: 10_000,
  shed_threshold_pct: 0.95,
  shed_min_free_ram_gb: 0.5,
  enabled: true,
};

/**
 * Cross-validation that zod's per-field constraints can't express on their
 * own. Returns a list of human-readable errors; empty list = valid. The
 * config loader calls this after `parse()` so invalid combinations fail
 * with a clear message rather than working unpredictably.
 */
export function validateHostCeilingCoherence(c: HostCeiling): string[] {
  const errs: string[] = [];
  if (c.shed_threshold_pct < c.max_host_ram_pct) {
    errs.push(
      `host_ceiling: shed_threshold_pct (${c.shed_threshold_pct}) must be >= max_host_ram_pct (${c.max_host_ram_pct}) — shedding is the *tighter* threshold, not the looser one.`,
    );
  }
  if (c.shed_min_free_ram_gb > c.min_free_ram_gb) {
    errs.push(
      `host_ceiling: shed_min_free_ram_gb (${c.shed_min_free_ram_gb}) must be <= min_free_ram_gb (${c.min_free_ram_gb}) — shedding is the *tighter* floor, not the looser one.`,
    );
  }
  return errs;
}
