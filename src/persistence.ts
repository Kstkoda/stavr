import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DecisionOption, Event, EventKindT } from './event-types.js';
import { getLogger } from './log.js';
import type {
  Bom,
  BomStep,
  BomStatus,
  BomStepStatus,
  BomVersion,
  ProfileMode,
} from './types/stavr-bom.js';
import { DEFAULT_PROFILES } from './types/stavr-bom.js';

export interface StoredEvent extends Event {
  id: string;
  persisted_at: string;
}

export type WorkerStatusT =
  | 'starting'
  | 'running'
  | 'idle'
  | 'terminated'
  | 'crashed';

export interface WorkerRecord {
  id: string;
  name: string;
  type: string;
  cwd: string;
  pid?: number;
  status: WorkerStatusT;
  started_at: string;
  ended_at?: string;
  last_activity_at?: string;
  metadata: Record<string, unknown>;
  spawn_params_hash: string;
  termination_reason?: 'completed' | 'crashed' | 'terminated_by_user';
  exit_code?: number;
}

export interface DecisionRecord {
  correlation_id: string;
  question: string;
  options: DecisionOption[];
  default_option_id?: string;
  timeout_sec: number;
  status: 'open' | 'responded' | 'expired';
  requested_at: string;
  expires_at: string;
  responded_at?: string;
  responded_by?: string;
  chosen_option_id?: string;
  response_reason?: string;
}

export interface DecisionResponseResult {
  chosen_option_id: string;
  responder: string;
  reason: string;
  responded_at: string;
}

export class DecisionTimeoutError extends Error {
  code = 'TIMEOUT' as const;
  constructor(public correlation_id: string) {
    super(`Decision ${correlation_id} timed out`);
  }
}

export interface EventStoreInitResult {
  /** Set when the DB had to be quarantined and rebuilt. Path is the corrupt file. */
  recoveredFromCorruption?: string;
}

export class EventStore {
  private db!: Database.Database;
  private responses = new EventEmitter();
  /** Set to the quarantined path if init() had to rebuild the DB from scratch. */
  recoveredCorruptDbPath?: string;

  init(dbPath: string): EventStoreInitResult {
    const result: EventStoreInitResult = {};
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    try {
      this.openAndMigrate(dbPath);
    } catch (err) {
      // Treat any failure during initial open/schema migration as corruption
      // for on-disk DBs. We quarantine the file and start fresh — losing
      // history but keeping the daemon alive (spec 44 invariant 5: graceful
      // degradation > crash). In-memory DBs never reach this path.
      if (dbPath === ':memory:') throw err;
      const corruptPath = `${dbPath}.corrupt.${Date.now()}`;
      try {
        renameSync(dbPath, corruptPath);
        result.recoveredFromCorruption = corruptPath;
        this.recoveredCorruptDbPath = corruptPath;
        getLogger().error('db corrupted; quarantined and rebuilding', {
          original: dbPath,
          corrupt_path: corruptPath,
          error: (err as Error).message,
        });
      } catch {
        // If we can't even rename, surface the original error.
        throw err;
      }
      this.openAndMigrate(dbPath);
    }
    return result;
  }

