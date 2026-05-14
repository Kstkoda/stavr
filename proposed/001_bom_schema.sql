-- 001_bom_schema.sql
-- Schema for Bill of Materials (BOM) — the steward's planning artifacts.
-- Idempotent: safe to run on existing databases. Land via src/persistence.ts after the existing CREATE TABLE statements.

-- =============================================================
-- BOMS: top-level plan documents
-- =============================================================

CREATE TABLE IF NOT EXISTS boms (
  -- Identity
  id              TEXT PRIMARY KEY,                  -- bom_<uuid>
  goal            TEXT NOT NULL,                     -- plain-English goal from the requester
  requester       TEXT NOT NULL,                     -- session_id or worker_id that asked for the plan
  correlation_id  TEXT NOT NULL,                     -- correlate with originating chat session
  -- Status lifecycle: proposed -> approved -> running -> done | failed | cancelled
  -- Or: proposed -> rejected
  -- Re-plans create a new bom_version, status returns to "proposed" with a parent_version_id
  status          TEXT NOT NULL CHECK (status IN ('proposed','approved','running','done','failed','cancelled','rejected')),
  -- Active version pointer
  active_version  INTEGER NOT NULL DEFAULT 1,
  -- Estimates (sum across steps in the active version)
  cost_estimate   REAL NOT NULL DEFAULT 0,            -- USD
  cost_max        REAL NOT NULL DEFAULT 0,            -- worst-case (all steps promote)
  duration_sec    INTEGER NOT NULL DEFAULT 0,         -- estimated wall-clock seconds
  -- Actuals (filled in as steps run)
  cost_actual     REAL NOT NULL DEFAULT 0,
  steps_done      INTEGER NOT NULL DEFAULT 0,
  steps_total     INTEGER NOT NULL DEFAULT 0,
  -- Profile + mode context at time of proposal
  profile_mode    TEXT NOT NULL DEFAULT 'balanced',   -- turbo | balanced | eco
  -- Trust scope created when this BOM was approved (NULL until approved)
  scope_id        TEXT,
  -- Risk envelope = union of step risk classes (cached for queries)
  risk_envelope   TEXT NOT NULL DEFAULT '[]',         -- JSON array of risk class strings
  -- Timestamps
  proposed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at     TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  -- Soft delete / draft persistence
  is_draft        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_boms_status ON boms(status);
CREATE INDEX IF NOT EXISTS idx_boms_requester ON boms(requester);
CREATE INDEX IF NOT EXISTS idx_boms_correlation ON boms(correlation_id);
CREATE INDEX IF NOT EXISTS idx_boms_scope ON boms(scope_id);
CREATE INDEX IF NOT EXISTS idx_boms_proposed_at ON boms(proposed_at);

-- =============================================================
-- BOM_VERSIONS: history of every (re)plan
-- =============================================================

CREATE TABLE IF NOT EXISTS bom_versions (
  bom_id          TEXT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  -- Why this version exists: 'initial' | 'replan_on_failure' | 'manual_edit' | 'capability_escalation'
  reason          TEXT NOT NULL,
  -- If replan, which step failed (NULL for initial)
  replan_trigger_step INTEGER,
  -- Snapshot of step list at this version (denormalized for replay)
  steps_json      TEXT NOT NULL,
  -- Planner model that produced this version
  planner_model   TEXT NOT NULL,
  planner_cost    REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bom_id, version)
);

-- =============================================================
-- BOM_STEPS: individual planned actions for the active version
-- =============================================================

CREATE TABLE IF NOT EXISTS bom_steps (
  bom_id          TEXT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  step_no         INTEGER NOT NULL,                  -- 1-indexed position in the plan
  -- What this step does
  title           TEXT NOT NULL,                     -- short human-readable
  description     TEXT,                              -- longer detail
  capability      TEXT NOT NULL,                     -- one of CapabilityTag (see types.ts)
  risk_class      TEXT NOT NULL,                     -- one of RiskClass (see types.ts)
  -- Which connector / brick handles this step (FK by id, soft reference)
  brick_id        TEXT,                              -- e.g. 'files', 'github', 'wiser', or NULL for steward-internal
  -- Model assignment for this step
  model           TEXT NOT NULL,                     -- e.g. 'claude-opus-4.8', 'llama-3.1-70b'
  -- Step-level status: pending -> running -> done | failed | skipped
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  -- Estimates
  cost_estimate   REAL NOT NULL DEFAULT 0,
  duration_sec_est INTEGER NOT NULL DEFAULT 0,
  -- Actuals
  cost_actual     REAL NOT NULL DEFAULT 0,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  -- Dependencies (JSON array of step_no values that must complete first; empty = sequential)
  depends_on      TEXT NOT NULL DEFAULT '[]',
  -- Spawned worker id (set when step is dispatched)
  worker_id       TEXT,
  -- Failure detail (for retry / re-plan triggers)
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  -- Timestamps
  started_at      TEXT,
  ended_at        TEXT,
  PRIMARY KEY (bom_id, version, step_no)
);

