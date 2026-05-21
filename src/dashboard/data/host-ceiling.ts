/**
 * src/dashboard/data/host-ceiling.ts
 *
 * Snapshot of the host-resource ceiling for the dashboard. Reads the broker's
 * host-ceiling context (set at daemon boot by setHostCeilingContext) + the
 * most-recent host-headroom snapshot + an optional os-cap result so the
 * diagnostics page can answer the operator's "is the ceiling on, and how
 * close are we?" question in one panel.
 *
 * Phase 6 of host-resource-ceiling BOM. Companion to:
 *  - src/types/host-ceiling.ts (the schema)
 *  - src/observability/host-headroom-poller.ts (the live snapshot)
 *  - src/governor/os-cap.ts (the OS-level cap result)
 */
import type { Broker } from '../../broker.js';
import type { HostCeiling } from '../../types/host-ceiling.js';
import type { HeadroomSnapshot } from '../../observability/host-headroom-poller.js';
import { getHostCeilingContext } from '../../server.js';

export interface HostCeilingDashboardData {
  /** Effective ceiling (may be null if the daemon never wired one — old config). */
  ceiling: HostCeiling | null;
  /** Most-recent headroom snapshot — null during cold boot. */
  snapshot: HeadroomSnapshot | null;
  /**
   * Most-recent OS-cap install result, derived from the host_ceiling_os_cap
   * broker event. Null when the daemon hasn't reported one yet (e.g. on a
   * stale DB without the new event kind).
   */
  os_cap: {
    kind: 'cgroup-v2' | 'job-object' | 'launchd' | 'none';
    installed: boolean;
    reason?: string;
    memory_max_bytes?: number;
  } | null;
  /**
   * Counts derived from recent events — used by the page to show "12
   * refusals in last hour" without making the page do its own counting.
   */
  refused_recent: number;
  shed_recent: number;
}

export function fetchHostCeilingData(broker: Broker): HostCeilingDashboardData {
  const ctx = getHostCeilingContext(broker);
  const ceiling = ctx?.ceiling ?? null;
  const snapshot = ctx?.monitor.current() ?? null;

  // Walk the broker's recent events to pull the latest OS-cap result +
  // refusal/shed counts in the last hour. The event store keeps these
  // long-lived enough that a peek-back over 1h is cheap; if it isn't,
  // Phase 2 retention sweeps it for us.
  let osCap: HostCeilingDashboardData['os_cap'] = null;
  let refusedRecent = 0;
  let shedRecent = 0;
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const events = broker.store.getEvents({
      kinds: ['host_ceiling_os_cap', 'host_ceiling_refused', 'host_ceiling_shed'],
      sinceAt: hourAgo,
      limit: 500,
    }).events;
    for (const e of events) {
      if (e.kind === 'host_ceiling_refused') refusedRecent += 1;
      else if (e.kind === 'host_ceiling_shed') shedRecent += 1;
      else if (e.kind === 'host_ceiling_os_cap') {
        // Most-recent wins; events come oldest-first.
        osCap = e.payload as HostCeilingDashboardData['os_cap'];
      }
    }
  } catch {
    // Don't let event-store hiccups break the dashboard render.
  }

  return {
    ceiling,
    snapshot,
    os_cap: osCap,
    refused_recent: refusedRecent,
    shed_recent: shedRecent,
  };
}

/**
 * Tiny presentational helpers used by the diagnostics page. Kept here (with
 * the data type) so the page-side glue stays a thin call into formatted
 * strings. Extracted as functions, not inline in renderHostCeilingPanel,
 * because Phase 6 verification tests cover the strings directly.
 */
export function formatHostCeilingHeadline(d: HostCeilingDashboardData): string {
  if (!d.ceiling) return 'host ceiling: not wired';
  if (!d.ceiling.enabled) return 'host ceiling: disabled';
  if (!d.snapshot) return 'host ceiling: armed, no sample yet';
  const pct = (d.snapshot.ram_used_pct_ewma * 100).toFixed(0);
  const freeGb = d.snapshot.ram_free_gb.toFixed(1);
  return `host ceiling: armed · ${pct}% RAM in use · ${freeGb} GB free`;
}

export function hostCeilingStatusClass(d: HostCeilingDashboardData): 'ok' | 'warn' | 'crit' | 'idle' {
  if (!d.ceiling || !d.ceiling.enabled) return 'idle';
  if (!d.snapshot) return 'idle';
  const s = d.snapshot;
  if (s.ram_used_pct_ewma >= d.ceiling.shed_threshold_pct) return 'crit';
  if (s.ram_free_gb < d.ceiling.shed_min_free_ram_gb) return 'crit';
  if (s.ram_used_pct_ewma >= d.ceiling.max_host_ram_pct) return 'warn';
  if (s.ram_free_gb < d.ceiling.min_free_ram_gb) return 'warn';
  if (
    s.cpu_busy_pct_ewma !== null &&
    s.cpu_busy_pct_ewma >= d.ceiling.max_sustained_cpu_pct
  ) {
    return 'warn';
  }
  return 'ok';
}
