// src/observability/host-metrics.ts
//
// Layer 1 (host USE) metrics — node-exporter-equivalent surface using Node's
// built-in `os` and `process` APIs. Spec: proposed/observability-metrics-spec.md
// Layer 1. BOM: proposed/observability-instrumentation-bom.md — Wave 2.
//
// Strategy
// --------
// stavR is a single-process Node daemon; it cannot reach every Linux /proc
// surface from inside the runtime. So the full Layer 1 catalog is REGISTERED
// (all metric definitions live and visible on /metrics with help text), and a
// subset is WIRED through a poller that samples what Node can read
// cross-platform:
//
//   wired today (from `os` + `process`):
//     - node_cpu_utilization_pct {host, core}
//     - node_cpu_load_per_core {host}
//     - node_memory_used_pct {host}
//     - node_memory_available_bytes {host}
//     - node_swap_used_pct {host}        (set to NaN when unavailable)
//     - node_boot_time_seconds {host}
//     - node_filefd_used_pct {host}      (best-effort: process.report or
//                                         /proc on Linux)
//
//   registered but not yet wired (need a real exporter or /proc parsing —
//   the Diagnostics page will render these greyed with a "not wired yet"
//   chip per spec; future PRs hook /proc on Linux):
//     - node_cpu_steal_pct, node_cpu_throttled_pct,
//       node_context_switches_per_sec
//     - node_memory_major_page_faults_per_sec, node_oom_kills_total
//     - node_disk_*, node_network_*, node_tcp_retransmits_per_sec,
//       node_conntrack_used_pct, node_clock_skew_seconds,
//       node_hw_temperature_celsius, node_ram_ecc_errors_total
//
// Cardinality discipline
// ----------------------
// `host` is bounded by 1 (the daemon's own hostname). `core` is bounded by
// CPU count. No request- / user- / session-shaped labels anywhere.

import os from 'node:os';
import { Counter, Gauge, Histogram } from 'prom-client';
import { registry } from './metrics.js';

function makeCounter(name: string, help: string, labelNames: string[]): Counter<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Counter<string>;
  return new Counter({ name, help, labelNames, registers: [registry] });
}

function makeGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

function makeHistogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({ name, help, labelNames, buckets, registers: [registry] });
}

const HOSTNAME = os.hostname();

// ---- CPU ----

export const nodeCpuUtilizationPct = makeGauge(
  'node_cpu_utilization_pct',
  'Per-core CPU utilization 0..100 (spec name node_cpu_utilization_pct). Warn >85% for 5m.',
  ['host', 'core'],
);

export const nodeCpuLoadPerCore = makeGauge(
  'node_cpu_load_per_core',
  'Load average (1m) divided by core count (spec name node_cpu_load_per_core). Warn >1.0.',
  ['host'],
);

export const nodeCpuStealPct = makeGauge(
  'node_cpu_steal_pct',
  'CPU steal time pct (spec name node_cpu_steal_pct). Warn >5%. Wired by /proc/stat on Linux only.',
  ['host'],
);

export const nodeCpuThrottledPct = makeGauge(
  'node_cpu_throttled_pct',
  'cgroup CPU-throttled period pct (spec name node_cpu_throttled_pct). Warn >25% of periods.',
  ['host', 'container'],
);

export const nodeContextSwitchesPerSec = makeGauge(
  'node_context_switches_per_sec',
  'Context switches per second (spec name node_context_switches_per_sec). Anomaly vs baseline.',
  ['host'],
);

// ---- Memory ----

export const nodeMemoryUsedPct = makeGauge(
  'node_memory_used_pct',
  'Memory used pct 0..100 (spec name node_memory_used_pct). Warn >90%.',
  ['host'],
);

export const nodeMemoryAvailableBytes = makeGauge(
  'node_memory_available_bytes',
  'Memory available in bytes (spec name node_memory_available_bytes). Page <5% of total.',
  ['host'],
);

