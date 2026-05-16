/**
 * Tests for the /debug/* diagnostic endpoints.
 * Spec: bom-diagnostics-2026.md C3.
 *
 * Boots a real daemon on an ephemeral port and exercises:
 *   - 404 when STAVR_DEBUG_ENABLED is unset (don't leak endpoint existence)
 *   - 200 + valid file path when enabled
 *   - 429 on second invocation within the rate-limit window
 *
 * Loopback enforcement is unit-tested via the exported `isLoopbackReq` helper —
 * fully end-to-end testing of a non-loopback connection from vitest is not
 * possible without binding to an external interface.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, statSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import {
  _resetRateLimitsForTest,
  checkRateLimit,
  isDebugEnabled,
  isLoopbackReq,
} from '../../src/observability/debug-endpoints.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('debug endpoints — env gate', () => {
  let h: Harness;
  const prev = process.env.STAVR_DEBUG_ENABLED;

  beforeEach(async () => {
    delete process.env.STAVR_DEBUG_ENABLED;
    _resetRateLimitsForTest();
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
    if (prev === undefined) delete process.env.STAVR_DEBUG_ENABLED;
    else process.env.STAVR_DEBUG_ENABLED = prev;
  });

  it('returns 404 for /debug/heap-snapshot when STAVR_DEBUG_ENABLED is unset', async () => {
    const res = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for /debug/cpu-profile when STAVR_DEBUG_ENABLED is unset', async () => {
    const res = await fetch(`${h.base}/debug/cpu-profile?duration=1`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for /debug/diagnostic-report when STAVR_DEBUG_ENABLED is unset', async () => {
    const res = await fetch(`${h.base}/debug/diagnostic-report`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('debug endpoints — enabled', () => {
  let h: Harness;
  const prev = process.env.STAVR_DEBUG_ENABLED;
  let writtenFiles: string[];

  beforeEach(async () => {
    process.env.STAVR_DEBUG_ENABLED = '1';
    _resetRateLimitsForTest();
    writtenFiles = [];
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
    if (prev === undefined) delete process.env.STAVR_DEBUG_ENABLED;
    else process.env.STAVR_DEBUG_ENABLED = prev;
    for (const f of writtenFiles) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  });

  it('POST /debug/heap-snapshot returns 200 + a real .heapsnapshot file', async () => {
    const res = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; file: string; size_bytes: number };
    expect(body.ok).toBe(true);
    expect(body.file).toMatch(/\.heapsnapshot$/);
    expect(existsSync(body.file)).toBe(true);
    expect(statSync(body.file).size).toBe(body.size_bytes);
    writtenFiles.push(body.file);
  }, 15_000);

  it('POST /debug/cpu-profile?duration=1 returns 200 + a real .cpuprofile file', async () => {
    const res = await fetch(`${h.base}/debug/cpu-profile?duration=1`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; file: string; duration_seconds: number; size_bytes: number };
    expect(body.ok).toBe(true);
    expect(body.duration_seconds).toBe(1);
    expect(body.file).toMatch(/\.cpuprofile$/);
    expect(existsSync(body.file)).toBe(true);
    writtenFiles.push(body.file);
  }, 10_000);

  it('POST /debug/diagnostic-report returns 200 + a real report file', async () => {
    const res = await fetch(`${h.base}/debug/diagnostic-report`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; file: string; size_bytes: number };
    expect(body.ok).toBe(true);
    expect(existsSync(body.file)).toBe(true);
    writtenFiles.push(body.file);
  }, 10_000);

  it('rate-limits: second hit on the same endpoint within 1 minute returns 429', async () => {
    const first = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { file: string };
    writtenFiles.push(firstBody.file);
    const second = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { ok: boolean; error: string; retry_after_seconds: number };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after_seconds).toBe(60);
  }, 15_000);

  it('rate-limits are per-endpoint (heap-snapshot does not block cpu-profile)', async () => {
    const heap = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(heap.status).toBe(200);
    writtenFiles.push(((await heap.json()) as { file: string }).file);
    const cpu = await fetch(`${h.base}/debug/cpu-profile?duration=1`, { method: 'POST' });
    expect(cpu.status).toBe(200);
    writtenFiles.push(((await cpu.json()) as { file: string }).file);
  }, 15_000);
});

describe('debug endpoints — pure helpers', () => {
  it('isDebugEnabled honours "1" and "true"', () => {
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '1' })).toBe(true);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: 'true' })).toBe(true);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '' })).toBe(false);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: 'yes' })).toBe(false);
    expect(isDebugEnabled({})).toBe(false);
  });

  it('isLoopbackReq matches 127.0.0.1, ::1, ::ffff:127.0.0.1, and empty', () => {
    const mk = (remote: string) => ({ socket: { remoteAddress: remote } }) as Parameters<typeof isLoopbackReq>[0];
    expect(isLoopbackReq(mk('127.0.0.1'))).toBe(true);
    expect(isLoopbackReq(mk('::1'))).toBe(true);
    expect(isLoopbackReq(mk('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackReq(mk('localhost'))).toBe(true);
    expect(isLoopbackReq(mk(''))).toBe(true);
    expect(isLoopbackReq(mk('10.0.0.1'))).toBe(false);
    expect(isLoopbackReq(mk('192.168.1.5'))).toBe(false);
  });

  it('checkRateLimit allows once then blocks within the window, then allows after', () => {
    _resetRateLimitsForTest();
    let now = 1_000_000;
    expect(checkRateLimit('k', () => now)).toBe(true);
    now += 30_000;
    expect(checkRateLimit('k', () => now)).toBe(false);
    now += 31_000; // total 61s since first hit
    expect(checkRateLimit('k', () => now)).toBe(true);
  });
});
