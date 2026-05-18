// v0.6.X — Telegram operator directives.
//
// Operators can send free-text instructions to the bot in addition to the
// inline-keyboard taps the existing poller (telegram-poller.ts) handles.
// This module is the pure parser + dispatcher: it takes a Telegram
// `message` event, classifies it against the BOM command grammar, and
// emits the appropriate event-log entry. Auth is by chat_id match against
// `STAVR_NOTIFY_TELEGRAM_CHAT_ID` — only the configured operator can issue
// directives.
//
// Grammar (BOM v0_6_X-telegram-operator-directives-bom.md §"Command grammar"):
//   /steward <text>  → operator_directive          (free-form planning prompt)
//   /scope <text>    → operator_scope_request      (ask Steward to propose a scope)
//   /status          → no event; synchronous reply via Telegram
//   /ask <text>      → operator_ask                (one-shot synchronous Q→A)
//   anything else    → no event; help-message reply
//
// Rejections from non-operator chats emit `telegram_directive_rejected`
// (chat_id + reason) so audit logging still captures the attempt. The bot
// itself never replies to a rejected chat — keeps the bot's existence
// unconfirmable to non-operators.

import type { Broker } from '../broker.js';
import { getLogger } from '../log.js';
import type { RateLimiter } from './rate-limit.js';

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type?: string };
  from?: { id: number; username?: string };
  text?: string;
}

export type DirectiveKind =
  | 'steward'
  | 'scope'
  | 'status'
  | 'ask'
  | 'help'
  | 'empty';

export interface ParsedDirective {
  kind: DirectiveKind;
  /** Text after the command word, trimmed. Always present for steward / scope / ask. */
  text: string;
  /** The raw input message text (without leading slash trimming). */
  raw: string;
}

/** The set of commands the parser recognises. Anything else falls through to
 *  `help` and produces a help-message reply (no audit event). */
export const KNOWN_COMMANDS: ReadonlyArray<DirectiveKind> = [
  'steward',
  'scope',
  'status',
  'ask',
];

/** Help text returned for unrecognised messages. Kept short (Telegram has a
 *  4096-char message cap; we fit comfortably under any reasonable client UI). */
export const HELP_TEXT = [
  'stavR bot commands:',
  '',
  '  /steward <text>  — ask Steward to act on a directive',
  '  /scope <text>    — ask Steward to propose a trust scope',
  '  /status          — daemon health snapshot',
  '  /ask <text>      — one-shot question, sync answer',
  '',
  'Replies are audit-logged.',
].join('\n');

/**
 * Parse a Telegram message into a typed directive.
 *
 * Empty message → `{kind:'empty'}`. Unrecognised → `{kind:'help'}`. Recognised
 * with a missing body (e.g. bare `/steward`) → command kind with empty `text`,
 * so the dispatcher can decide whether to reply with usage hint or treat it
 * as malformed.
 */
