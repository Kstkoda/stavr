// Telegram Bot API sendMessage publisher. Inline keyboard buttons carry the
// signed cid + action_id in callback_data; the long poller (P3) consumes them.

import { request } from 'node:https';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../types.js';

export interface TelegramChannelOpts {
  botToken?: string;
  chatId?: string;
  transport?: (path: string, body: string) => Promise<{ status: number; body: string }>;
}

export class TelegramChannel implements NotificationChannel {
  readonly id = 'telegram';
  private botToken?: string;
  private chatId?: string;
  private transport: NonNullable<TelegramChannelOpts['transport']>;

  constructor(opts: TelegramChannelOpts = {}) {
    this.botToken = opts.botToken ?? process.env.STAVR_NOTIFY_TELEGRAM_BOT_TOKEN;
    this.chatId = opts.chatId ?? process.env.STAVR_NOTIFY_TELEGRAM_CHAT_ID;
    this.transport = opts.transport ?? defaultTelegramTransport;
  }

  isConfigured(): boolean {
    return !!this.botToken && !!this.chatId;
  }

  async send(input: ChannelSendInput): Promise<NotificationDispatch> {
    if (!this.isConfigured()) {
      return { channelId: this.id, ok: false, error: 'bot token or chat_id missing' };
    }
    const keyboard = buildInlineKeyboard(input);
    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text: `${input.severityLabel} ${input.title}\n\n${input.body}`,
      disable_web_page_preview: true,
    };
    if (keyboard.length > 0) payload.reply_markup = { inline_keyboard: keyboard };
    const body = JSON.stringify(payload);
    try {
      const res = await this.transport(`/bot${this.botToken}/sendMessage`, body);
      if (res.status >= 200 && res.status < 300) {
        return { channelId: this.id, ok: true };
      }
      return { channelId: this.id, ok: false, error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
    } catch (err) {
      return { channelId: this.id, ok: false, error: (err as Error).message };
    }
  }
}

interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

function buildInlineKeyboard(input: ChannelSendInput): InlineButton[][] {
  const rows: InlineButton[][] = [];
  let row: InlineButton[] = [];
  for (const a of input.actions.slice(0, 6)) {
    if (a.kind === 'link') {
      if (a.url) row.push({ text: a.label, url: a.url });
    } else {
      // Telegram callback_data max 64 bytes. Signed cids are long; pass only
      // the action_id + first 50 chars of cid (poller looks up by prefix).
      const cb = `${input.correlationId.slice(0, 50)}:${a.action_id.slice(0, 12)}`;
      row.push({ text: a.label, callback_data: cb });
    }
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function defaultTelegramTransport(
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        port: 443,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('telegram request timeout'));
    });
    req.write(body);
    req.end();
  });
}
