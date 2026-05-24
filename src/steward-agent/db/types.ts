// v0.5 P1 — Steward-agent state store types.
//
// One TypeScript interface per logical store. The actual SQLite handles are
// returned by openStewardDbs() in ./init.ts via the persistence port. Methods
// here are intentionally
// minimal — only what other phases of v0.5 BOM consume; richer queries can be
// added without changing the file's shape.

import type { Database } from '../../db/index.js';

/** Letta/MemGPT-style hot context — bounded; planner is the eviction policy. */
export interface WorkingMemoryRow {
  key: string;
  value_json: string;
  updated_at: string;
}

/** Distilled blobs surfaced into planner context on demand. */
export interface ArchivalMemoryRow {
  id: string;
  embedding: Buffer | null;
  content: string;
  source: string;
  created_at: string;
}

/** Append-only outcome log. Drives snapshot trigger + parity diffing. */
export interface EpisodicLogRow {
  seq: number;
  at: string;
  kind: string;
  correlation_id: string | null;
  payload_json: string;
}

export type LessonStatus = 'active' | 'demoted' | 'archived';

export interface LessonRow {
  id: string;
  title: string;
  body: string;
  source: string;
  distilled_from_json: string;
  created_at: string;
  status: LessonStatus;
}

export interface LessonOutcomeRow {
  lesson_id: string;
  bom_id: string;
  applied_at: string;
  outcome: string;
  delta_cost_usd: number | null;
}

export interface PrefsRow {
  key: string;
  value_json: string;
  updated_at: string;
}

/**
 * Reserved pref keys with their default value shapes. Pref values are stored
 * as JSON-encoded strings; callers parse on read. Lazily initialized — the
 * key only exists in the table after the first explicit set().
 */
export const PREF_KEYS = {
  AUTONOMY_MODE: 'autonomy_mode',
  PINNED_RUNTIME: 'pinned_runtime',
  DEFAULT_PROFILE: 'default_profile',
  COST_CAP_DAILY_USD: 'cost_cap_daily_usd',
  TASK_RUNTIME_OVERRIDES: 'task_runtime_overrides_json',
} as const;

export const PREF_DEFAULTS: Record<string, unknown> = {
  [PREF_KEYS.AUTONOMY_MODE]: 'reactive',
  [PREF_KEYS.PINNED_RUNTIME]: 'anthropic-opus',
  [PREF_KEYS.DEFAULT_PROFILE]: 'rapid',
  [PREF_KEYS.COST_CAP_DAILY_USD]: 2.0,
  [PREF_KEYS.TASK_RUNTIME_OVERRIDES]: {},
};

/**
 * Memory store API. Operates on memory.db only. Calls below are sync because
 * The SQLite engine is sync; the surrounding loop wraps writes in microtask yields
 * only where bursty episodic writes would otherwise pin the event loop.
 */
export interface MemoryStore {
  db: Database;
  getWorking(key: string): unknown | undefined;
  setWorking(key: string, value: unknown): void;
  listWorkingKeys(): string[];
  appendEpisodic(entry: { kind: string; correlation_id?: string; payload: unknown; at?: string }): number;
  episodicCountSince(seq: number): number;
  readEpisodicSince(seq: number): EpisodicLogRow[];
  latestEpisodicSeq(): number;
  insertArchival(row: Omit<ArchivalMemoryRow, 'created_at'> & { created_at?: string }): void;
  countArchival(): number;
}

export interface LessonsStore {
  db: Database;
  insertLesson(row: Omit<LessonRow, 'created_at'> & { created_at?: string }): void;
  updateStatus(id: string, status: LessonStatus): void;
  listActive(limit?: number): LessonRow[];
  recordOutcome(row: LessonOutcomeRow): void;
  count(): number;
}

export interface PrefsStore {
  db: Database;
  get<T = unknown>(key: string): T | undefined;
  getOrDefault<T = unknown>(key: string): T;
  set(key: string, value: unknown): void;
  all(): PrefsRow[];
}

export interface StewardDbBundle {
  memory: MemoryStore;
  lessons: LessonsStore;
  prefs: PrefsStore;
  /** Where the three files live; useful for snapshot writer. */
  stewardHome: string;
  /** Close all three handles. Idempotent. */
  close(): void;
}