  private openAndMigrate(dbPath: string): void {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Quick integrity check — better-sqlite3 doesn't always throw on open even
    // when pages are corrupt. If this fails, openAndMigrate's caller (init)
    // catches and quarantines.
    const integrity = this.db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
    if (integrity && integrity.integrity_check !== 'ok') {
      throw new Error(`sqlite integrity_check failed: ${integrity.integrity_check}`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        correlation_id TEXT,
        source_agent TEXT NOT NULL,
        tenant_id TEXT,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL,
        persisted_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

      CREATE TABLE IF NOT EXISTS decisions (
        correlation_id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        default_option_id TEXT,
        timeout_sec INTEGER NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        responded_at TEXT,
        responded_by TEXT,
        chosen_option_id TEXT,
        response_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        handoff_path TEXT,
        branch TEXT,
        pr_urls_json TEXT NOT NULL DEFAULT '[]',
        event_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workers (
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
      CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
      CREATE INDEX IF NOT EXISTS idx_workers_type ON workers(type);
      CREATE INDEX IF NOT EXISTS idx_workers_name_active
        ON workers(name) WHERE status NOT IN ('terminated', 'crashed');

      CREATE TABLE IF NOT EXISTS trust_scopes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        expires_after_actions INTEGER,
        allowed_actions_json TEXT NOT NULL,
        forbidden_actions_json TEXT,
        reporting_json TEXT NOT NULL,
        status TEXT NOT NULL,
        spec_url TEXT,
        proposed_at TEXT,
        actions_executed INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trust_scopes_status ON trust_scopes(status);

      CREATE TABLE IF NOT EXISTS scope_actions (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        executed_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES trust_scopes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_scope_actions_scope ON scope_actions(scope_id);

      -- Spec 48 Layer 1: Steward role + single-Steward invariant.
      CREATE TABLE IF NOT EXISTS stewards (
        id              TEXT PRIMARY KEY,
        client_id       TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        display_name    TEXT,
        model           TEXT,
        provider        TEXT,
        claimed_at      TEXT NOT NULL,
        released_at     TEXT,
        last_pulse_at   TEXT,
        memory_path     TEXT,
        metadata_json   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_stewards_active
        ON stewards(claimed_at) WHERE released_at IS NULL;

      -- One-shot tokens minted by 'stavr steward mint-token' (or stavr init).
      -- 30-minute default TTL; redeemed exactly once by mcp__stavr__steward_claim.
      CREATE TABLE IF NOT EXISTS steward_claim_tokens (
        token         TEXT PRIMARY KEY,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        redeemed_at   TEXT,
        redeemed_by   TEXT
      );

      -- Spec 48 Layer 2: encrypted credentials vault.
      -- AES-256-GCM-encrypted plaintext lives in encrypted_blob; key never
      -- appears in the DB (OS keychain or ~/.stavr/master.key fallback).
      CREATE TABLE IF NOT EXISTS credentials (
        id                              TEXT PRIMARY KEY,
        user_id                         TEXT NOT NULL,
        service                         TEXT NOT NULL,
        kind                            TEXT NOT NULL,
        encrypted_blob                  BLOB,
        oauth_scopes                    TEXT,
        oauth_refresh_token_encrypted   BLOB,
        expires_at                      TEXT,
        created_at                      TEXT NOT NULL,
        last_used_at                    TEXT,
        revoked_at                      TEXT,
        metadata_json                   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_service
        ON credentials(service) WHERE revoked_at IS NULL;

      -- Grants tie a credential to a specific Steward session. A credential
      -- without an active grant is unusable to the Steward (mcp__stavr__credential_use
      -- returns CREDENTIAL_NOT_GRANTED).
      CREATE TABLE IF NOT EXISTS credential_grants (
        id                  TEXT PRIMARY KEY,
        credential_id       TEXT NOT NULL,
        steward_session_id  TEXT,
        granted_at          TEXT NOT NULL,
        revoked_at          TEXT,
        granted_by_user_id  TEXT NOT NULL,
        uses_remaining      INTEGER,
        expires_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_credential_grants_active
        ON credential_grants(credential_id) WHERE revoked_at IS NULL;

      -- Spec 52 A2 — paired devices. The token_hash column stores SHA256(token);
      -- the raw token is returned to the device once at pair time and never
      -- persisted on the daemon. revoked_at is NULL for active pairings.
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        paired_from_ip TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
      CREATE INDEX IF NOT EXISTS idx_devices_active
        ON devices(revoked_at) WHERE revoked_at IS NULL;

      -- ====================================================================
      -- v0.2 — BOM planning + executor substrate (proposed/001_bom_schema.sql)
      -- ====================================================================

      CREATE TABLE IF NOT EXISTS boms (
        id              TEXT PRIMARY KEY,
        goal            TEXT NOT NULL,
        requester       TEXT NOT NULL,
        correlation_id  TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('proposed','approved','running','done','failed','cancelled','rejected')),
        active_version  INTEGER NOT NULL DEFAULT 1,
        cost_estimate   REAL NOT NULL DEFAULT 0,
        cost_max        REAL NOT NULL DEFAULT 0,
        duration_sec    INTEGER NOT NULL DEFAULT 0,
        cost_actual     REAL NOT NULL DEFAULT 0,
        steps_done      INTEGER NOT NULL DEFAULT 0,
        steps_total     INTEGER NOT NULL DEFAULT 0,
        profile_mode    TEXT NOT NULL DEFAULT 'balanced',
        scope_id        TEXT,
        risk_envelope   TEXT NOT NULL DEFAULT '[]',
        proposed_at     TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at     TEXT,
        started_at      TEXT,
        ended_at        TEXT,
        is_draft        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_boms_status ON boms(status);
      CREATE INDEX IF NOT EXISTS idx_boms_requester ON boms(requester);
      CREATE INDEX IF NOT EXISTS idx_boms_correlation ON boms(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_boms_scope ON boms(scope_id);
      CREATE INDEX IF NOT EXISTS idx_boms_proposed_at ON boms(proposed_at);

      CREATE TABLE IF NOT EXISTS bom_versions (
        bom_id          TEXT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
        version         INTEGER NOT NULL,
        reason          TEXT NOT NULL,
        replan_trigger_step INTEGER,
        steps_json      TEXT NOT NULL,
        planner_model   TEXT NOT NULL,
        planner_cost    REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (bom_id, version)
      );

      CREATE TABLE IF NOT EXISTS bom_steps (
        bom_id          TEXT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
        version         INTEGER NOT NULL,
        step_no         INTEGER NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        capability      TEXT NOT NULL,
        risk_class      TEXT NOT NULL,
        brick_id        TEXT,
        model           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
        cost_estimate   REAL NOT NULL DEFAULT 0,
        duration_sec_est INTEGER NOT NULL DEFAULT 0,
        cost_actual     REAL NOT NULL DEFAULT 0,
        tokens_in       INTEGER NOT NULL DEFAULT 0,
        tokens_out      INTEGER NOT NULL DEFAULT 0,
        depends_on      TEXT NOT NULL DEFAULT '[]',
        worker_id       TEXT,
        error_message   TEXT,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT,
        ended_at        TEXT,
        PRIMARY KEY (bom_id, version, step_no)
      );
      CREATE INDEX IF NOT EXISTS idx_bom_steps_status ON bom_steps(status);
      CREATE INDEX IF NOT EXISTS idx_bom_steps_worker ON bom_steps(worker_id);

      CREATE TABLE IF NOT EXISTS no_go_list (
        id              TEXT PRIMARY KEY,
        action_pattern  TEXT NOT NULL,
        risk_class      TEXT NOT NULL,
        reason          TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'default' CHECK (source IN ('default','user','organization')),
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_no_go_enabled ON no_go_list(enabled);

      CREATE TABLE IF NOT EXISTS connectors (
        id              TEXT PRIMARY KEY,
        display_name    TEXT NOT NULL,
        kind            TEXT NOT NULL,
        position        TEXT NOT NULL CHECK (position IN ('above','below')),
        config_encrypted BLOB,
        status          TEXT NOT NULL DEFAULT 'needs_setup' CHECK (status IN ('ok','needs_setup','error','disabled')),
        status_detail   TEXT,
        last_checked_at TEXT,
        capabilities    TEXT NOT NULL DEFAULT '[]',
        enabled_tools   TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_connectors_kind ON connectors(kind);
      CREATE INDEX IF NOT EXISTS idx_connectors_status ON connectors(status);

      CREATE TABLE IF NOT EXISTS installed_bricks (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        source_type     TEXT NOT NULL CHECK (source_type IN ('local','github','npm')),
        source_path     TEXT NOT NULL,
        install_path    TEXT NOT NULL,
        manifest_json   TEXT NOT NULL,
        entry_point     TEXT NOT NULL,
        installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
        enabled         INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_installed_bricks_kind ON installed_bricks(kind);
      CREATE INDEX IF NOT EXISTS idx_installed_bricks_enabled ON installed_bricks(enabled);

      CREATE TABLE IF NOT EXISTS profile_config (
        mode            TEXT PRIMARY KEY CHECK (mode IN ('turbo','balanced','eco')),
        config_json     TEXT NOT NULL,
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS profile_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        active_mode     TEXT NOT NULL DEFAULT 'balanced' CHECK (active_mode IN ('turbo','balanced','eco')),
        switched_at     TEXT NOT NULL DEFAULT (datetime('now')),
        switched_by     TEXT NOT NULL DEFAULT 'system'
      );
    `);

    // Seed no-go defaults (idempotent via INSERT OR IGNORE).
    const noGoSeeds: Array<[string, string, string, string]> = [
      ['ng_force_push',        'git push --force*',            'destructive',  'Force-push rewrites branch history'],
      ['ng_force_with_lease',  'git push --force-with-lease*', 'destructive',  'Force-push variants still rewrite history'],
      ['ng_rm_rf',             '*rm -rf*',                     'destructive',  'Recursive delete outside designated scratch'],
      ['ng_drop_table',        '*DROP TABLE*',                 'destructive',  'Schema-destructive SQL'],
      ['ng_drop_database',     '*DROP DATABASE*',              'destructive',  'Whole-database drop'],
      ['ng_delete_no_where',   '*DELETE FROM*',                'destructive',  'DELETE without WHERE clause needs review'],
      ['ng_external_email',    'send_email*',                  'external-comm','Sending email to non-team requires approval'],
      ['ng_payment',           'charge_*',                     'financial',    'Any charging / payment action'],
      ['ng_subscription',      '*subscription*',               'financial',    'Subscription create/modify needs approval'],
      ['ng_credential_rotate', 'rotate_credential*',           'credential',   'Credential rotation must be explicit'],
      ['ng_credential_revoke', 'revoke_credential*',           'credential',   'Credential revocation must be explicit'],
      ['ng_prod_deploy',       'deploy_production*',           'destructive',  'Production deploys need explicit approval'],
    ];
    const insertNoGo = this.db.prepare(
      `INSERT OR IGNORE INTO no_go_list (id, action_pattern, risk_class, reason, source) VALUES (?, ?, ?, ?, 'default')`,
    );
    for (const [id, pattern, risk, reason] of noGoSeeds) {
      insertNoGo.run(id, pattern, risk, reason);
    }

    // Seed profile configs (idempotent).
    const insertProfile = this.db.prepare(
      `INSERT OR IGNORE INTO profile_config (mode, config_json) VALUES (?, ?)`,
    );
    for (const mode of ['turbo', 'balanced', 'eco'] as const) {
      insertProfile.run(mode, JSON.stringify(DEFAULT_PROFILES[mode]));
    }

    // Seed singleton profile_state row.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO profile_state (id, active_mode, switched_by) VALUES (1, 'balanced', 'system')`,
      )
      .run();
  }

  /** Raw DB handle for the TrustStore sibling. Avoids reopening the SQLite file. */
  get rawDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db?.close();
  }

  appendEvent(event: Event): StoredEvent {
    const id = randomUUID();
    const persisted_at = new Date().toISOString();
    const seq = this.nextSeq();
    this.db
      .prepare(
        `INSERT INTO events (id, kind, correlation_id, source_agent, tenant_id, payload_json, at, persisted_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.kind,
        event.correlation_id ?? null,
        event.source_agent,
        event.tenant_id ?? null,
        JSON.stringify(event.payload),
        event.at,
        persisted_at,
        seq,
      );
    return { id, persisted_at, ...event };
  }

  private nextSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events`).get() as { m: number };
    return row.m + 1;
  }

  getEvents(filter: {
    sinceEventId?: string;
    sinceAt?: string;
    kinds?: string[];
    sourceAgent?: string;
    tenantId?: string;
    limit?: number;
  }): { events: StoredEvent[]; has_more: boolean } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.sinceEventId) {
      const row = this.db.prepare(`SELECT seq FROM events WHERE id = ?`).get(filter.sinceEventId) as
        | { seq: number }
        | undefined;
      const seq = row?.seq ?? 0;
      where.push(`seq > ?`);
      params.push(seq);
    }
    if (filter.sinceAt) {
      where.push(`at >= ?`);
      params.push(filter.sinceAt);
    }
    if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes('*')) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.sourceAgent) {
      where.push(`source_agent = ?`);
      params.push(filter.sourceAgent);
    }
    if (filter.tenantId) {
      where.push(`tenant_id = ?`);
      params.push(filter.tenantId);
    }

    const limit = Math.min(filter.limit ?? 500, 5000);
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC LIMIT ?`;
    params.push(limit + 1);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      kind: string;
      correlation_id: string | null;
      source_agent: string;
      tenant_id: string | null;
      payload_json: string;
      at: string;
      persisted_at: string;
      seq: number;
    }>;
    const has_more = rows.length > limit;
    const slice = has_more ? rows.slice(0, limit) : rows;
    const events: StoredEvent[] = slice.map((r) => ({
      id: r.id,
      kind: r.kind as EventKindT,
      correlation_id: r.correlation_id ?? undefined,
      source_agent: r.source_agent,
      tenant_id: r.tenant_id ?? undefined,
      payload: JSON.parse(r.payload_json),
      at: r.at,
      persisted_at: r.persisted_at,
    }));
    return { events, has_more };
  }

  eventCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }).c;
  }

  /** Cheap liveness check: a SELECT 1 that throws if the underlying DB handle is gone. */
  isReachable(): boolean {
    try {
      this.db.prepare(`SELECT 1`).get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writability probe: writes/deletes a sentinel row in the `meta` table. We
   * never want this to fail silently in /healthz, so the caller can flip the
   * response to 503 on `false`.
   */
  isWritable(): boolean {
    try {
      const key = '__healthz_probe__';
      this.db
        .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
        .run(key, new Date().toISOString());
      this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Decisions responded to within the last hour (used by /healthz for at-a-glance load). */
  decisionsRespondedSince(sinceIso: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM decisions WHERE responded_at IS NOT NULL AND responded_at >= ?`)
        .get(sinceIso) as { c: number }
    ).c;
  }

  pendingDecisionCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM decisions WHERE status='open'`).get() as {
        c: number;
      }
    ).c;
  }

  createDecision(
    correlationId: string,
    question: string,
    options: DecisionOption[],
    timeoutSec: number,
    defaultOptionId?: string,
  ): void {
    const now = new Date();
    const expires = new Date(now.getTime() + timeoutSec * 1000);
    this.db
      .prepare(
        `INSERT INTO decisions (correlation_id, question, options_json, default_option_id, timeout_sec, status, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        correlationId,
        question,
        JSON.stringify(options),
        defaultOptionId ?? null,
        timeoutSec,
        now.toISOString(),
        expires.toISOString(),
      );
  }

  getDecision(correlationId: string): DecisionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decisions WHERE correlation_id = ?`)
      .get(correlationId) as
      | {
          correlation_id: string;
          question: string;
          options_json: string;
          default_option_id: string | null;
          timeout_sec: number;
          status: 'open' | 'responded' | 'expired';
          requested_at: string;
          expires_at: string;
          responded_at: string | null;
          responded_by: string | null;
          chosen_option_id: string | null;
          response_reason: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      correlation_id: row.correlation_id,
      question: row.question,
      options: JSON.parse(row.options_json),
      default_option_id: row.default_option_id ?? undefined,
      timeout_sec: row.timeout_sec,
      status: row.status,
      requested_at: row.requested_at,
      expires_at: row.expires_at,
      responded_at: row.responded_at ?? undefined,
      responded_by: row.responded_by ?? undefined,
      chosen_option_id: row.chosen_option_id ?? undefined,
      response_reason: row.response_reason ?? undefined,
    };
  }

  awaitDecisionResponse(correlationId: string, timeoutMs: number): Promise<DecisionResponseResult> {
    return new Promise((resolve, reject) => {
      const existing = this.getDecision(correlationId);
      if (existing && existing.status === 'responded' && existing.chosen_option_id) {
        resolve({
          chosen_option_id: existing.chosen_option_id,
          responder: existing.responded_by ?? 'unknown',
          reason: existing.response_reason ?? '',
          responded_at: existing.responded_at ?? new Date().toISOString(),
        });
        return;
      }

      const onResponse = (result: DecisionResponseResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.responses.off(correlationId, onResponse);
        reject(new DecisionTimeoutError(correlationId));
      }, timeoutMs);
      this.responses.once(correlationId, onResponse);
    });
  }

  respondToDecision(
    correlationId: string,
    chosenOptionId: string,
    reason: string,
    responder: string,
  ): { ok: true; result: DecisionResponseResult } | { ok: false; error: 'not_found' | 'already_responded' | 'expired' | 'invalid_option' } {
    const existing = this.getDecision(correlationId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status === 'responded') return { ok: false, error: 'already_responded' };
    if (existing.status === 'expired') return { ok: false, error: 'expired' };

    const validIds = new Set(existing.options.map((o) => o.id));
    if (!validIds.has(chosenOptionId)) return { ok: false, error: 'invalid_option' };

    const responded_at = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE decisions SET status='responded', responded_at=?, responded_by=?, chosen_option_id=?, response_reason=?
         WHERE correlation_id=?`,
      )
      .run(responded_at, responder, chosenOptionId, reason, correlationId);

    const result: DecisionResponseResult = {
      chosen_option_id: chosenOptionId,
      responder,
      reason,
      responded_at,
    };
    this.responses.emit(correlationId, result);
    return { ok: true, result };
  }

  sweepExpiredDecisions(now: Date = new Date()): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE status='open' AND expires_at < ?`)
      .all(now.toISOString()) as Array<{ correlation_id: string }>;
    const expired: DecisionRecord[] = [];
    for (const r of rows) {
      this.db
        .prepare(`UPDATE decisions SET status='expired' WHERE correlation_id=?`)
        .run(r.correlation_id);
      const rec = this.getDecision(r.correlation_id);
      if (rec) expired.push(rec);
    }
    return expired;
  }

  upsertWorker(record: WorkerRecord): void {
    this.db
      .prepare(
        `INSERT INTO workers
           (id, name, type, cwd, pid, status, started_at, ended_at, last_activity_at,
            metadata_json, spawn_params_hash, termination_reason, exit_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           cwd = excluded.cwd,
           pid = excluded.pid,
           status = excluded.status,
           ended_at = excluded.ended_at,
           last_activity_at = excluded.last_activity_at,
           metadata_json = excluded.metadata_json,
           spawn_params_hash = excluded.spawn_params_hash,
           termination_reason = excluded.termination_reason,
           exit_code = excluded.exit_code`,
      )
      .run(
        record.id,
        record.name,
        record.type,
        record.cwd,
        record.pid ?? null,
        record.status,
        record.started_at,
        record.ended_at ?? null,
        record.last_activity_at ?? null,
        JSON.stringify(record.metadata),
        record.spawn_params_hash,
        record.termination_reason ?? null,
        record.exit_code ?? null,
      );
  }

  getWorker(idOrName: string): WorkerRecord | undefined {
    const byId = this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(idOrName) as
      | WorkerRow
      | undefined;
    if (byId) return workerRowToRecord(byId);
    // Prefer non-terminated rows when looking up by name.
    const row = this.db
      .prepare(
        `SELECT * FROM workers
         WHERE name = ?
         ORDER BY (status IN ('terminated','crashed')) ASC, started_at DESC
         LIMIT 1`,
      )
      .get(idOrName) as WorkerRow | undefined;
    return row ? workerRowToRecord(row) : undefined;
  }

  listWorkers(filter?: { type?: string; status?: WorkerStatusT }): WorkerRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.type) {
      where.push(`type = ?`);
      params.push(filter.type);
    }
    if (filter?.status) {
      where.push(`status = ?`);
      params.push(filter.status);
    }
    const sql = `SELECT * FROM workers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as WorkerRow[];
    return rows.map(workerRowToRecord);
  }

  updateWorkerMetadata(id: string, patch: Record<string, unknown>): WorkerRecord | undefined {
    const existing = this.getWorker(id);
    if (!existing) return undefined;
    const merged = { ...existing.metadata, ...patch };
    const last = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workers SET metadata_json = ?, last_activity_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(merged), last, id);
    return { ...existing, metadata: merged, last_activity_at: last };
  }

