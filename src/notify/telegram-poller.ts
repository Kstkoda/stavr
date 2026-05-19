// v0.6 P3 — Telegram long-poll for inline-keyboard callback_query.
//
// Single timer, 30s interval, calls /getUpdates with offset. For each callback:
//   1. Parse callback_data → (cid_prefix, action_id)
//   2. Match cid_prefix against persisted notifications (full signed cid was
//      truncated for the 64-byte callback_data limit — prefix lookup is fine
//      since cid prefixes are random + globally unique within a 5-min window)
//   3. Verify HMAC on the full signed cid, then run the same consume + route
//      path the HTTP webhook uses (no special-case auth)
//   4. answerCallbackQuery with a confirmation toast
//
// Note on the verify step: we re-look-up the full signed_cid from the DB
// (`correlation_id LIKE 'prefix%'`) and re-verify. The prefix is NOT trusted as
// auth — verify still requires the full signature, which we read from DB.

import { request } from 'node:https';
import type Database from 'better-sqlite3';
import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';
import { verifyCorrelationId } from './correlation.js';
import {
  dispatchDirective,
  parseDirective,
  type TgMessage,
} from './telegram-directives.js';
import type { Notifier } from './notifier.js';
import type { RateLimiter } from './rate-limit.js';
import type { ReplyRouter } from './reply-router.js';
import type { NotificationAction, NotificationRecord } from './types.js';

export interface TelegramPollerOpts {
  botToken?: string;
  notifier: Notifier;
  router: ReplyRouter;
  secret: string;
  /** DB handle for prefix→full-cid lookup. */
  db: Database.Database;
  /** Test override for HTTPS. */
  transport?: TgTransport;
  /** Poll interval ms. */
  intervalMs?: number;
  // v0.6.X — operator-directive plumbing. Optional so existing call sites
  // that only need callback_query handling keep working unchanged. When
  // both broker + authorisedChatId are set, the poller subscribes to
  // `message` updates and routes them through the directive dispatcher.
  /** Broker for publishing operator_directive / operator_scope_request /
   *  operator_ask / telegram_directive_rejected events. */
  broker?: Broker;
  /** Chat-id allowlist for directives. Must equal
   *  `STAVR_NOTIFY_TELEGRAM_CHAT_ID` (compared as string). Required for
   *  directive handling — if absent, message updates are ignored. */
  authorisedChatId?: string;
  /** Rate limiter for directives (30 req/min/chat_id by default). Shared
   *  with `/notify/reply` so a busy reply burst pre-empts directive
   *  bandwidth. Required when authorisedChatId is set. */
  directiveRateLimiter?: RateLimiter;
  /** Optional synchronous status fetcher for `/status` replies. */
  statusProvider?: () => string;
}

export type TgTransport = (path: string, body: string) => Promise<{ status: number; body: string }>;

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from?: { id: number; username?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
  /** v0.6.X — text messages routed through telegram-directives.ts. */
  message?: TgMessage;
}

export class TelegramPoller {
  private timer?: NodeJS.Timeout;
  private offset = 0;
  private readonly transport: TgTransport;
  private readonly intervalMs: number;

