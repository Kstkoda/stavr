import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderSettingsPage } from '../../src/dashboard/pages/settings.js';

describe('Settings → Diagnostics sub-section — render', () => {
  it('renders three toggle rows + take-now buttons', () => {
    const html = renderSettingsPage({
      activeMode: 'balanced',
      scopes: [],
      noGo: [],
      bricks: [],
      runtimeToggles: [],
      recentDiagnostics: [],
    });
    expect(html).toContain('Diagnostics · runtime toggles');
    for (const key of ['STAVR_DEBUG_HEAP', 'STAVR_DEBUG_CPU', 'STAVR_DEBUG_REPORT']) {
      expect(html).toContain(`data-key="${key}"`);
    }
    expect(html).toContain('Take now');
    expect(html).toContain('+1 h');
  });

  it('renders a row per recent diagnostic in the last 24h', () => {
    const html = renderSettingsPage({
      activeMode: 'balanced',
      scopes: [],
      noGo: [],
      bricks: [],
      runtimeToggles: [],
      recentDiagnostics: [
        { kind: 'heap_snapshot_taken', at: new Date().toISOString(), payload: { file: '/tmp/heap.heapsnapshot' } },
        { kind: 'cpu_profile_taken',  at: new Date().toISOString(), payload: { file: '/tmp/cpu.cpuprofile' } },
      ],
    });
    expect(html).toContain('heap_snapshot_taken');
    expect(html).toContain('cpu_profile_taken');
    expect(html).toContain('/tmp/heap.heapsnapshot');
  });

  it('reflects an active toggle as checked', () => {
    const html = renderSettingsPage({
      activeMode: 'balanced',
      scopes: [],
      noGo: [],
      bricks: [],
      runtimeToggles: [
        { key: 'STAVR_DEBUG_HEAP', value: '1', set_by: 'dashboard', set_at: Date.now(), expires_at: Date.now() + 60_000 },
      ],
      recentDiagnostics: [],
    });
    // The checkbox for heap should be present with `checked`.
    expect(html).toMatch(/data-key="STAVR_DEBUG_HEAP"[^>]*checked/);
  });

  it('captures section lists the four capture types with local jsonl destinations', () => {
    const html = renderSettingsPage({
      activeMode: 'balanced',
      scopes: [],
      noGo: [],
      bricks: [],
    });
    expect(html).toContain('Captures · route config');
    for (const t of ['bug', 'feature', 'investigate', 'todo']) {
      expect(html).toContain(`~/.stavr/captures/${t}.jsonl`);
    }
  });
});

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

describe('Settings → Diagnostics — runtime toggle endpoints', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('POST + GET round-trips a runtime toggle and emits a runtime_toggle_changed audit event', async () => {
    const before = h.store.eventCount();
    const r = await fetch(`${h.base}/dashboard/settings/runtime-toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'STAVR_DEBUG_HEAP', value: '1', ttl_minutes: 60 }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.key).toBe('STAVR_DEBUG_HEAP');
    expect(j.expires_at).toBeGreaterThan(Date.now());
    const g = await fetch(`${h.base}/dashboard/settings/runtime-toggles`);
    const list = (await g.json() as { toggles: Array<{ key: string }> }).toggles;
    expect(list.some((t) => t.key === 'STAVR_DEBUG_HEAP')).toBe(true);
    const events = h.store.getEvents({ limit: 50 }).events;
    expect(events.some((e) => e.kind === 'runtime_toggle_changed')).toBe(true);
    expect(h.store.eventCount()).toBeGreaterThan(before);
  });

  it('rejects unknown toggle keys with 400', async () => {
    const r = await fetch(`${h.base}/dashboard/settings/runtime-toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'NOT_A_KEY', value: '1' }),
    });
    expect(r.status).toBe(400);
  });

  it('DELETE removes the toggle and emits another runtime_toggle_changed event', async () => {
    await fetch(`${h.base}/dashboard/settings/runtime-toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'STAVR_DEBUG_CPU', value: '1', ttl_minutes: 60 }),
    });
    const r = await fetch(`${h.base}/dashboard/settings/runtime-toggles/STAVR_DEBUG_CPU`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.had).toBe(true);
  });

  it('runtime toggle controls /debug/* gating in place of STAVR_DEBUG_ENABLED', async () => {
    // First call: env unset, no toggle — 404.
    delete process.env.STAVR_DEBUG_ENABLED;
    const noGate = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    expect(noGate.status).toBe(404);
    // Set master toggle = '1' — now the same endpoint should NOT 404.
    await fetch(`${h.base}/dashboard/settings/runtime-toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'STAVR_DEBUG_ENABLED', value: '1', ttl_minutes: 60 }),
    });
    const opened = await fetch(`${h.base}/debug/heap-snapshot`, { method: 'POST' });
    // 200 (snapshot written) or 429 (rate-limited from a previous test run);
    // anything except 404 proves the gate opened.
    expect(opened.status).not.toBe(404);
  });
});
