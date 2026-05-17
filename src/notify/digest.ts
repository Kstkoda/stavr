// v0.6 daily digest — morning summary across the last 24h.
//
// Counts decisions made, scopes granted/revoked, workers run, errors. Sends
// a single info-severity notification at the operator's configured hour
// (default 09:00 local timezone — see Footgun #6).
//
// Implementation is intentionally lightweight: a single setInterval ticking
// once a minute, checking whether we've crossed the configured hour:minute
// since the last fire. Daemon restarts within the same day re-arm the timer
// but won't fire a duplicate (last_fired_at persisted in meta table).

import type Database from 'better-sqlite3';
import { getLogger } from '../log.js';
import type { Notifier } from './notifier.js';

export interface DigestOpts {
  /** Hour 0-23 in operator local TZ. Default 9. */
  hour?: number;
  minute?: number;
  /** Override clock (tests). */
  now?: () => Date;
  /** SQLite handle for persisting last_fired_at. */
  db?: Database.Database;
}

const META_KEY = 'notify_digest_last_fired_ms';

export class DigestScheduler {
  private timer?: NodeJS.Timeout;
  private readonly hour: number;
  private readonly minute: number;
  private readonly now: () => Date;
  private readonly db?: Database.Database;
  private enabled = true;

  constructor(private readonly notifier: Notifier, opts: DigestOpts = {}) {
    this.hour = opts.hour ?? 9;
    this.minute = opts.minute ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.db = opts.db;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => {
      getLogger().warn('digest scheduler: tick threw', { error: (err as Error).message });
    }), 60_000);
    // setInterval's first fire is +60s; that's fine — digest is morning-only.
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  disable(): void {
    this.enabled = false;
  }

  enable(): void {
    this.enabled = true;
  }

  async tick(): Promise<boolean> {
    if (!this.enabled) return false;
    const now = this.now();
    const lastFiredMs = this.getLastFiredMs();
    if (lastFiredMs && now.getTime() - lastFiredMs < 23 * 60 * 60 * 1000) {
      return false;
    }
    if (now.getHours() !== this.hour) return false;
    if (now.getMinutes() < this.minute) return false;
    await this.fire();
    return true;
  }

  async fire(): Promise<void> {
    const stats = this.buildDigest();
    await this.notifier.notify({
      kind: 'digest',
      severity: 'info',
      title: `stavR daily digest — ${stats.dateLabel}`,
      body: this.formatBody(stats),
    });
    this.setLastFiredMs(this.now().getTime());
  }

  buildDigest(): DigestStats {
    const since = this.now().getTime() - 24 * 60 * 60 * 1000;
    const sinceIso = new Date(since).toISOString();
    const decisions = this.queryCount(`SELECT COUNT(*) AS n FROM decisions WHERE requested_at > ?`, [sinceIso]);
    const decisionsResponded = this.queryCount(
      `SELECT COUNT(*) AS n FROM decisions WHERE responded_at > ?`,
      [sinceIso],
    );
    const scopesGranted = this.queryCount(
      `SELECT COUNT(*) AS n FROM trust_scopes WHERE granted_at > ?`,
      [sinceIso],
    );
    const workersRun = this.queryCount(
      `SELECT COUNT(*) AS n FROM workers WHERE started_at > ?`,
      [sinceIso],
    );
    const errors = this.queryCount(`SELECT COUNT(*) AS n FROM events WHERE kind = 'error' AND at > ?`, [sinceIso]);
    return {
      dateLabel: this.now().toISOString().slice(0, 10),
      decisions,
      decisionsResponded,
      scopesGranted,
      workersRun,
      errors,
    };
  }

  formatBody(s: DigestStats): string {
    return [
      `Decisions:   ${s.decisionsResponded}/${s.decisions} answered`,
      `Scopes:      ${s.scopesGranted} granted`,
      `Workers:     ${s.workersRun} run`,
      `Errors:      ${s.errors}`,
    ].join('\n');
  }

  private queryCount(sql: string, params: unknown[]): number {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare(sql).get(...(params as [])) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  private getLastFiredMs(): number | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
        | { value: string }
        | undefined;
      if (!row) return undefined;
      const n = Number(row.value);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }

  private setLastFiredMs(ms: number): void {
    if (!this.db) return;
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(META_KEY, String(ms));
  }
}

export interface DigestStats {
  dateLabel: string;
  decisions: number;
  decisionsResponded: number;
  scopesGranted: number;
  workersRun: number;
  errors: number;
}
