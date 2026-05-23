// v0.6 — Notifier core.
//
// Outbound is fire-and-forget from the caller. Channel sends run in parallel
// inside `setImmediate` so the caller is never blocked (Footgun #7). Channel
// errors are recorded in `failed_channels` + the `notification_channels` row
// but never propagate.
//
// For `severity: 'crit'`, the notification row is persisted BEFORE channel
// dispatch so a daemon restart can replay (Footgun #12).

import type { Database } from '../db/index.js';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../log.js';
import { mintCorrelationId } from './correlation.js';
import type {
  ChannelSendInput,
  ChannelStatus,
  Notification,
  NotificationChannel,
  NotificationDispatch,
  NotificationKind,
  NotificationRecord,
  NotificationResult,
  NotificationSeverity,
} from './types.js';

const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: '[INFO]',
  warn: '[WARN]',
  crit: '[CRIT]',
};

const DEFAULT_TTL_BY_KIND: Partial<Record<NotificationKind, number>> = {
  decision_required: 5 * 60 * 1000,
  scope_expired: 30 * 60 * 1000,
  scope_expiring: 30 * 60 * 1000,
};

export interface NotifierOpts {
  /** Master signing secret used by correlation.ts. */
  secret: string;
  /** Base URL the daemon publishes on, e.g. http://localhost:3030. */
  replyBaseUrl?: string;
  /** SQLite handle (event store's rawDb). */
  db?: Database;
  /** Pluggable clock for tests. */
  now?: () => number;
  /**
   * Per-channel send timeout in ms. A channel that doesn't resolve within
   * this window is recorded as a failed dispatch and the closure is released.
   * Without this bound, a hanging HTTP channel retains the promise + caller
   * context indefinitely. Default 10_000.
   */
  channelTimeoutMs?: number;
}

const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000;

export class Notifier {
  private channels = new Map<string, NotificationChannel>();
  private readonly secret: string;
  private readonly replyBaseUrl?: string;
  private readonly db?: Database;
  private readonly now: () => number;
  private readonly channelTimeoutMs: number;