  markWorkerTerminated(
    id: string,
    reason: 'completed' | 'crashed' | 'terminated_by_user',
    exitCode?: number,
  ): WorkerRecord | undefined {
    const existing = this.getWorker(id);
    if (!existing) return undefined;
    const status: WorkerStatusT = reason === 'crashed' ? 'crashed' : 'terminated';
    const ended = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workers SET status = ?, ended_at = ?, termination_reason = ?, exit_code = ?
         WHERE id = ?`,
      )
      .run(status, ended, reason, exitCode ?? null, id);
    return {
      ...existing,
      status,
      ended_at: ended,
      termination_reason: reason,
      exit_code: exitCode,
    };
  }

  updateWorkerStatus(id: string, status: WorkerStatusT, pid?: number): WorkerRecord | undefined {
    const existing = this.getWorker(id);
    if (!existing) return undefined;
    const last = new Date().toISOString();
    this.db
      .prepare(`UPDATE workers SET status = ?, pid = COALESCE(?, pid), last_activity_at = ? WHERE id = ?`)
      .run(status, pid ?? null, last, id);
    return { ...existing, status, pid: pid ?? existing.pid, last_activity_at: last };
  }

  listWorkersForWatchdog(): Array<{
    id: string;
    name: string;
    type: string;
    pid: number | null;
    started_at: string;
    last_activity_at: string | null;
    status: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, name, type, pid, started_at, last_activity_at, status
         FROM workers WHERE status IN ('running', 'idle')`,
      )
      .all() as Array<{
        id: string;
        name: string;
        type: string;
        pid: number | null;
        started_at: string;
        last_activity_at: string | null;
        status: string;
      }>;
  }

  nameIsAvailable(name: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM workers WHERE name = ? AND status NOT IN ('terminated', 'crashed') LIMIT 1`,
      )
      .get(name);
    return !row;
  }

  listRecentDecisions(limit = 20): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT correlation_id FROM decisions ORDER BY requested_at DESC LIMIT ?`)
      .all(limit) as Array<{ correlation_id: string }>;
    return rows.map((r) => this.getDecision(r.correlation_id)!).filter(Boolean);
  }

  // ---- Spec 52 A2: paired devices ----

  insertDevice(record: {
    id: string;
    name: string;
    paired_at: string;
    paired_from_ip: string;
    token_hash: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, paired_at, paired_from_ip, token_hash, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(record.id, record.name, record.paired_at, record.paired_from_ip, record.token_hash);
  }

  /** Returns the active device matching the given SHA256 token-hash, or undefined. */
  findActiveDeviceByTokenHash(tokenHash: string): DeviceRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, paired_at, paired_from_ip, token_hash, revoked_at
         FROM devices WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(tokenHash) as DeviceRow | undefined;
    return row ? deviceRowToRecord(row) : undefined;
  }

  getDevice(id: string): DeviceRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, paired_at, paired_from_ip, token_hash, revoked_at
         FROM devices WHERE id = ?`,
      )
      .get(id) as DeviceRow | undefined;
    return row ? deviceRowToRecord(row) : undefined;
  }

  listDevices(opts?: { activeOnly?: boolean }): DeviceRecord[] {
    const sql = opts?.activeOnly
      ? `SELECT id, name, paired_at, paired_from_ip, token_hash, revoked_at
         FROM devices WHERE revoked_at IS NULL ORDER BY paired_at DESC`
      : `SELECT id, name, paired_at, paired_from_ip, token_hash, revoked_at
         FROM devices ORDER BY paired_at DESC`;
    const rows = this.db.prepare(sql).all() as DeviceRow[];
    return rows.map(deviceRowToRecord);
  }

  /** Returns true if the device was active and is now revoked; false if already revoked or unknown. */
  revokeDevice(id: string, revokedAt: string): boolean {
    const r = this.db
      .prepare(`UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(revokedAt, id);
    return r.changes > 0;
  }

  countActiveDevices(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  // ============================================================
  // v0.2 — BOM persistence (planner + executor backing store)
  // ============================================================

  saveBom(bom: Bom): void {
    this.db
      .prepare(
        `INSERT INTO boms
           (id, goal, requester, correlation_id, status, active_version,
            cost_estimate, cost_max, duration_sec, cost_actual, steps_done, steps_total,
            profile_mode, scope_id, risk_envelope, proposed_at, approved_at,
            started_at, ended_at, is_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           goal = excluded.goal,
           status = excluded.status,
           active_version = excluded.active_version,
           cost_estimate = excluded.cost_estimate,
           cost_max = excluded.cost_max,
           duration_sec = excluded.duration_sec,
           cost_actual = excluded.cost_actual,
           steps_done = excluded.steps_done,
           steps_total = excluded.steps_total,
           profile_mode = excluded.profile_mode,
           scope_id = excluded.scope_id,
           risk_envelope = excluded.risk_envelope,
           approved_at = excluded.approved_at,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           is_draft = excluded.is_draft`,
      )
      .run(
        bom.id,
        bom.goal,
        bom.requester,
        bom.correlation_id,
        bom.status,
        bom.active_version,
        bom.cost_estimate,
        bom.cost_max,
        bom.duration_sec,
        bom.cost_actual,
        bom.steps_done,
        bom.steps_total,
        bom.profile_mode,
        bom.scope_id ?? null,
        JSON.stringify(bom.risk_envelope),
        bom.proposed_at,
        bom.approved_at ?? null,
        bom.started_at ?? null,
        bom.ended_at ?? null,
        bom.is_draft ? 1 : 0,
      );
  }

  saveBomVersion(version: BomVersion): void {
    this.db
      .prepare(
        `INSERT INTO bom_versions
           (bom_id, version, reason, replan_trigger_step, steps_json,
            planner_model, planner_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bom_id, version) DO UPDATE SET
           reason = excluded.reason,
           replan_trigger_step = excluded.replan_trigger_step,
           steps_json = excluded.steps_json,
           planner_model = excluded.planner_model,
           planner_cost = excluded.planner_cost`,
      )
      .run(
        version.bom_id,
        version.version,
        version.reason,
        version.replan_trigger_step ?? null,
        JSON.stringify(version.steps),
        version.planner_model,
        version.planner_cost,
        version.created_at,
      );
  }

  saveBomSteps(bomId: string, version: number, steps: BomStep[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO bom_steps
         (bom_id, version, step_no, title, description, capability, risk_class,
          brick_id, model, status, cost_estimate, duration_sec_est, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(bom_id, version, step_no) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         capability = excluded.capability,
         risk_class = excluded.risk_class,
         brick_id = excluded.brick_id,
         model = excluded.model,
         cost_estimate = excluded.cost_estimate,
         duration_sec_est = excluded.duration_sec_est,
         depends_on = excluded.depends_on`,
    );
    const tx = this.db.transaction((rows: BomStep[]) => {
      for (const s of rows) {
        stmt.run(
          bomId,
          version,
          s.step_no,
          s.title,
          s.description ?? null,
          s.capability,
          s.risk_class,
          s.brick_id,
          s.model,
          s.cost_estimate,
          s.duration_sec_est,
          JSON.stringify(s.depends_on),
        );
      }
    });
    tx(steps);
  }

  getBom(id: string): Bom | undefined {
    const row = this.db.prepare(`SELECT * FROM boms WHERE id = ?`).get(id) as BomRow | undefined;
    return row ? bomRowToRecord(row) : undefined;
  }

  listBoms(filter?: { status?: BomStatus; limit?: number }): Bom[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      where.push(`status = ?`);
      params.push(filter.status);
    }
    const limit = Math.min(filter?.limit ?? 200, 2000);
    const sql = `SELECT * FROM boms ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY proposed_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as BomRow[];
    return rows.map(bomRowToRecord);
  }

  getActiveVersion(bomId: string): BomVersion | undefined {
    const bom = this.getBom(bomId);
    if (!bom) return undefined;
    return this.getBomVersion(bomId, bom.active_version);
  }

  getBomVersion(bomId: string, version: number): BomVersion | undefined {
    const row = this.db
      .prepare(`SELECT * FROM bom_versions WHERE bom_id = ? AND version = ?`)
      .get(bomId, version) as BomVersionRow | undefined;
    return row ? bomVersionRowToRecord(row) : undefined;
  }

  setActiveVersion(bomId: string, version: number): void {
    this.db.prepare(`UPDATE boms SET active_version = ? WHERE id = ?`).run(version, bomId);
  }

  updateBomStatus(bomId: string, patch: Partial<Bom>): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.scope_id !== undefined) {
      fields.push('scope_id = ?');
      params.push(patch.scope_id ?? null);
    }
    if (patch.approved_at !== undefined) {
      fields.push('approved_at = ?');
      params.push(patch.approved_at ?? null);
    }
    if (patch.started_at !== undefined) {
      fields.push('started_at = ?');
      params.push(patch.started_at ?? null);
    }
    if (patch.ended_at !== undefined) {
      fields.push('ended_at = ?');
      params.push(patch.ended_at ?? null);
    }
    if (patch.cost_actual !== undefined) {
      fields.push('cost_actual = ?');
      params.push(patch.cost_actual);
    }
    if (patch.steps_done !== undefined) {
      fields.push('steps_done = ?');
      params.push(patch.steps_done);
    }
    if (patch.steps_total !== undefined) {
      fields.push('steps_total = ?');
      params.push(patch.steps_total);
    }
    if (patch.duration_sec !== undefined) {
      fields.push('duration_sec = ?');
      params.push(patch.duration_sec);
    }
    if (fields.length === 0) return;
    params.push(bomId);
    this.db.prepare(`UPDATE boms SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  updateBomStep(
    bomId: string,
    version: number,
    stepNo: number,
    patch: {
      status?: BomStep['capability'] extends never ? never : 'pending' | 'running' | 'done' | 'failed' | 'skipped';
      cost_actual?: number;
      tokens_in?: number;
      tokens_out?: number;
      worker_id?: string | null;
      error_message?: string | null;
      retry_count?: number;
      started_at?: string | null;
      ended_at?: string | null;
    },
  ): void {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      fields.push(`${k} = ?`);
      params.push(v);
    }
    if (fields.length === 0) return;
    params.push(bomId, version, stepNo);
    this.db
      .prepare(
        `UPDATE bom_steps SET ${fields.join(', ')} WHERE bom_id = ? AND version = ? AND step_no = ?`,
      )
      .run(...params);
  }

  listBomSteps(bomId: string, version: number): Array<BomStep & { status: BomStepStatus; cost_actual: number; tokens_in: number; tokens_out: number; worker_id?: string; error_message?: string; retry_count: number; started_at?: string; ended_at?: string }> {
    const rows = this.db
      .prepare(`SELECT * FROM bom_steps WHERE bom_id = ? AND version = ? ORDER BY step_no ASC`)
      .all(bomId, version) as BomStepRow[];
    return rows.map(bomStepRowToRecord);
  }

  getActiveProfileMode(): ProfileMode {
    const row = this.db.prepare(`SELECT active_mode FROM profile_state WHERE id = 1`).get() as
      | { active_mode: ProfileMode }
      | undefined;
    return row?.active_mode ?? 'balanced';
  }

  setActiveProfileMode(mode: ProfileMode, switchedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO profile_state (id, active_mode, switched_at, switched_by) VALUES (1, ?, datetime('now'), ?)
         ON CONFLICT(id) DO UPDATE SET active_mode=excluded.active_mode, switched_at=datetime('now'), switched_by=excluded.switched_by`,
      )
      .run(mode, switchedBy);
  }

  // ---- No-go list ----

  listNoGoRules(): Array<{
    id: string;
    action_pattern: string;
    risk_class: string;
    reason: string;
    source: 'default' | 'user' | 'organization';
    enabled: boolean;
  }> {
    const rows = this.db
      .prepare(`SELECT id, action_pattern, risk_class, reason, source, enabled FROM no_go_list`)
      .all() as Array<{
        id: string;
        action_pattern: string;
        risk_class: string;
        reason: string;
        source: 'default' | 'user' | 'organization';
        enabled: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      action_pattern: r.action_pattern,
      risk_class: r.risk_class,
      reason: r.reason,
      source: r.source,
      enabled: !!r.enabled,
    }));
  }

  noGoCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM no_go_list`).get() as { n: number }).n;
  }

  // ---- Installed bricks ----

  saveInstalledBrick(record: {
    id: string;
    kind: string;
    display_name: string;
    source_type: 'local' | 'github' | 'npm';
    source_path: string;
    install_path: string;
    manifest_json: string;
    entry_point: string;
    enabled?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO installed_bricks
           (id, kind, display_name, source_type, source_path, install_path,
            manifest_json, entry_point, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           display_name = excluded.display_name,
           source_path = excluded.source_path,
           install_path = excluded.install_path,
           manifest_json = excluded.manifest_json,
           entry_point = excluded.entry_point,
           enabled = excluded.enabled`,
      )
      .run(
        record.id,
        record.kind,
        record.display_name,
        record.source_type,
        record.source_path,
        record.install_path,
        record.manifest_json,
        record.entry_point,
        record.enabled === false ? 0 : 1,
      );
  }

  deleteInstalledBrick(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM installed_bricks WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  listInstalledBricks(): Array<{
    id: string;
    kind: string;
    display_name: string;
    source_type: 'local' | 'github' | 'npm';
    source_path: string;
    install_path: string;
    manifest_json: string;
    entry_point: string;
    installed_at: string;
    enabled: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, kind, display_name, source_type, source_path, install_path,
                manifest_json, entry_point, installed_at, enabled
         FROM installed_bricks ORDER BY installed_at ASC`,
      )
      .all() as Array<{
        id: string;
        kind: string;
        display_name: string;
        source_type: 'local' | 'github' | 'npm';
        source_path: string;
        install_path: string;
        manifest_json: string;
        entry_point: string;
        installed_at: string;
        enabled: number;
      }>;
    return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  }
}

interface BomRow {
  id: string;
  goal: string;
  requester: string;
  correlation_id: string;
  status: BomStatus;
  active_version: number;
  cost_estimate: number;
  cost_max: number;
  duration_sec: number;
  cost_actual: number;
  steps_done: number;
  steps_total: number;
  profile_mode: ProfileMode;
  scope_id: string | null;
  risk_envelope: string;
  proposed_at: string;
  approved_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  is_draft: number;
}

function bomRowToRecord(row: BomRow): Bom {
  return {
    id: row.id,
    goal: row.goal,
    requester: row.requester,
    correlation_id: row.correlation_id,
    status: row.status,
    active_version: row.active_version,
    cost_estimate: row.cost_estimate,
    cost_max: row.cost_max,
    duration_sec: row.duration_sec,
    cost_actual: row.cost_actual,
    steps_done: row.steps_done,
    steps_total: row.steps_total,
    profile_mode: row.profile_mode,
    scope_id: row.scope_id ?? undefined,
    risk_envelope: JSON.parse(row.risk_envelope) as Bom['risk_envelope'],
    proposed_at: row.proposed_at,
    approved_at: row.approved_at ?? undefined,
    started_at: row.started_at ?? undefined,
    ended_at: row.ended_at ?? undefined,
    is_draft: !!row.is_draft,
  };
}

interface BomVersionRow {
  bom_id: string;
  version: number;
  reason: BomVersion['reason'];
  replan_trigger_step: number | null;
  steps_json: string;
  planner_model: string;
  planner_cost: number;
  created_at: string;
}

function bomVersionRowToRecord(row: BomVersionRow): BomVersion {
  return {
    bom_id: row.bom_id,
    version: row.version,
    reason: row.reason,
    replan_trigger_step: row.replan_trigger_step ?? undefined,
    steps: JSON.parse(row.steps_json) as BomStep[],
    planner_model: row.planner_model,
    planner_cost: row.planner_cost,
    created_at: row.created_at,
  };
}

interface BomStepRow {
  bom_id: string;
  version: number;
  step_no: number;
  title: string;
  description: string | null;
  capability: string;
  risk_class: string;
  brick_id: string | null;
  model: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  cost_estimate: number;
  duration_sec_est: number;
  cost_actual: number;
  tokens_in: number;
  tokens_out: number;
  depends_on: string;
  worker_id: string | null;
  error_message: string | null;
  retry_count: number;
  started_at: string | null;
  ended_at: string | null;
}

function bomStepRowToRecord(row: BomStepRow): BomStep & {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  cost_actual: number;
  tokens_in: number;
  tokens_out: number;
  worker_id?: string;
  error_message?: string;
  retry_count: number;
  started_at?: string;
  ended_at?: string;
} {
  return {
    step_no: row.step_no,
    title: row.title,
    description: row.description ?? undefined,
    capability: row.capability as BomStep['capability'],
    risk_class: row.risk_class as BomStep['risk_class'],
    brick_id: row.brick_id ?? '',
    model: row.model,
    cost_estimate: row.cost_estimate,
    duration_sec_est: row.duration_sec_est,
    depends_on: JSON.parse(row.depends_on) as number[],
    status: row.status,
    cost_actual: row.cost_actual,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    worker_id: row.worker_id ?? undefined,
    error_message: row.error_message ?? undefined,
    retry_count: row.retry_count,
    started_at: row.started_at ?? undefined,
    ended_at: row.ended_at ?? undefined,
  };
}

export interface DeviceRecord {
  id: string;
  name: string;
  paired_at: string;
  paired_from_ip: string;
  token_hash: string;
  revoked_at?: string;
}

interface DeviceRow {
  id: string;
  name: string;
  paired_at: string;
  paired_from_ip: string;
  token_hash: string;
  revoked_at: string | null;
}

function deviceRowToRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    paired_at: row.paired_at,
    paired_from_ip: row.paired_from_ip,
    token_hash: row.token_hash,
    revoked_at: row.revoked_at ?? undefined,
  };
}

interface WorkerRow {
  id: string;
  name: string;
  type: string;
  cwd: string;
  pid: number | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  metadata_json: string;
  spawn_params_hash: string;
  termination_reason: string | null;
  exit_code: number | null;
}

function workerRowToRecord(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    cwd: row.cwd,
    pid: row.pid ?? undefined,
    status: row.status as WorkerStatusT,
    started_at: row.started_at,
    ended_at: row.ended_at ?? undefined,
    last_activity_at: row.last_activity_at ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    spawn_params_hash: row.spawn_params_hash,
    termination_reason: (row.termination_reason as WorkerRecord['termination_reason']) ?? undefined,
    exit_code: row.exit_code ?? undefined,
  };
}
