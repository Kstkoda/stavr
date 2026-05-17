import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openStewardDbs,
  snapshotDue,
  takeSnapshot,
  findLatestSnapshot,
} from '../../../src/steward-agent/db/init.js';
import { PREF_KEYS } from '../../../src/steward-agent/db/types.js';

describe('v0.5 P1 — steward-agent state stores', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stavr-p1-'));
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('opens all three db files at ~/.stavr/steward/', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      expect(existsSync(join(tmpHome, 'steward', 'memory.db'))).toBe(true);
      expect(existsSync(join(tmpHome, 'steward', 'lessons.db'))).toBe(true);
      expect(existsSync(join(tmpHome, 'steward', 'prefs.db'))).toBe(true);
    } finally {
      bundle.close();
    }
  });

  it('applies migrations exactly once across re-opens', () => {
    const b1 = openStewardDbs(tmpHome);
    const initialApplied = b1.memory.db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations`)
      .get() as { n: number };
    expect(initialApplied.n).toBe(1);
    b1.close();

    const b2 = openStewardDbs(tmpHome);
    const reApplied = b2.memory.db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations`)
      .get() as { n: number };
    expect(reApplied.n).toBe(1); // no double-apply
    b2.close();
  });

  it('memory.db schema includes working_memory / archival_memory / episodic_log', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      const tables = bundle.memory.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('working_memory');
      expect(names).toContain('archival_memory');
      expect(names).toContain('episodic_log');
    } finally {
      bundle.close();
    }
  });

  it('lessons.db schema includes lessons + lesson_outcomes with status check', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      const tables = bundle.lessons.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('lessons');
      expect(names).toContain('lesson_outcomes');

      // Status CHECK enforces enum
      expect(() =>
        bundle.lessons.db
          .prepare(
            `INSERT INTO lessons (id, title, body, source, distilled_from_json, created_at, status)
             VALUES (?, ?, ?, ?, '[]', ?, ?)`,
          )
          .run('bad', 't', 'b', 's', new Date().toISOString(), 'invalid'),
      ).toThrow();
    } finally {
      bundle.close();
    }
  });

  it('WAL journal mode confirmed on all three handles', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      for (const db of [bundle.memory.db, bundle.lessons.db, bundle.prefs.db]) {
        const mode = db.pragma('journal_mode', { simple: true });
        expect(mode).toBe('wal');
      }
    } finally {
      bundle.close();
    }
  });

  it('working memory get/set round-trips JSON', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      bundle.memory.setWorking('foo', { a: 1, b: [2, 3] });
      expect(bundle.memory.getWorking('foo')).toEqual({ a: 1, b: [2, 3] });
      expect(bundle.memory.listWorkingKeys()).toEqual(['foo']);
    } finally {
      bundle.close();
    }
  });

  it('episodic_log autoincrements seq + readEpisodicSince filters correctly', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      const s1 = bundle.memory.appendEpisodic({ kind: 'a', payload: { i: 1 } });
      const s2 = bundle.memory.appendEpisodic({ kind: 'a', payload: { i: 2 } });
      const s3 = bundle.memory.appendEpisodic({ kind: 'b', payload: { i: 3 } });
      expect(s2).toBe(s1 + 1);
      expect(s3).toBe(s2 + 1);

      const since1 = bundle.memory.readEpisodicSince(s1);
      expect(since1).toHaveLength(2);
      expect(since1.map((r) => r.kind)).toEqual(['a', 'b']);

      expect(bundle.memory.episodicCountSince(s1)).toBe(2);
      expect(bundle.memory.latestEpisodicSeq()).toBe(s3);
    } finally {
      bundle.close();
    }
  });

  it('prefs default to PREF_DEFAULTS when unset, persist when set', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      expect(bundle.prefs.get(PREF_KEYS.AUTONOMY_MODE)).toBeUndefined();
      expect(bundle.prefs.getOrDefault(PREF_KEYS.AUTONOMY_MODE)).toBe('reactive');
      expect(bundle.prefs.getOrDefault(PREF_KEYS.COST_CAP_DAILY_USD)).toBe(2.0);

      bundle.prefs.set(PREF_KEYS.AUTONOMY_MODE, 'scheduled');
      expect(bundle.prefs.get(PREF_KEYS.AUTONOMY_MODE)).toBe('scheduled');
      expect(bundle.prefs.getOrDefault(PREF_KEYS.AUTONOMY_MODE)).toBe('scheduled');
    } finally {
      bundle.close();
    }
  });

  it('snapshotDue triggers on entry threshold OR time elapsed', () => {
    expect(snapshotDue({ episodicSinceSnapshot: 0, lastSnapshotAt: null })).toBe(false);
    expect(snapshotDue({ episodicSinceSnapshot: 1000, lastSnapshotAt: null })).toBe(true);
    expect(snapshotDue({ episodicSinceSnapshot: 999, lastSnapshotAt: null })).toBe(false);

    const past = new Date(Date.now() - 6 * 60 * 1000);
    expect(snapshotDue({ episodicSinceSnapshot: 0, lastSnapshotAt: past })).toBe(true);

    const recent = new Date(Date.now() - 30 * 1000);
    expect(snapshotDue({ episodicSinceSnapshot: 0, lastSnapshotAt: recent })).toBe(false);
  });

  it('takeSnapshot writes JSON to snapshots/ and findLatestSnapshot recovers it', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      bundle.memory.setWorking('k1', { hello: 'world' });
      bundle.memory.appendEpisodic({ kind: 'bom_step_done', payload: { x: 1 } });
      const { path, snapshot } = takeSnapshot(bundle, ['bom-1', 'bom-2']);
      expect(existsSync(path)).toBe(true);
      expect(snapshot.working_memory).toEqual({ k1: { hello: 'world' } });
      expect(snapshot.active_bom_ids).toEqual(['bom-1', 'bom-2']);
      expect(snapshot.latest_episodic_seq).toBeGreaterThan(0);

      const found = findLatestSnapshot(bundle.stewardHome);
      expect(found).not.toBeNull();
      expect(found!.snapshot.active_bom_ids).toEqual(['bom-1', 'bom-2']);
    } finally {
      bundle.close();
    }
  });

  it('findLatestSnapshot returns null when no snapshots exist', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      expect(findLatestSnapshot(bundle.stewardHome)).toBeNull();
    } finally {
      bundle.close();
    }
  });

  it('lessons store insert / listActive / status update', () => {
    const bundle = openStewardDbs(tmpHome);
    try {
      bundle.lessons.insertLesson({
        id: 'L1',
        title: 'avoid wide rebases',
        body: 'rebases on top of >50 commits surface conflicts that should be merges',
        source: 'self-critique',
        distilled_from_json: JSON.stringify(['bom-x', 'bom-y']),
        status: 'active',
      });
      bundle.lessons.insertLesson({
        id: 'L2',
        title: 'demoted lesson',
        body: '...',
        source: 'user',
        distilled_from_json: '[]',
        status: 'demoted',
      });
      expect(bundle.lessons.count()).toBe(2);
      const active = bundle.lessons.listActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('L1');

      bundle.lessons.recordOutcome({
        lesson_id: 'L1',
        bom_id: 'bom-z',
        applied_at: new Date().toISOString(),
        outcome: 'success',
        delta_cost_usd: -0.12,
      });

      bundle.lessons.updateStatus('L1', 'archived');
      expect(bundle.lessons.listActive()).toHaveLength(0);
    } finally {
      bundle.close();
    }
  });
});