CREATE INDEX IF NOT EXISTS idx_bom_steps_status ON bom_steps(status);
CREATE INDEX IF NOT EXISTS idx_bom_steps_worker ON bom_steps(worker_id);

-- =============================================================
-- NO_GO_LIST: rules that always interrupt for explicit approval
-- =============================================================

CREATE TABLE IF NOT EXISTS no_go_list (
  id              TEXT PRIMARY KEY,
  -- Pattern matches against the action being attempted
  -- For tool calls: tool_name matching (glob style)
  -- For shell commands: cmd substring matching
  action_pattern  TEXT NOT NULL,
  -- Which risk class this rule covers (informational; pattern is authoritative)
  risk_class      TEXT NOT NULL,
  -- Human-readable explanation shown in the approval card
  reason          TEXT NOT NULL,
  -- Where the rule came from
  source          TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','user','organization')),
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_no_go_enabled ON no_go_list(enabled);

-- Seed default no-go list (idempotent via INSERT OR IGNORE)
INSERT OR IGNORE INTO no_go_list (id, action_pattern, risk_class, reason, source) VALUES
  ('ng_force_push',       'git push --force*',        'destructive',  'Force-push rewrites branch history',                  'default'),
  ('ng_force_with_lease', 'git push --force-with-lease*', 'destructive', 'Force-push variants still rewrite history',        'default'),
  ('ng_rm_rf',            '*rm -rf*',                 'destructive',  'Recursive delete outside designated scratch',         'default'),
  ('ng_drop_table',       '*DROP TABLE*',             'destructive',  'Schema-destructive SQL',                              'default'),
  ('ng_drop_database',    '*DROP DATABASE*',          'destructive',  'Whole-database drop',                                 'default'),
  ('ng_delete_no_where',  '*DELETE FROM*',            'destructive',  'DELETE without WHERE clause needs review',            'default'),
  ('ng_external_email',   'send_email*',              'external-comm','Sending email to non-team requires approval',         'default'),
  ('ng_payment',          'charge_*',                 'financial',    'Any charging / payment action',                       'default'),
  ('ng_subscription',     '*subscription*',           'financial',    'Subscription create/modify needs approval',           'default'),
  ('ng_credential_rotate','rotate_credential*',       'credential',   'Credential rotation must be explicit',                'default'),
  ('ng_credential_revoke','revoke_credential*',       'credential',   'Credential revocation must be explicit',              'default'),
  ('ng_prod_deploy',      'deploy_production*',       'destructive',  'Production deploys need explicit approval',           'default');

-- =============================================================
-- CONNECTORS: registered orange-brick adapters
-- =============================================================

CREATE TABLE IF NOT EXISTS connectors (
  id              TEXT PRIMARY KEY,                  -- e.g. 'wiser', 'unifi', 'roblox', 'webhook-stripe'
  display_name    TEXT NOT NULL,                     -- 'Wiser Home', 'Unifi Controller', etc
  kind            TEXT NOT NULL,                     -- 'wiser' | 'unifi' | 'webhook' | 'cron' | 'smtp' | ...
  position        TEXT NOT NULL CHECK (position IN ('above','below')),  -- ESB position: above bus (external) or below (internal/LAN)
  -- Auth + config blob, schema depends on kind. Encrypted via existing credentials infra.
  config_encrypted BLOB,
  -- Connection status
  status          TEXT NOT NULL DEFAULT 'needs_setup' CHECK (status IN ('ok','needs_setup','error','disabled')),
  status_detail   TEXT,                              -- last error or 'connected to udm.local · 14 devices'
  last_checked_at TEXT,
  -- Which tools/capabilities this connector exposes to the steward (JSON array)
  capabilities    TEXT NOT NULL DEFAULT '[]',
  -- Enabled tools — subset of capabilities, user can disable specific ones
  enabled_tools   TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_kind ON connectors(kind);
CREATE INDEX IF NOT EXISTS idx_connectors_status ON connectors(status);

-- =============================================================
-- PROFILE_CONFIG: Turbo / Balanced / Eco settings + active mode
-- =============================================================

CREATE TABLE IF NOT EXISTS profile_config (
  mode            TEXT PRIMARY KEY CHECK (mode IN ('turbo','balanced','eco')),
  config_json     TEXT NOT NULL,                     -- routing rules, budget caps, etc
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  active_mode     TEXT NOT NULL DEFAULT 'balanced' CHECK (active_mode IN ('turbo','balanced','eco')),
  switched_at     TEXT NOT NULL DEFAULT (datetime('now')),
  switched_by     TEXT NOT NULL DEFAULT 'system'
);

INSERT OR IGNORE INTO profile_state (id, active_mode, switched_by) VALUES (1, 'balanced', 'system');
