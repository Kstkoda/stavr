// ntfy.sh HTTP publisher. Topic name IS the auth (Footgun #1).
//
// Severity → Priority mapping (per BOM §P1 channels): info=3, warn=4, crit=5.
// Actions header encodes reply buttons as `http, Approve, <url>; http, Deny, <url>`.

import { request } from 'node:https';
import { URL } from 'node:url';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
  NotificationSeverity,
} from '../types.js';

const PRIORITY: Record<NotificationSeverity, number> = { info: 3, warn: 4, crit: 5 };

export interface NtfyChannelOpts {
  topic?: string;
  /** ntfy server base, defaults to https://ntfy.sh */
  server?: string;
  /** Override the HTTP transport (tests). */
  transport?: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;
}

export class NtfyChannel implements NotificationChannel {
  readonly id = 'ntfy';
  private topic?: string;
  private server: string;
  private transport: NonNullable<NtfyChannelOpts['transport']>;

  constructor(opts: NtfyChannelOpts = {}) {
    this.topic = opts.topic ?? process.env.STAVR_NOTIFY_NTFY_TOPIC;
    this.server = opts.server ?? process.env.STAVR_NOTIFY_NTFY_SERVER ?? 'https://ntfy.sh';
    this.transport = opts.transport ?? defaultHttpsTransport;
  }

  isConfigured(): boolean {
    return !!this.topic && this.topic.length >= 8;
  }

  async send(input: ChannelSendInput): Promise<NotificationDispatch> {
    if (!this.isConfigured()) {
      return { channelId: this.id, ok: false, error: 'topic not configured' };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: stripHeaderUnsafe(`${input.severityLabel} ${input.title}`),
      Priority: String(PRIORITY[input.severity]),
      Tags: input.kind,
    };
    if (input.actions.length > 0) {
      const encoded = input.actions
        .filter((a) => a.kind !== 'link' || a.url)
        .slice(0, 3)
        .map((a) => {
          const target = a.kind === 'link' ? a.url! : input.replyUrls[a.action_id];
          if (!target) return null;
          return `http, ${stripHeaderUnsafe(a.label)}, ${target}, clear=true`;
        })
        .filter((s): s is string => !!s)
        .join('; ');
      if (encoded) headers.Actions = encoded;
    }
    const url = `${this.server}/${encodeURIComponent(this.topic!)}`;
    try {
      const res = await this.transport(url, headers, input.body);
      if (res.status >= 200 && res.status < 300) {
        return { channelId: this.id, ok: true };
      }
      return { channelId: this.id, ok: false, error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
    } catch (err) {
      return { channelId: this.id, ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Sanitize an arbitrary string for use as an HTTP header value.
 *
 * Node's `http.ClientRequest` rejects any character outside latin-1 with
 * `ERR_INVALID_CHAR` — emoji or other multibyte UTF-8 in a Title field will
 * tear down the entire notification dispatch (operator observed
 * `Invalid character in header content ["Title"]` on 2026-05-16). Beyond that,
 * CR/LF must be stripped to prevent header injection.
 *
 * We keep it conservative: only printable ASCII (0x20–0x7E) is preserved.
 * Non-ASCII codepoints are replaced with '?'. This loses emoji content but
 * preserves delivery — much better than the dispatch silently failing.
 */
function stripHeaderUnsafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (code === 0x09) {
      out += ' ';
    } else {
      out += '?';
    }
  }
  return out.slice(0, 250);
}

function defaultHttpsTransport(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
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
      req.destroy(new Error('ntfy request timeout'));
    });
    req.write(body);
    req.end();
  });
}
