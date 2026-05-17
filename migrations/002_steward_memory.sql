-- v0.5 P1 — Steward agent memory.db schema.
-- ADR-032 §Decision 2: Letta/MemGPT-style tiers for working / archival / episodic memory.
-- This file is the sole initializer for ~/.stavr/steward/memory.db.
-- Applied by src/steward-agent/db/init.ts:applyMigrations() via the per-db
-- schema_migrations table (one row per applied file).

-- Hot context the planner sees on every call. Bounded by callers to <4KB total
-- across rows; eviction is the planner's responsibility, not the store's.
CREATE TABLE IF NOT EXISTS working_memory (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Opaque blob store for distilled context. embedding column nullable because
-- v0.5 ships without embeddings; v0.6 adds vector recall.
CREATE TABLE IF NOT EXISTS archival_memory (
  id TEXT PRIMARY KEY,
  embedding BLOB,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archival_memory_source ON archival_memory(source);
CREATE INDEX IF NOT EXISTS idx_archival_memory_created ON archival_memory(created_at);

-- Every BOM step's outcome lands here. Drives snapshot trigger (ADR-032 §Decision 6):
-- snapshot every 1000 entries OR every 5 minutes, whichever comes first.
CREATE TABLE IF NOT EXISTS episodic_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodic_log_at ON episodic_log(at);
CREATE INDEX IF NOT EXISTS idx_episodic_log_kind ON episodic_log(kind);
CREATE INDEX IF NOT EXISTS idx_episodic_log_correlation ON episodic_log(correlation_id);
