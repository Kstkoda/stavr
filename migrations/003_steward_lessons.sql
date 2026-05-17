-- v0.5 P1 — Steward agent lessons.db schema.
-- ADR-032 §Decision 7: distilled patterns from outcome / user / self-critique feedback.
-- Auto-demotion query (ADR-032 §Consequences): lessons with low outcome_rate get
-- their status flipped to 'demoted'; archived lessons are kept for audit.

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  distilled_from_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'demoted', 'archived'))
);

-- Prompt-injection path queries this index repeatedly: every plan() call asks
-- for active lessons ordered by recency.
CREATE INDEX IF NOT EXISTS idx_lessons_status_created ON lessons(status, created_at);
CREATE INDEX IF NOT EXISTS idx_lessons_source ON lessons(source);

-- One row per (lesson, BOM) where the lesson was applied. delta_cost_usd may be
-- negative when a lesson reduced spend vs the baseline planner. The
-- auto-demotion job groups by lesson_id and flips status='demoted' when the
-- aggregate is consistently negative or null-outcome.
CREATE TABLE IF NOT EXISTS lesson_outcomes (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  bom_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  delta_cost_usd REAL,
  PRIMARY KEY (lesson_id, bom_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_outcomes_lesson ON lesson_outcomes(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_outcomes_applied ON lesson_outcomes(applied_at);
