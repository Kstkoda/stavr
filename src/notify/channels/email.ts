// SMTP email channel. Lazy-loads nodemailer so the daemon can boot without the
// dep being installed (channel reports as not-configured if import fails).
//
// Plain text + minimal HTML — one button per action linking to /notify/reply
// with the signed cid embedded. No images, no tracking pixels (BOM hard rule).

import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../types.js';

export interface EmailChannelOpts {
  from?: string;
  to?: string;
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  /** Test override — returns ok or a thrown error. */
  sender?: (msg: EmailMessage) => Promise<void>;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class EmailChannel implements NotificationChannel {
  readonly id = 'email';
  private from?: string;
  private to?: string;
  private host?: string;
  private port: number;
  private user?: string;
  private pass?: string;
  private secure: boolean;
  private senderOverride?: NonNullable<EmailChannelOpts['sender']>;
  private cachedTransport?: { sendMail: (msg: EmailMessage) => Promise<unknown> } | null;

  constructor(opts: EmailChannelOpts = {}) {
    this.from = opts.from ?? process.env.STAVR_NOTIFY_EMAIL_FROM;
    this.to = opts.to ?? process.env.STAVR_NOTIFY_EMAIL_TO;
    this.host = opts.host ?? process.env.STAVR_NOTIFY_EMAIL_SMTP_HOST;
    this.port = opts.port ?? Number(process.env.STAVR_NOTIFY_EMAIL_SMTP_PORT ?? 587);
    this.user = opts.user ?? process.env.STAVR_NOTIFY_EMAIL_SMTP_USER;
    this.pass = opts.pass ?? process.env.STAVR_NOTIFY_EMAIL_SMTP_PASS;
    this.secure = opts.secure ?? this.port === 465;
    this.senderOverride = opts.sender;
  }

  isConfigured(): boolean {
    return !!this.from && !!this.to && !!this.host && !!this.user && !!this.pass;
  }

  async send(input: ChannelSendInput): Promise<NotificationDispatch> {
    if (!this.isConfigured()) {
      return { channelId: this.id, ok: false, error: 'email channel not configured' };
    }
    const msg = renderEmail(input, this.from!, this.to!);
    try {
      if (this.senderOverride) {
        await this.senderOverride(msg);
        return { channelId: this.id, ok: true };
      }
      const transport = await this.getTransport();
      if (!transport) {
        return { channelId: this.id, ok: false, error: 'nodemailer not installed' };
      }
      await transport.sendMail(msg);
      return { channelId: this.id, ok: true };
    } catch (err) {
      return { channelId: this.id, ok: false, error: (err as Error).message };
    }
  }

  private async getTransport(): Promise<{ sendMail: (msg: EmailMessage) => Promise<unknown> } | null> {
    if (this.cachedTransport !== undefined) return this.cachedTransport;
    try {
      const mod = (await import('nodemailer')) as unknown as {
        default?: { createTransport: (opts: unknown) => { sendMail: (msg: EmailMessage) => Promise<unknown> } };
        createTransport?: (opts: unknown) => { sendMail: (msg: EmailMessage) => Promise<unknown> };
      };
      const createTransport = mod.default?.createTransport ?? mod.createTransport;
      if (!createTransport) {
        this.cachedTransport = null;
        return null;
      }
      this.cachedTransport = createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth: { user: this.user, pass: this.pass },
      });
      return this.cachedTransport;
    } catch {
      this.cachedTransport = null;
      return null;
    }
  }
}

export function renderEmail(input: ChannelSendInput, from: string, to: string): EmailMessage {
  const subject = `${input.severityLabel} ${input.title}`.slice(0, 200);
  const lines: string[] = [input.body, ''];
  const htmlButtons: string[] = [];
  for (const a of input.actions) {
    const url = a.kind === 'link' ? a.url : input.replyUrls[a.action_id];
    if (!url) continue;
    lines.push(`${a.label}: ${url}`);
    const colour = a.kind === 'approve' ? '#1a7f37' : a.kind === 'deny' ? '#a40e26' : '#3b3b3b';
    htmlButtons.push(
      `<a href="${escapeHtml(url)}" style="display:inline-block;padding:8px 14px;margin:4px 6px 4px 0;background:${colour};color:#fff;text-decoration:none;border-radius:6px;font-family:monospace;">${escapeHtml(a.label)}</a>`,
    );
  }
  const html =
    `<div style="font-family:sans-serif;max-width:560px;">` +
    `<p style="font-family:monospace;color:#666;margin:0 0 8px 0;">${escapeHtml(input.severityLabel)}</p>` +
    `<h2 style="margin:0 0 12px 0;">${escapeHtml(input.title)}</h2>` +
    `<pre style="background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;">${escapeHtml(input.body)}</pre>` +
    (htmlButtons.length > 0 ? `<div style="margin-top:12px;">${htmlButtons.join('')}</div>` : '') +
    `<p style="color:#888;font-size:12px;margin-top:18px;">stavR notification — reply links expire in 5 min.</p>` +
    `</div>`;
  return { from, to, subject, text: lines.join('\n'), html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
