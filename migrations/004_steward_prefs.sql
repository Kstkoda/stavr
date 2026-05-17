-- v0.5 P1 — Steward agent prefs.db schema.
-- ADR-032 §Decision 2: user-explicit preferences as flat KV. Reserved keys
-- consumed by other phases:
--   autonomy_mode      (P4) ∈ {reactive, scheduled, proactive}; default 'reactive'
--   pinned_runtime     (P2) string; default 'anthropic-opus'
--   default_profile    profile mode; default 'rapid'
--   cost_cap_daily_usd (P4 proactive guard) number; default 2.00
-- Schema is intentionally flat — prefs are trivially rebuildable from a backup.

CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
