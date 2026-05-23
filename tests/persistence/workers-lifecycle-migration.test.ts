/**
 * tests/persistence/workers-lifecycle-migration.test.ts
 *
 * BOM v0.6.6 P1 — migration smoke test for the additive lifecycle_state
 * column on the workers table.
 *
 * The migration runs as part of EventStore.init() against pre-existing
 * on-disk DBs (idempotent: PRAGMA probe then ALTER TABLE if missing).
 * For fresh DBs the column is part of CREATE TABLE. Both paths must
 * agree, and re-running init() must not throw on the existing column.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { EventStore } from '../../src/persistence.js';

function tmp(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'stavr-workers-migration-'));
  const dbPath = join(dir, 'events.db');
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('workers.lifecycle_state additive migration', () => {
  it('fresh DB has lifecycle_state in workers table schema', () => {
    const { dbPath, cleanup } = tmp();
    const store = new EventStore();
    try {
      store.init(dbPath);
      const db = openDatabase(dbPath);
      const cols = db.prepare(`PRAGMA table_info(workers)`).all() as Array<{ name: string }>;
      db.close();
      const names = cols.map((c) => c.name);
      expect(names).toContain('lifecycle_state');
    } finally {
      store.close();
      cleanup();
    }
  });

  it('upgrades a pre-existing workers table (column missing)', () => {
    const { dbPath, cleanup } = tmp();
    let store: EventStore | undefined;
    try {
      // Build a pre-migration workers table by hand to simulate an older
      // on-disk DB. This is the v0.6.5 schema (no lifecycle_state).
      const old = openDatabase(dbPath);
      old.exec(`
        CREATE TABLE workers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          cwd TEXT NOT NULL,
          pid INTEGER,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          last_activity_at TEXT,
          metadata_json TEXT NOT NULL,
          spawn_params_hash TEXT NOT NULL,
          termination_reason TEXT,
          exit_code INTEGER
        );
      `);
      old.prepare(
        `INSERT INTO workers
         (id,name,type,cwd,status,started_at,metadata_json,spawn_params_hash)
         VALUES ('w1','legacy','shell','/tmp','terminated','2026-05-15T00:00:00Z','{}','h')`,
      ).run();
      old.close();

      // Run init — the migration block should ALTER TABLE ADD COLUMN.
      store = new EventStore();
      store.init(dbPath);

      const db = openDatabase(dbPath);
      const cols = db.prepare(`PRAGMA table_info(workers)`).all() as Array<{ name: string }>;
      const legacy = db.prepare(`SELECT id, lifecycle_state FROM workers WHERE id='w1'`).get() as {
        id: string;
        lifecycle_state: string | null;
      };
      db.close();

      const names = cols.map((c) => c.name);
      expect(names).toContain('lifecycle_state');
      // Backfill is intentionally NULL — derivation handles it on read.
      expect(legacy.lifecycle_state).toBeNull();
    } finally {
      store?.close();
      cleanup();
    }
  });

  it('init() is idempotent — running twice does not throw', () => {
    const { dbPath, cleanup } = tmp();
    const s1 = new EventStore();
    const s2 = new EventStore();
    try {
      s1.init(dbPath);
      s1.close();
      expect(() => s2.init(dbPath)).not.toThrow();
    } finally {
      s2.close();
      cleanup();
    }
  });
});
