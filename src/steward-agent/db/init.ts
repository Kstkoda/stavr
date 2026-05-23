// v0.5 P1 — Open the three Steward-agent SQLite stores, applying any pending
// migrations from migrations/00{2,3,4}_steward_*.sql exactly once per file.
//
// Each .db file maintains its own schema_migrations table — migrations don't
// cross files. memory.db only ever sees migration 002, lessons.db only 003,
// prefs.db only 004. Adding a 005_steward_memory_v2.sql later would apply to
// memory.db only, ignored by the other two.
//
// Mirrors the WAL + foreign_keys pragmas EventStore uses (src/persistence.ts).

import { openDatabase, type Database } from '../../db/index.js';
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../../log.js';
import {
  PREF_DEFAULTS,
  PREF_KEYS,
  type EpisodicLogRow,
  type LessonRow,
  type LessonStatus,
  type LessonOutcomeRow,
  type MemoryStore,
  type LessonsStore,
  type PrefsRow,
  type PrefsStore,
  type StewardDbBundle,
  type ArchivalMemoryRow,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
// Walk up from dist/steward-agent/db/ or src/steward-agent/db/ to repo root.
// Both layouts live three directories deep relative to ./migrations.
const REPO_ROOT_CANDIDATES = [
  resolve(here, '..', '..', '..'),
  resolve(here, '..', '..', '..', '..'),
];

function findMigrationsDir(): string {
  if (process.env.STAVR_MIGRATIONS_DIR) {
    const explicit = process.env.STAVR_MIGRATIONS_DIR;
    if (existsSync(explicit)) return explicit;
  }
  for (const root of REPO_ROOT_CANDIDATES) {
    const candidate = join(root, 'migrations');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`could not locate migrations/ directory from ${here}`);
}

interface MigrationFile {
  version: string;
  filename: string;
  path: string;
  sql: string;
}

function loadMigrationsMatching(prefix: string): MigrationFile[] {
  const dir = findMigrationsDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.sql') && f.includes(prefix),
  );
  files.sort();
  return files.map((filename) => {
    const path = join(dir, filename);
    const sql = readFileSync(path, 'utf8');
    // version = leading numeric prefix, e.g. "002" from "002_steward_memory.sql"
    const m = filename.match(/^(\d+)_/);
    const version = m ? m[1] : filename;
    return { version, filename, path, sql };
  });
}

/**
 * Apply one set of migration files to a single DB. Idempotent: records each
 * version in schema_migrations and skips on re-run.
 */
