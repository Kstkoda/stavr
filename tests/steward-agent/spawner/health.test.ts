import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStewardDbs } from '../../../src/steward-agent/db/init.js';
import { snapshotStewardHealth } from '../../../src/dashboard/data/steward-health.js';
import { PREF_KEYS } from '../../../src/steward-agent/db/types.js';

describe('v0.5 P3 — steward-health snapshot', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'stavr-p3-h-')); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('returns unwired/null when no spawner present', () => {
    const bundle = openStewardDbs(home);
    try {
      const snap = snapshotStewardHealth({ bundle });
      expect(snap.status).toBe('unwired');
      expect(snap.pid).toBeNull();
      expect(snap.last_heartbeat_at).toBeNull();
      expect(snap.autonomy_mode).toBe('reactive');
      expect(snap.lessons_count).toBe(0);
      expect(snap.memory_working_keys).toBe(0);
    } finally { bundle.close(); }
  });

  it('reflects current store state', () => {
    const bundle = openStewardDbs(home);
    try {
      bundle.prefs.set(PREF_KEYS.AUTONOMY_MODE, 'scheduled');
      bundle.lessons.insertLesson({
        id: 'L1', title: 't', body: 'b', source: 's', distilled_from_json: '[]', status: 'active',
      });
      bundle.memory.setWorking('k1', 1);
      bundle.memory.setWorking('k2', 2);
      const snap = snapshotStewardHealth({ bundle });
      expect(snap.autonomy_mode).toBe('scheduled');
      expect(snap.lessons_count).toBe(1);
      expect(snap.memory_working_keys).toBe(2);
    } finally { bundle.close(); }
  });

  it('returns pid/status/heartbeat from a fake spawned handle', () => {
    const fakeSpawned = {
      pid: 12345,
      status: () => 'up' as const,
      lastHeartbeatAt: () => '2026-05-17T13:00:00.000Z',
      requestPlan: async () => ({}),
      onEvent: () => () => {},
      shutdown: async () => {},
    };
    const snap = snapshotStewardHealth({ spawned: fakeSpawned });
    expect(snap.pid).toBe(12345);
    expect(snap.status).toBe('up');
    expect(snap.last_heartbeat_at).toBe('2026-05-17T13:00:00.000Z');
  });
});
