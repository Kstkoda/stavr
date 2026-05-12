import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DecisionOption, Event, EventKindT } from './event-types.js';

export interface StoredEvent extends Event {
  id: string;
  persisted_at: string;
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

export class EventStore {
  private db!: Database.Database;
  private responses = new EventEmitter();

  init(dbPath: string): void {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

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
    `);
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

  listRecentDecisions(limit = 20): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT correlation_id FROM decisions ORDER BY requested_at DESC LIMIT ?`)
      .all(limit) as Array<{ correlation_id: string }>;
    return rows.map((r) => this.getDecision(r.correlation_id)!).filter(Boolean);
  }
}