function applyMigrations(db: Database, migrations: MigrationFile[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const select = db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`);
  const insert = db.prepare(
    `INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)`,
  );
  for (const m of migrations) {
    if (select.get(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.filename, new Date().toISOString());
    })();
  }
}

function openWithPragmas(filePath: string): Database {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const db = openDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

function makeMemoryStore(db: Database): MemoryStore {
  const setWorkingStmt = db.prepare(
    `INSERT INTO working_memory (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const getWorkingStmt = db.prepare(`SELECT value_json FROM working_memory WHERE key = ?`);
  const listWorkingStmt = db.prepare(`SELECT key FROM working_memory ORDER BY key`);
  const appendEpStmt = db.prepare(
    `INSERT INTO episodic_log (at, kind, correlation_id, payload_json) VALUES (?, ?, ?, ?)`,
  );
  const epSinceCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM episodic_log WHERE seq > ?`);
  const epSinceReadStmt = db.prepare(
    `SELECT seq, at, kind, correlation_id, payload_json FROM episodic_log WHERE seq > ? ORDER BY seq ASC`,
  );
  const epLatestStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM episodic_log`);
  const insertArchStmt = db.prepare(
    `INSERT INTO archival_memory (id, embedding, content, source, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const countArchStmt = db.prepare(`SELECT COUNT(*) AS n FROM archival_memory`);

  return {
    db,
    getWorking(key) {
      const row = getWorkingStmt.get(key) as { value_json: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value_json);
      } catch {
        return undefined;
      }
    },
    setWorking(key, value) {
      setWorkingStmt.run(key, JSON.stringify(value), new Date().toISOString());
    },
    listWorkingKeys() {
      return (listWorkingStmt.all() as Array<{ key: string }>).map((r) => r.key);
    },
    appendEpisodic(entry) {
      const at = entry.at ?? new Date().toISOString();
      const info = appendEpStmt.run(
        at,
        entry.kind,
        entry.correlation_id ?? null,
        JSON.stringify(entry.payload),
      );
      return Number(info.lastInsertRowid);
    },
    episodicCountSince(seq) {
      const row = epSinceCountStmt.get(seq) as { n: number };
      return row.n;
    },
    readEpisodicSince(seq) {
      return epSinceReadStmt.all(seq) as EpisodicLogRow[];
    },
    latestEpisodicSeq() {
      const row = epLatestStmt.get() as { s: number };
      return row.s;
    },
    insertArchival(row) {
      insertArchStmt.run(
        row.id,
        row.embedding ?? null,
        row.content,
        row.source,
        row.created_at ?? new Date().toISOString(),
      );
    },
    countArchival() {
      const row = countArchStmt.get() as { n: number };
      return row.n;
    },
  } satisfies MemoryStore;
}

function makeLessonsStore(db: Database): LessonsStore {
  const insertStmt = db.prepare(
    `INSERT INTO lessons (id, title, body, source, distilled_from_json, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateStatusStmt = db.prepare(`UPDATE lessons SET status = ? WHERE id = ?`);
  const listActiveStmt = db.prepare(
    `SELECT id, title, body, source, distilled_from_json, created_at, status
     FROM lessons WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`,
  );
  const insertOutcomeStmt = db.prepare(
    `INSERT OR REPLACE INTO lesson_outcomes (lesson_id, bom_id, applied_at, outcome, delta_cost_usd)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM lessons`);

  return {
    db,
    insertLesson(row) {
      insertStmt.run(
        row.id,
        row.title,
        row.body,
        row.source,
        row.distilled_from_json ?? '[]',
        row.created_at ?? new Date().toISOString(),
        row.status,
      );
    },
    updateStatus(id, status: LessonStatus) {
      updateStatusStmt.run(status, id);
    },
    listActive(limit = 100) {
      return listActiveStmt.all(limit) as LessonRow[];
    },
    recordOutcome(row: LessonOutcomeRow) {
      insertOutcomeStmt.run(
        row.lesson_id,
        row.bom_id,
        row.applied_at,
        row.outcome,
        row.delta_cost_usd ?? null,
      );
    },
    count() {
      const r = countStmt.get() as { n: number };
      return r.n;
    },
  } satisfies LessonsStore;
}

function makePrefsStore(db: Database): PrefsStore {
  const getStmt = db.prepare(`SELECT value_json FROM prefs WHERE key = ?`);
  const setStmt = db.prepare(
    `INSERT INTO prefs (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const allStmt = db.prepare(`SELECT key, value_json, updated_at FROM prefs ORDER BY key`);

  return {
    db,
    get<T>(key: string): T | undefined {
      const row = getStmt.get(key) as { value_json: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value_json) as T;
      } catch {
        return undefined;
      }
    },
    getOrDefault<T>(key: string): T {
      const v = this.get<T>(key);
      if (v !== undefined) return v;
      return PREF_DEFAULTS[key] as T;
    },
    set(key, value) {
      setStmt.run(key, JSON.stringify(value), new Date().toISOString());
    },
    all() {
      return allStmt.all() as PrefsRow[];
    },
  } satisfies PrefsStore;
}

export interface OpenStewardDbsOpts {
  /** Override the default ~/.stavr/steward/ root. Tests pass a tmp dir. */
  stewardHome?: string;
  /** Use :memory: for any/all stores. Tests only. */
  inMemory?: boolean;
}

/**
 * Open all three Steward-agent stores, applying any pending migrations.
 * Returns a bundle with the three handle objects and a close() callback.
 *
 * Re-open is a no-op for migrations (schema_migrations table tracks state).
 */
export function openStewardDbs(stavrHome: string, opts: OpenStewardDbsOpts = {}): StewardDbBundle {
  const stewardHome = opts.stewardHome ?? join(stavrHome, 'steward');
  if (!opts.inMemory) mkdirSync(stewardHome, { recursive: true });

  const memoryPath = opts.inMemory ? ':memory:' : join(stewardHome, 'memory.db');
  const lessonsPath = opts.inMemory ? ':memory:' : join(stewardHome, 'lessons.db');
  const prefsPath = opts.inMemory ? ':memory:' : join(stewardHome, 'prefs.db');

  const memoryDb = openWithPragmas(memoryPath);
  const lessonsDb = openWithPragmas(lessonsPath);
  const prefsDb = openWithPragmas(prefsPath);

  applyMigrations(memoryDb, loadMigrationsMatching('_steward_memory'));
  applyMigrations(lessonsDb, loadMigrationsMatching('_steward_lessons'));
  applyMigrations(prefsDb, loadMigrationsMatching('_steward_prefs'));

  let closed = false;
  return {
    memory: makeMemoryStore(memoryDb),
    lessons: makeLessonsStore(lessonsDb),
    prefs: makePrefsStore(prefsDb),
    stewardHome,
    close() {
      if (closed) return;
      closed = true;
      try { memoryDb.close(); } catch { /* already closed */ }
      try { lessonsDb.close(); } catch { /* already closed */ }
      try { prefsDb.close(); } catch { /* already closed */ }
    },
  };
}

// --- Snapshot / restore (stubs for ADR-032 §Decision 6 — P3 will exercise) ---

/** Predicate gating the snapshot trigger. */
export function snapshotDue(opts: {
  episodicSinceSnapshot: number;
  lastSnapshotAt: Date | null;
  now?: Date;
  entryThreshold?: number;
  intervalMs?: number;
}): boolean {
  const entryThreshold = opts.entryThreshold ?? 1000;
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  if (opts.episodicSinceSnapshot >= entryThreshold) return true;
  if (!opts.lastSnapshotAt) return false;
  const now = opts.now ?? new Date();
  return now.getTime() - opts.lastSnapshotAt.getTime() >= intervalMs;
}

export interface StewardSnapshot {
  taken_at: string;
  latest_episodic_seq: number;
  working_memory: Record<string, unknown>;
  active_bom_ids: string[];
}

/**
 * Write a snapshot to ~/.stavr/steward/snapshots/{ts}.json. The reciprocal
 * restore call lives in src/steward-agent/main.ts (P3) so the spawner can
 * read the latest snapshot at cold start.
 */
export function takeSnapshot(
  bundle: StewardDbBundle,
  activeBomIds: string[],
  opts: { now?: Date } = {},
): { path: string; snapshot: StewardSnapshot } {
  const taken_at = (opts.now ?? new Date()).toISOString();
  const workingKeys = bundle.memory.listWorkingKeys();
  const working_memory: Record<string, unknown> = {};
  for (const k of workingKeys) working_memory[k] = bundle.memory.getWorking(k);
  const snapshot: StewardSnapshot = {
    taken_at,
    latest_episodic_seq: bundle.memory.latestEpisodicSeq(),
    working_memory,
    active_bom_ids: [...activeBomIds],
  };
  const snapshotsDir = join(bundle.stewardHome, 'snapshots');
  mkdirSync(snapshotsDir, { recursive: true });
  const safeTs = taken_at.replace(/[:.]/g, '-');
  const path = join(snapshotsDir, `${safeTs}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
  return { path, snapshot };
}

/** Find the newest snapshot file by mtime; return null if none. */
export function findLatestSnapshot(stewardHome: string): { path: string; snapshot: StewardSnapshot } | null {
  const snapshotsDir = join(stewardHome, 'snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const files = readdirSync(snapshotsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = join(snapshotsDir, f);
      return { path: p, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  const newest = files[0];
  try {
    const raw = readFileSync(newest.path, 'utf8');
    return { path: newest.path, snapshot: JSON.parse(raw) as StewardSnapshot };
  } catch (err) {
    getLogger().warn('failed to parse steward snapshot; ignoring', {
      path: newest.path,
      error: (err as Error).message,
    });
    return null;
  }
}

// Re-export for convenience.
export { PREF_KEYS, PREF_DEFAULTS };