  constructor(private readonly opts: TelegramPollerOpts) {
    this.transport = opts.transport ?? defaultTransport;
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  isConfigured(): boolean {
    return !!this.opts.botToken;
  }

  start(): void {
    if (this.timer || !this.isConfigured()) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) =>
        getLogger().warn('telegram-poller: tick failed', { error: (err as Error).message }),
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** True when broker + chat-id + rate-limiter are all configured. Gates
   *  message-update subscription so an unconfigured deploy doesn't accept
   *  directives. */
  private directivesEnabled(): boolean {
    return (
      !!this.opts.broker &&
      !!this.opts.authorisedChatId &&
      !!this.opts.directiveRateLimiter
    );
  }

  async pollOnce(): Promise<number> {
    if (!this.isConfigured()) return 0;
    // Subscribe to both update types when directives are enabled — otherwise
    // stay on the original callback-only mode (pre-v0.6.X behavior).
    const allowed = this.directivesEnabled()
      ? '["callback_query","message"]'
      : '["callback_query"]';
    const path = `/bot${this.opts.botToken}/getUpdates?offset=${this.offset}&timeout=0&allowed_updates=${encodeURIComponent(allowed)}`;
    let res: { status: number; body: string };
    try {
      res = await this.transport(path, '');
    } catch (err) {
      getLogger().warn('telegram-poller: getUpdates failed', { error: (err as Error).message });
      return 0;
    }
    if (res.status !== 200) return 0;
    let parsed: { ok?: boolean; result?: TgUpdate[] };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return 0;
    }
    if (!parsed.ok || !Array.isArray(parsed.result)) return 0;
    let handled = 0;
    for (const u of parsed.result) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      try {
        if (u.callback_query?.data) {
          const ok = await this.handleCallback(u.callback_query);
          if (ok) handled++;
        } else if (u.message && this.directivesEnabled()) {
          const ok = await this.handleMessage(u.message);
          if (ok) handled++;
        }
      } catch (err) {
        getLogger().warn('telegram-poller: handler threw', { error: (err as Error).message });
      }
    }
    return handled;
  }

  /**
   * Route a `message` update through the directive parser/dispatcher and
   * send the dispatcher's reply (if any) back via `sendMessage`. Returns
   * true if either an event was emitted or a reply was sent — false only
   * when the message was silently dropped (auth gate against a non-
   * operator chat, per the BOM's "bot existence unconfirmable" rule).
   */
  private async handleMessage(message: TgMessage): Promise<boolean> {
    if (!this.directivesEnabled()) return false;
    const broker = this.opts.broker!;
    const authChat = this.opts.authorisedChatId!;
    const rl = this.opts.directiveRateLimiter!;
    const parsed = parseDirective(message.text);
    const outcome = await dispatchDirective(message, parsed, {
      broker,
      authorisedChatId: authChat,
      rateLimiter: rl,
      statusProvider: this.opts.statusProvider,
    });
    if (outcome.reply) {
      await this.sendMessage(message.chat.id, outcome.reply);
    }
    return outcome.emitted || !!outcome.reply;
  }

  /** Send a plain-text reply to a Telegram chat. Fire-and-forget — errors
   *  are logged but never propagated (the directive event-log entry is
   *  already in place; a failed reply doesn't roll that back). */
  private async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      const body = JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_notification: false,
      });
      await this.transport(`/bot${this.opts.botToken}/sendMessage`, body);
    } catch (err) {
      getLogger().warn('telegram-poller: sendMessage failed', {
        chat_id: chatId,
        error: (err as Error).message,
      });
    }
  }

  private async handleCallback(cb: NonNullable<TgUpdate['callback_query']>): Promise<boolean> {
    if (!cb.data) return false;
    // callback_data is `${cidPrefix}:${action_id}`. cidPrefix is b64url + a
    // single dot (no colons), so first-colon split correctly recovers both
    // halves even when the action_id itself contains colons (e.g. 'decision:yes').
    const sep = cb.data.indexOf(':');
    if (sep === -1) return false;
    const cidPrefix = cb.data.slice(0, sep);
    const actionIdShort = cb.data.slice(sep + 1);

    const row = this.opts.db
      .prepare(`SELECT * FROM notifications WHERE correlation_id LIKE ? LIMIT 1`)
      .get(`${cidPrefix}%`) as NotificationRecord | undefined;
    if (!row) {
      await this.answerCallback(cb.id, 'Not found');
      return false;
    }
    const fullCid = row.correlation_id;
    const verify = verifyCorrelationId(fullCid, this.opts.secret);
    if (!verify.ok) {
      await this.answerCallback(cb.id, verify.reason === 'expired' ? 'Expired' : 'Invalid');
      return false;
    }
    if (row.consumed_at) {
      await this.answerCallback(cb.id, 'Already responded');
      return false;
    }
    if (row.expires_at && row.expires_at < Date.now()) {
      await this.answerCallback(cb.id, 'Expired');
      return false;
    }
    const actions = parseActions(row);
    // callback_data carries truncated action_id (P1 telegram.ts limits to 12 chars).
    const matched = actions.find((a) => a.action_id === actionIdShort || a.action_id.startsWith(actionIdShort));
    if (!matched) {
      await this.answerCallback(cb.id, 'Bad action');
      return false;
    }
    const chatId = cb.message?.chat.id ?? cb.from?.id ?? 0;
    const claimed = this.opts.notifier.markConsumed(fullCid, `telegram:${chatId}`);
    if (!claimed) {
      await this.answerCallback(cb.id, 'Already responded');
      return false;
    }
    const result = await this.opts.router.route({
      notificationId: row.id,
      notificationCorrelationId: fullCid,
      source: 'telegram',
      sourceLabel: String(chatId),
      actionId: matched.action_id,
      actions,
    });
    await this.answerCallback(cb.id, result.ok ? `Recorded: ${matched.label}` : 'Failed');
    return result.ok;
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    try {
      const body = JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) });
      await this.transport(`/bot${this.opts.botToken}/answerCallbackQuery`, body);
    } catch {
      // Best-effort — toast failures are not fatal.
    }
  }
}

function parseActions(row: NotificationRecord): NotificationAction[] {
  if (!row.actions_json) return [];
  try {
    const parsed = JSON.parse(row.actions_json) as NotificationAction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function defaultTransport(path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const isGet = body.length === 0;
    const req = request(
      {
        method: isGet ? 'GET' : 'POST',
        hostname: 'api.telegram.org',
        port: 443,
        path,
        headers: isGet
          ? {}
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body).toString(),
            },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('telegram poller timeout')));
    if (!isGet) req.write(body);
    req.end();
  });
}