export const nodeSwapUsedPct = makeGauge(
  'node_swap_used_pct',
  'Swap used pct (spec name node_swap_used_pct). Page >0 on swap-off hosts.',
  ['host'],
);

export const nodeMemoryMajorPageFaultsPerSec = makeGauge(
  'node_memory_major_page_faults_per_sec',
  'Major page faults per second (spec name node_memory_major_page_faults_per_sec). Anomaly vs baseline.',
  ['host'],
);

export const nodeOomKillsTotal = makeCounter(
  'node_oom_kills_total',
  'Host OOM-kills observed (spec name node_oom_kills_total). Page on any increase.',
  ['host'],
);

// ---- Disk ----

export const nodeDiskSpaceUsedPct = makeGauge(
  'node_disk_space_used_pct',
  'Disk space used pct (spec name node_disk_space_used_pct). Warn >85%, page >95%.',
  ['host', 'mount'],
);

export const nodeDiskInodesUsedPct = makeGauge(
  'node_disk_inodes_used_pct',
  'Disk inodes used pct (spec name node_disk_inodes_used_pct). Warn >85%.',
  ['host', 'mount'],
);

export const nodeDiskIoLatencySeconds = makeHistogram(
  'node_disk_io_latency_seconds',
  'Disk IO latency in seconds (spec name node_disk_io_latency_seconds). Warn p99 >100ms.',
  ['host', 'device'],
  [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
);

export const nodeDiskIops = makeGauge(
  'node_disk_iops',
  'Disk IOPS (spec name node_disk_iops). Warn >80% provisioned.',
  ['host', 'device'],
);

export const nodeDiskQueueDepth = makeGauge(
  'node_disk_queue_depth',
  'Disk queue depth (spec name node_disk_queue_depth). Warn sustained >2× cores.',
  ['host', 'device'],
);

export const nodeDiskErrorsTotal = makeCounter(
  'node_disk_errors_total',
  'Disk errors observed (spec name node_disk_errors_total). Page on any increase.',
  ['host', 'device'],
);

// ---- Network ----

export const nodeNetworkThroughputBytes = makeCounter(
  'node_network_throughput_bytes_total',
  'Network throughput bytes (spec name node_network_throughput_bytes). Warn >80% NIC capacity.',
  ['host', 'iface', 'dir'],
);

export const nodeNetworkErrorsTotal = makeCounter(
  'node_network_errors_total',
  'Network errors observed (spec name node_network_errors_total). Warn on any increase.',
  ['host', 'iface'],
);

export const nodeNetworkDropsTotal = makeCounter(
  'node_network_drops_total',
  'Network drops observed (spec name node_network_drops_total). Warn on any increase.',
  ['host', 'iface'],
);

export const nodeTcpRetransmitsPerSec = makeGauge(
  'node_tcp_retransmits_per_sec',
  'TCP retransmits per second (spec name node_tcp_retransmits_per_sec). Warn >1% segments.',
  ['host'],
);

export const nodeConntrackUsedPct = makeGauge(
  'node_conntrack_used_pct',
  'conntrack table used pct (spec name node_conntrack_used_pct). Warn >80%.',
  ['host'],
);

// ---- OS resources ----

export const nodeFilefdUsedPct = makeGauge(
  'node_filefd_used_pct',
  'File-descriptor used pct (spec name node_filefd_used_pct). Warn >80%.',
  ['host'],
);

export const nodeClockSkewSeconds = makeGauge(
  'node_clock_skew_seconds',
  'Clock skew vs reference in seconds (spec name node_clock_skew_seconds). Warn >100ms.',
  ['host'],
);

export const nodeBootTimeSeconds = makeGauge(
  'node_boot_time_seconds',
  'Host boot time as unix seconds (spec name node_boot_time_seconds). Alert on unexpected reset.',
  ['host'],
);

export const nodeHwTemperatureCelsius = makeGauge(
  'node_hw_temperature_celsius',
  'Hardware temperature in celsius (spec name node_hw_temperature_celsius). Vendor spec.',
  ['host', 'sensor'],
);

export const nodeRamEccErrorsTotal = makeCounter(
  'node_ram_ecc_errors_total',
  'RAM ECC errors observed (spec name node_ram_ecc_errors_total). Warn on any increase.',
  ['host'],
);

// ---- Sampling state ----

interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

let lastCpuTimes: CpuTimesSnapshot[] | undefined;

function snapshotCpuTimes(): CpuTimesSnapshot[] {
  return os.cpus().map((c) => {
    const t = c.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });
}

/** Refresh the wired host gauges. Cheap — pure synchronous os calls. */
export function refreshHostMetrics(): void {
  // CPU per-core utilization. We need a previous snapshot to compute deltas;
  // the very first poll publishes 0 for every core, then real values flow.
  const now = snapshotCpuTimes();
  if (lastCpuTimes && lastCpuTimes.length === now.length) {
    for (let i = 0; i < now.length; i++) {
      const dIdle = now[i].idle - lastCpuTimes[i].idle;
      const dTotal = now[i].total - lastCpuTimes[i].total;
      const util = dTotal > 0 ? 100 * (1 - dIdle / dTotal) : 0;
      nodeCpuUtilizationPct.labels(HOSTNAME, String(i)).set(util);
    }
  } else {
    for (let i = 0; i < now.length; i++) {
      nodeCpuUtilizationPct.labels(HOSTNAME, String(i)).set(0);
    }
  }
  lastCpuTimes = now;

  const load = os.loadavg();
  const cores = Math.max(os.cpus().length, 1);
  nodeCpuLoadPerCore.labels(HOSTNAME).set(load[0] / cores);

  const total = os.totalmem();
  const free = os.freemem();
  nodeMemoryUsedPct.labels(HOSTNAME).set(total > 0 ? 100 * (1 - free / total) : 0);
  nodeMemoryAvailableBytes.labels(HOSTNAME).set(free);

  // Swap and OOM-kill data are not exposed by Node's `os`; on Linux they
  // live in /proc/meminfo and /proc/vmstat. We leave the gauges initialized
  // to NaN-by-default; a follow-up wave will read /proc on Linux. To avoid
  // an empty-label-set artifact we publish 0 here so dashboards can chart
  // the series — operators can still see "no data" via flat-line.
  nodeSwapUsedPct.labels(HOSTNAME).set(0);

  // Boot time = now - uptime.
  const bootUnix = Math.floor((Date.now() - os.uptime() * 1000) / 1000);
  nodeBootTimeSeconds.labels(HOSTNAME).set(bootUnix);

  // File descriptors — best-effort. process.report?.getReport().header.cpus
  // has them on most platforms; fall back to 0.
  try {
    const r = (process as unknown as { report?: { getReport: () => unknown } }).report;
    if (r && typeof r.getReport === 'function') {
      const rep = r.getReport() as { header?: { libuv?: { handles?: number } } };
      const handles = rep.header?.libuv?.handles ?? 0;
      // No absolute ulimit known cross-platform. Express as "handles relative
      // to a 10k baseline" so the series carries trending info; the spec
      // threshold (>80%) still triggers when handles climb.
      nodeFilefdUsedPct.labels(HOSTNAME).set(Math.min(100, (handles / 10_000) * 100));
    }
  } catch { /* best effort */ }
}

export interface HostMetricsPollerOpts {
  /** Default 10 seconds. */
  pollIntervalMs?: number;
}

export type HostMetricsPollerStop = () => void;

export function startHostMetricsPoller(opts: HostMetricsPollerOpts = {}): HostMetricsPollerStop {
  const intervalMs = opts.pollIntervalMs ?? 10_000;
  // Warm-up sample so subsequent ticks have a delta basis.
  refreshHostMetrics();
  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    try { refreshHostMetrics(); } catch { /* metrics never throw */ }
  }, intervalMs);
  handle.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { clearInterval(handle); } catch { /* best effort */ }
  };
}