export function parseDirective(rawText: string | undefined | null): ParsedDirective {
  const raw = (rawText ?? '').trim();
  if (!raw) {
    return { kind: 'empty', text: '', raw: '' };
  }
  if (!raw.startsWith('/')) {
    return { kind: 'help', text: '', raw };
  }
  // Telegram lets users tag commands with the bot's username after `@` —
  // `/steward@stavr_bot ...` should still parse as `/steward`. The split
  // approach normalises that.
  const spaceIdx = raw.indexOf(' ');
  const head = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
  const body = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim();
  const commandWord = head.replace(/^\//, '').split('@')[0].toLowerCase();
  if (!KNOWN_COMMANDS.includes(commandWord as DirectiveKind)) {
    return { kind: 'help', text: body, raw };
  }
  return { kind: commandWord as DirectiveKind, text: body, raw };
}

/** Decision shape from the dispatcher — tells the caller (the poller) what,
 *  if anything, to send back over Telegram. The dispatcher publishes events
 *  to the broker as a side effect; this struct is purely for the inline
 *  reply path. */
export interface DispatchOutcome {
  /** True if at least one event was published. */
  emitted: boolean;
  /** Text to send back to the operator over Telegram, or undefined for silent. */
  reply: string | undefined;
  /** Kind of event published, if any. */
  emittedKind?: string;
  /** Set when the dispatcher itself rejects the message (auth, rate, malformed).
   *  The poller can log this at warn; production callers do not relay it. */
  rejectReason?: 'wrong_chat_id' | 'rate_limit' | 'malformed';
}

export interface DispatcherOpts {
  /** Broker used to publish events. */
  broker: Broker;
  /** Chat-id allowlist — only this chat is authorised to issue directives.
   *  Compared by string equality (Telegram's chat_id is a number but stored
   *  as a string in env). */
  authorisedChatId: string;
  /** Rate limiter — keyed by chat_id. Reuse the same limiter as
   *  `/notify/reply` (30 req/min). */
  rateLimiter: RateLimiter;
  /** Synchronous status fetcher (returns a short health summary). Lets the
   *  caller decide what state to expose without coupling this module to the
   *  daemon's internals. */
  statusProvider?: () => string;
}

const STATUS_FALLBACK = 'stavR · daemon reachable (no detailed health provider configured)';

/**
 * Dispatch a parsed directive into the event log, returning what (if
 * anything) to reply over Telegram.
 *
 * The dispatcher is pure synchronous-emit + read-only providers; it never
 * touches Telegram itself. The poller handles the actual Telegram I/O so
 * this module stays unit-testable without HTTP fixtures.
 */
export async function dispatchDirective(
  message: TgMessage,
  parsed: ParsedDirective,
  opts: DispatcherOpts,
): Promise<DispatchOutcome> {
  const chatId = String(message.chat.id);

  // Auth gate: only the configured operator's chat can issue directives.
  // Silent drop + audit on mismatch (BOM §"Authentication" — never reply to
  // non-operator chats so the bot's existence stays unconfirmable).
  if (chatId !== opts.authorisedChatId) {
    await safePublish(opts.broker, {
      kind: 'telegram_directive_rejected',
      source_agent: 'notify:telegram',
      at: new Date().toISOString(),
      payload: {
        chat_id: chatId,
        reason: 'wrong_chat_id',
        text_preview: (message.text ?? '').slice(0, 120),
      },
    });
    return { emitted: true, reply: undefined, rejectReason: 'wrong_chat_id' };
  }

  // Rate limit. Keyed by chat_id so a single rogue group member can't burn
  // budget for a parallel legitimate chat. The shared limiter with
  // /notify/reply means a busy reply burst pre-empts directive bandwidth —
  // acceptable per BOM §"Authentication".
  if (!opts.rateLimiter.check(`telegram:${chatId}`)) {
    await safePublish(opts.broker, {
      kind: 'telegram_directive_rejected',
      source_agent: 'notify:telegram',
      at: new Date().toISOString(),
      payload: {
        chat_id: chatId,
        reason: 'rate_limit',
        text_preview: (message.text ?? '').slice(0, 120),
      },
    });
    return {
      emitted: true,
      reply: 'Rate limit hit. Try again in a minute.',
      rejectReason: 'rate_limit',
    };
  }

  switch (parsed.kind) {
    case 'steward': {
      if (!parsed.text) {
        return { emitted: false, reply: 'Usage: /steward <text>\nExample: /steward investigate the May-15 zombies' };
      }
      const stored = await safePublish(opts.broker, {
        kind: 'operator_directive',
        source_agent: 'notify:telegram',
        at: new Date().toISOString(),
        payload: { text: parsed.text, source: 'telegram', chat_id: chatId },
      });
      return {
        emitted: !!stored,
        reply: `Directive received (id ${shortId(stored?.id)}). Steward will pick it up on its next cycle.`,
        emittedKind: 'operator_directive',
      };
    }
    case 'scope': {
      if (!parsed.text) {
        return { emitted: false, reply: 'Usage: /scope <text>\nExample: /scope review-only access to apps/web for the next hour' };
      }
      const stored = await safePublish(opts.broker, {
        kind: 'operator_scope_request',
        source_agent: 'notify:telegram',
        at: new Date().toISOString(),
        payload: { text: parsed.text, source: 'telegram', chat_id: chatId },
      });
      return {
        emitted: !!stored,
        reply: `Scope request received (id ${shortId(stored?.id)}). Steward will propose a scope shape; you'll get a Telegram message to Grant or Reject.`,
        emittedKind: 'operator_scope_request',
      };
    }
    case 'status': {
      const text = opts.statusProvider ? opts.statusProvider() : STATUS_FALLBACK;
      // No event for status — read-only. (BOM §"Command grammar".)
      return { emitted: false, reply: text };
    }
    case 'ask': {
      if (!parsed.text) {
        return { emitted: false, reply: 'Usage: /ask <text>\nExample: /ask what workers are running?' };
      }
      const stored = await safePublish(opts.broker, {
        kind: 'operator_ask',
        source_agent: 'notify:telegram',
        at: new Date().toISOString(),
        payload: { text: parsed.text, source: 'telegram', chat_id: chatId },
      });
      return {
        emitted: !!stored,
        reply: `Question received (id ${shortId(stored?.id)}). Steward will reply via Telegram within ~30 s.`,
        emittedKind: 'operator_ask',
      };
    }
    case 'help':
    case 'empty':
    default:
      return { emitted: false, reply: HELP_TEXT };
  }
}

/** Broker.publish() can throw on a misconfigured store. Wrap it so a single
 *  bad publish doesn't take the whole poller down. */
async function safePublish(
  broker: Broker,
  event: Parameters<Broker['publish']>[0],
): Promise<Awaited<ReturnType<Broker['publish']>> | undefined> {
  try {
    return await broker.publish(event);
  } catch (err) {
    getLogger().warn('telegram-directives: broker publish failed', {
      kind: event.kind,
      error: (err as Error).message,
    });
    return undefined;
  }
}

function shortId(id: string | undefined): string {
  if (!id) return '???';
  // First 8 chars of UUID/ULID; enough to disambiguate at a glance in chat.
  return id.replace(/-/g, '').slice(0, 8);
}