  constructor(opts: NotifierOpts) {
    if (!opts.secret) throw new Error('Notifier requires a signing secret');
    this.secret = opts.secret;
    this.replyBaseUrl = opts.replyBaseUrl;
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.channelTimeoutMs = opts.channelTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
  }

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.id, channel);
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO notification_channels (id, enabled, config_json) VALUES (?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
        )
        .run(channel.id, channel.isConfigured() ? 1 : 0);
    }
  }

  listChannels(): NotificationChannel[] {
    return [...this.channels.values()];
  }

  getChannelStatus(): ChannelStatus[] {
    const out: ChannelStatus[] = [];
    for (const ch of this.channels.values()) {
      const row = this.db
        ?.prepare(
          `SELECT enabled, last_success_at, last_error, last_error_at FROM notification_channels WHERE id = ?`,
        )
        .get(ch.id) as
        | { enabled: number; last_success_at: number | null; last_error: string | null; last_error_at: number | null }
        | undefined;
      out.push({
        id: ch.id,
        configured: ch.isConfigured(),
        enabled: row ? row.enabled === 1 : ch.isConfigured(),
        lastSuccessAt: row?.last_success_at ?? undefined,
        lastError: row?.last_error ?? undefined,
        lastErrorAt: row?.last_error_at ?? undefined,
      });
    }
    return out;
  }

  /**
   * Emit a notification across all configured + enabled channels.
   *
   * Returns once the row is persisted and dispatch is scheduled; channel
   * sends complete asynchronously and never throw at the caller.
   */
  async notify(n: Notification): Promise<NotificationResult> {
    const id = randomUUID();
    const ttlMs = n.ttlMs ?? DEFAULT_TTL_BY_KIND[n.kind];
    const minted = mintCorrelationId({ secret: this.secret, ttlMs });
    const createdAt = this.now();
    const actionsJson = n.actions ? JSON.stringify(n.actions) : null;

    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO notifications (id, created_at, correlation_id, kind, severity, title, body,
              source_event_id, actions_json, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          createdAt,
          minted.signedCid,
          n.kind,
          n.severity,
          n.title,
          n.body,
          n.sourceEventId ?? null,
          actionsJson,
          ttlMs ? minted.expiresAt : null,
        );
    }

    const replyUrls = this.buildReplyUrls(minted.signedCid, n.actions ?? []);
    const channelInput: ChannelSendInput = {
      notificationId: id,
      correlationId: minted.signedCid,
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      actions: n.actions ?? [],
      replyBaseUrl: this.replyBaseUrl,
      replyUrls,
      severityLabel: SEVERITY_LABEL[n.severity],
    };

    const eligible = [...this.channels.values()].filter((ch) => {
      if (!ch.isConfigured()) return false;
      const row = this.db
        ?.prepare(`SELECT enabled FROM notification_channels WHERE id = ?`)
        .get(ch.id) as { enabled: number } | undefined;
      // Channel defaults to enabled if not in DB.
      return row ? row.enabled === 1 : true;
    });

    // Crit notifications: await dispatch so caller can log delivered/failed in
    // their context. Otherwise return immediately and let dispatch run in bg.
    if (n.severity === 'crit') {
      const dispatches = await this.dispatchAll(eligible, channelInput);
      this.recordDispatch(id, dispatches);
      return this.buildResult(id, minted.signedCid, dispatches);
    }

    setImmediate(() => {
      this.dispatchAll(eligible, channelInput)
        .then((dispatches) => this.recordDispatch(id, dispatches))
        .catch((err) => {
          getLogger().warn('notifier: background dispatch threw', { error: (err as Error).message });
        });
    });

    return {
      id,
      correlationId: minted.signedCid,
      dispatchedChannels: eligible.map((c) => c.id),
      failedChannels: [],
      delivered: false,
    };
  }

  /** Look up a notification by signed correlation id (used by P3 inbound). */
  getNotificationByCorrelationId(signedCid: string): NotificationRecord | undefined {
    if (!this.db) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM notifications WHERE correlation_id = ?`)
      .get(signedCid) as NotificationRecord | undefined;
    return row;
  }

  /** Mark consumed; returns false if already consumed (caller returns 410). */
  markConsumed(signedCid: string, consumedBy: string): boolean {
    if (!this.db) return false;
    const r = this.db
      .prepare(
        `UPDATE notifications SET consumed_at = ?, consumed_by = ?
         WHERE correlation_id = ? AND consumed_at IS NULL`,
      )
      .run(this.now(), consumedBy, signedCid);
    return r.changes > 0;
  }

  private async dispatchAll(
    channels: NotificationChannel[],
    input: ChannelSendInput,
  ): Promise<NotificationDispatch[]> {
    const timeoutMs = this.channelTimeoutMs;
    const results = await Promise.all(
      channels.map(async (ch) => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        try {
          const timeoutPromise = new Promise<NotificationDispatch>((resolve) => {
            timeoutHandle = setTimeout(() => {
              resolve({
                channelId: ch.id,
                ok: false,
                error: `channel send timed out after ${timeoutMs}ms`,
              } satisfies NotificationDispatch);
            }, timeoutMs);
            timeoutHandle.unref?.();
          });
          return await Promise.race([ch.send(input), timeoutPromise]);
        } catch (err) {
          return { channelId: ch.id, ok: false, error: (err as Error).message } satisfies NotificationDispatch;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }),
    );
    return results;
  }

  private recordDispatch(notificationId: string, dispatches: NotificationDispatch[]): void {
    const delivered = dispatches.filter((d) => d.ok).map((d) => d.channelId);
    const failed = dispatches.filter((d) => !d.ok);
    if (this.db) {
      this.db
        .prepare(
          `UPDATE notifications SET delivered_channels = ?, failed_channels = ?, dispatched_at = ? WHERE id = ?`,
        )
        .run(
          delivered.join(',') || null,
          failed.map((f) => f.channelId).join(',') || null,
          this.now(),
          notificationId,
        );
      for (const d of dispatches) {
        if (d.ok) {
          this.db
            .prepare(
              `UPDATE notification_channels SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?`,
            )
            .run(this.now(), d.channelId);
        } else {
          this.db
            .prepare(
              `UPDATE notification_channels SET last_error = ?, last_error_at = ? WHERE id = ?`,
            )
            .run(d.error ?? 'unknown', this.now(), d.channelId);
        }
      }
    }
    for (const d of failed) {
      getLogger().warn('notifier: channel dispatch failed', {
        channel: d.channelId,
        notification_id: notificationId,
        error: d.error,
      });
    }
  }

  private buildResult(
    id: string,
    correlationId: string,
    dispatches: NotificationDispatch[],
  ): NotificationResult {
    const delivered = dispatches.filter((d) => d.ok).map((d) => d.channelId);
    const failed = dispatches.filter((d) => !d.ok).map((d) => d.channelId);
    return {
      id,
      correlationId,
      dispatchedChannels: delivered,
      failedChannels: failed,
      delivered: delivered.length > 0,
    };
  }

  private buildReplyUrls(
    correlationId: string,
    actions: { action_id: string; kind: string }[],
  ): Record<string, string> {
    if (!this.replyBaseUrl) return {};
    const out: Record<string, string> = {};
    for (const a of actions) {
      if (a.kind === 'link') continue;
      const u = new URL('/notify/reply', this.replyBaseUrl);
      u.searchParams.set('cid', correlationId);
      u.searchParams.set('action', a.action_id);
      out[a.action_id] = u.toString();
    }
    return out;
  }
}
