/**
 * Phase 6 unit tests for src/dashboard/data/host-ceiling.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import {
  fetchHostCeilingData,
  formatHostCeilingHeadline,
  hostCeilingStatusClass,
} from '../../src/dashboard/data/host-ceiling.js';
import { setHostCeilingContext } from '../../src/server.js';
import { staticHostHeadroomMonitor } from '../../src/observability/host-headroom-poller.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';

describe('fetchHostCeilingData', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('returns ceiling=null when no host-ceiling context is wired', () => {
    const d = fetchHostCeilingData(broker);
    expect(d.ceiling).toBeNull();
    expect(d.snapshot).toBeNull();
    expect(d.os_cap).toBeNull();
    expect(d.refused_recent).toBe(0);
    expect(d.shed_recent).toBe(0);
  });

  it('surfaces ceiling + snapshot when wired', () => {
    setHostCeilingContext(broker, {
      ceiling: DEFAULT_HOST_CEILING,
      monitor: staticHostHeadroomMonitor({
        at: '2026-05-20T22:00:00Z',
        ram_total_bytes: 16 * 1024 ** 3,
        ram_free_bytes: 8 * 1024 ** 3,
        ram_used_bytes: 8 * 1024 ** 3,
        ram_used_pct: 0.5,
        ram_free_gb: 8,
        cpu_busy_pct: 0.2,
        cpu_busy_pct_ewma: 0.2,
        ram_used_pct_ewma: 0.5,
      }),
    });
    const d = fetchHostCeilingData(broker);
    expect(d.ceiling).toBe(DEFAULT_HOST_CEILING);
    expect(d.snapshot?.ram_free_gb).toBe(8);
  });

  it('counts host_ceiling_refused + host_ceiling_shed in last hour', async () => {
    const now = new Date().toISOString();
    await broker.publish({
      kind: 'host_ceiling_refused',
      at: now,
      source_agent: 'stavr-workers',
      payload: { reason: 'max_concurrent_workers' },
    });
    await broker.publish({
      kind: 'host_ceiling_refused',
      at: now,
      source_agent: 'stavr-workers',
      payload: { reason: 'min_free_ram_gb' },
    });
    await broker.publish({
      kind: 'host_ceiling_shed',
      at: now,
      source_agent: 'stavr-workers',
      payload: { worker_id: 'x' },
    });
    const d = fetchHostCeilingData(broker);
    expect(d.refused_recent).toBe(2);
    expect(d.shed_recent).toBe(1);
  });

  it('exposes the most-recent host_ceiling_os_cap result', async () => {
    await broker.publish({
      kind: 'host_ceiling_os_cap',
      at: new Date().toISOString(),
      source_agent: 'stavr-daemon',
      payload: { kind: 'cgroup-v2', installed: true, memory_max_bytes: 12345 },
    });
    const d = fetchHostCeilingData(broker);
    expect(d.os_cap).toMatchObject({ kind: 'cgroup-v2', installed: true });
  });
});

describe('formatHostCeilingHeadline + hostCeilingStatusClass', () => {
  it('formats: not wired', () => {
    const d = {
      ceiling: null,
      snapshot: null,
      os_cap: null,
      refused_recent: 0,
      shed_recent: 0,
    };
    expect(formatHostCeilingHeadline(d)).toMatch(/not wired/);
    expect(hostCeilingStatusClass(d)).toBe('idle');
  });

  it('formats: disabled', () => {
    const d = {
      ceiling: { ...DEFAULT_HOST_CEILING, enabled: false },
      snapshot: null,
      os_cap: null,
      refused_recent: 0,
      shed_recent: 0,
    };
    expect(formatHostCeilingHeadline(d)).toMatch(/disabled/);
    expect(hostCeilingStatusClass(d)).toBe('idle');
  });

  it('classifies crit when ram_used_pct_ewma above shed threshold', () => {
    const d = {
      ceiling: DEFAULT_HOST_CEILING,
      snapshot: {
        at: '', ram_total_bytes: 0, ram_free_bytes: 0, ram_used_bytes: 0,
        ram_used_pct: 0.97, ram_free_gb: 4, cpu_busy_pct: 0.1,
        cpu_busy_pct_ewma: 0.1, ram_used_pct_ewma: 0.97,
      },
      os_cap: null,
      refused_recent: 0,
      shed_recent: 0,
    };
    expect(hostCeilingStatusClass(d)).toBe('crit');
  });

  it('classifies warn when ram pct EWMA crosses max but not shed', () => {
    const d = {
      ceiling: DEFAULT_HOST_CEILING,
      snapshot: {
        at: '', ram_total_bytes: 0, ram_free_bytes: 0, ram_used_bytes: 0,
        ram_used_pct: 0.8, ram_free_gb: 4, cpu_busy_pct: 0.1,
        cpu_busy_pct_ewma: 0.1, ram_used_pct_ewma: 0.8,
      },
      os_cap: null,
      refused_recent: 0,
      shed_recent: 0,
    };
    expect(hostCeilingStatusClass(d)).toBe('warn');
  });
});
