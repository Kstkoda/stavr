import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
import {
  refreshHostMetrics,
  nodeCpuUtilizationPct,
  nodeCpuLoadPerCore,
  nodeMemoryUsedPct,
  nodeMemoryAvailableBytes,
  nodeBootTimeSeconds,
} from '../../src/observability/host-metrics.js';

describe('host metrics — Wave 2 (Layer 1 USE)', () => {
  it('exposes the Layer 1 catalog on /metrics', async () => {
    const text = await registry.metrics();
    expect(text).toContain('node_cpu_utilization_pct');
    expect(text).toContain('node_cpu_load_per_core');
    expect(text).toContain('node_cpu_steal_pct');
    expect(text).toContain('node_cpu_throttled_pct');
    expect(text).toContain('node_context_switches_per_sec');
    expect(text).toContain('node_memory_used_pct');
    expect(text).toContain('node_memory_available_bytes');
    expect(text).toContain('node_swap_used_pct');
    expect(text).toContain('node_memory_major_page_faults_per_sec');
    expect(text).toContain('node_oom_kills_total');
    expect(text).toContain('node_disk_space_used_pct');
    expect(text).toContain('node_disk_inodes_used_pct');
    expect(text).toContain('node_disk_io_latency_seconds');
    expect(text).toContain('node_disk_iops');
    expect(text).toContain('node_disk_queue_depth');
    expect(text).toContain('node_disk_errors_total');
    expect(text).toContain('node_network_throughput_bytes_total');
    expect(text).toContain('node_network_errors_total');
    expect(text).toContain('node_network_drops_total');
    expect(text).toContain('node_tcp_retransmits_per_sec');
    expect(text).toContain('node_conntrack_used_pct');
    expect(text).toContain('node_filefd_used_pct');
    expect(text).toContain('node_clock_skew_seconds');
    expect(text).toContain('node_boot_time_seconds');
    expect(text).toContain('node_hw_temperature_celsius');
    expect(text).toContain('node_ram_ecc_errors_total');
  });

  it('refreshHostMetrics writes CPU + memory + boot-time gauges', async () => {
    // Warm-up call so the per-core delta has a baseline; second call has
    // real numbers in the gauge.
    refreshHostMetrics();
    refreshHostMetrics();
    const host = os.hostname();
    const coreCount = os.cpus().length;

    const cpu = (await nodeCpuUtilizationPct.get()).values.filter((v) => v.labels.host === host);
    expect(cpu.length).toBe(coreCount);
    for (const v of cpu) {
      expect(v.value).toBeGreaterThanOrEqual(0);
      expect(v.value).toBeLessThanOrEqual(100);
    }

    const load = (await nodeCpuLoadPerCore.get()).values.find((v) => v.labels.host === host);
    expect(load).toBeDefined();
    expect(typeof load!.value).toBe('number');

    const memUsed = (await nodeMemoryUsedPct.get()).values.find((v) => v.labels.host === host);
    expect(memUsed?.value).toBeGreaterThan(0);
    expect(memUsed?.value).toBeLessThan(100);

    const memAvail = (await nodeMemoryAvailableBytes.get()).values.find((v) => v.labels.host === host);
    expect(memAvail?.value).toBeGreaterThan(0);

    const boot = (await nodeBootTimeSeconds.get()).values.find((v) => v.labels.host === host);
    expect(boot?.value).toBeGreaterThan(0);
    // Should be plausibly in the past (last 100 years).
    const now = Math.floor(Date.now() / 1000);
    expect(boot!.value).toBeLessThanOrEqual(now);
    expect(boot!.value).toBeGreaterThan(now - 100 * 365 * 86_400);
  });
});
