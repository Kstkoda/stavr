import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Broker } from '../../src/broker.js';
import { EventStore } from '../../src/persistence.js';
import {
  HELP_TEXT,
  KNOWN_COMMANDS,
  dispatchDirective,
  parseDirective,
  type TgMessage,
} from '../../src/notify/telegram-directives.js';
import { RateLimiter } from '../../src/notify/rate-limit.js';

const AUTH_CHAT = '8739810100';

function tgMessage(text: string, chatId: number | string = Number(AUTH_CHAT)): TgMessage {
  return {
    message_id: 42,
    date: 1_715_000_000,
    chat: { id: Number(chatId), type: 'private' },
    from: { id: Number(chatId), username: 'kenneth' },
    text,
  };
}

describe('v0.6.X parseDirective — command grammar', () => {
  it('parses bare command words with no body', () => {
    for (const cmd of KNOWN_COMMANDS) {
      const p = parseDirective(`/${cmd}`);
      expect(p.kind).toBe(cmd);
      expect(p.text).toBe('');
    }
  });

  it('parses command + body, trimming whitespace', () => {
    const p = parseDirective('/steward   investigate the May-15 zombies   ');
    expect(p.kind).toBe('steward');
    expect(p.text).toBe('investigate the May-15 zombies');
  });

  it('recognises the four BOM commands and only those', () => {
    expect(parseDirective('/steward x').kind).toBe('steward');
    expect(parseDirective('/scope x').kind).toBe('scope');
    expect(parseDirective('/status').kind).toBe('status');
    expect(parseDirective('/ask x').kind).toBe('ask');
    expect(parseDirective('/xyz').kind).toBe('help');
    expect(parseDirective('/help').kind).toBe('help');
  });

  it('strips bot-username suffix from command word', () => {
    // Telegram supports `/cmd@botname args` to disambiguate in group chats.
    const p = parseDirective('/steward@stavr_bot do the thing');
    expect(p.kind).toBe('steward');
    expect(p.text).toBe('do the thing');
  });

  it('is case-insensitive on the command word but preserves body case', () => {
    const p = parseDirective('/STEWARD Investigate the Zombies');
    expect(p.kind).toBe('steward');
    expect(p.text).toBe('Investigate the Zombies');
  });

  it('treats empty / whitespace-only messages as empty', () => {
    expect(parseDirective('').kind).toBe('empty');
    expect(parseDirective('   ').kind).toBe('empty');
    expect(parseDirective(null).kind).toBe('empty');
    expect(parseDirective(undefined).kind).toBe('empty');
  });

  it('treats non-slash messages as help', () => {
    expect(parseDirective('hello bot').kind).toBe('help');
    expect(parseDirective('xyz').kind).toBe('help');
  });
});

describe('v0.6.X dispatchDirective — auth + audit', () => {
  let store: EventStore;
  let broker: Broker;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    rateLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });
  });

  afterEach(() => {
    store.close();
  });

  it('rejects non-operator chat with silent drop + audit event', async () => {
    const msg = tgMessage('/steward act on this', 99999); // wrong chat
    const parsed = parseDirective(msg.text);
    const outcome = await dispatchDirective(msg, parsed, {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
    });
    expect(outcome.reply).toBeUndefined();
    expect(outcome.rejectReason).toBe('wrong_chat_id');
    // Audit event with chat_id should be in the store.
    const events = store.getEvents({ kinds: ['telegram_directive_rejected'], limit: 10 }).events;
    expect(events.length).toBe(1);
    const payload = events[0].payload as { chat_id: string; reason: string };
    expect(payload.chat_id).toBe('99999');
    expect(payload.reason).toBe('wrong_chat_id');
  });

  it('rate-limits within window and emits audit event on rejection', async () => {
    rateLimiter = new RateLimiter({ max: 2, windowMs: 60_000 });
    const parsed = parseDirective('/status');
    // First two pass.
    const a = await dispatchDirective(tgMessage('/status'), parsed, {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
    });
    expect(a.reply).toBeDefined();
    expect(a.rejectReason).toBeUndefined();
    const b = await dispatchDirective(tgMessage('/status'), parsed, {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
    });
    expect(b.rejectReason).toBeUndefined();
    // Third hits the limit.
    const c = await dispatchDirective(tgMessage('/status'), parsed, {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
    });
    expect(c.rejectReason).toBe('rate_limit');
    expect(c.reply).toContain('Rate limit');
    const rej = store.getEvents({ kinds: ['telegram_directive_rejected'], limit: 10 }).events;
    expect(rej.length).toBe(1);
    expect((rej[0].payload as { reason: string }).reason).toBe('rate_limit');
  });
});

describe('v0.6.X dispatchDirective — emission per command', () => {
  let store: EventStore;
  let broker: Broker;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    rateLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });
  });

  afterEach(() => {
    store.close();
  });

  async function dispatch(text: string) {
    const msg = tgMessage(text);
    const parsed = parseDirective(text);
    return dispatchDirective(msg, parsed, {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
    });
  }

  it('/steward emits operator_directive and replies with id confirmation', async () => {
    const out = await dispatch('/steward investigate the May-15 zombies');
    expect(out.emitted).toBe(true);
    expect(out.emittedKind).toBe('operator_directive');
    expect(out.reply).toMatch(/Directive received/);
    const evs = store.getEvents({ kinds: ['operator_directive'], limit: 10 }).events;
    expect(evs.length).toBe(1);
    const p = evs[0].payload as { text: string; source: string; chat_id: string };
    expect(p.text).toBe('investigate the May-15 zombies');
    expect(p.source).toBe('telegram');
    expect(p.chat_id).toBe(AUTH_CHAT);
  });

  it('/scope emits operator_scope_request', async () => {
    const out = await dispatch('/scope review-only access to apps/web for the next hour');
    expect(out.emittedKind).toBe('operator_scope_request');
    const evs = store.getEvents({ kinds: ['operator_scope_request'], limit: 10 }).events;
    expect(evs.length).toBe(1);
    expect((evs[0].payload as { text: string }).text).toContain('review-only access');
  });

  it('/ask emits operator_ask', async () => {
    const out = await dispatch('/ask what workers are running?');
    expect(out.emittedKind).toBe('operator_ask');
    const evs = store.getEvents({ kinds: ['operator_ask'], limit: 10 }).events;
    expect(evs.length).toBe(1);
    expect((evs[0].payload as { text: string }).text).toBe('what workers are running?');
    expect(out.reply).toMatch(/Question received/);
  });

  it('/status replies WITHOUT emitting an event (read-only)', async () => {
    const out = await dispatch('/status');
    expect(out.emitted).toBe(false);
    expect(out.reply).toBeDefined();
    // Status reply uses fallback when no provider configured.
    expect(out.reply).toContain('daemon reachable');
    const all = store.getEvents({ limit: 50 }).events;
    expect(all.length).toBe(0);
  });

  it('/status uses the operator-supplied status provider when present', async () => {
    const msg = tgMessage('/status');
    const out = await dispatchDirective(msg, parseDirective('/status'), {
      broker,
      authorisedChatId: AUTH_CHAT,
      rateLimiter,
      statusProvider: () =>
        'stavR · Healthy · 12m uptime · 3 active workers · 0 pending decisions',
    });
    expect(out.reply).toContain('12m uptime');
    expect(out.reply).toContain('3 active workers');
  });

  it('unrecognised slash command replies with help text and emits nothing', async () => {
    const out = await dispatch('/xyz some text');
    expect(out.emitted).toBe(false);
    expect(out.reply).toBe(HELP_TEXT);
    expect(out.reply).toContain('/steward');
    expect(out.reply).toContain('/scope');
    expect(out.reply).toContain('/status');
    expect(out.reply).toContain('/ask');
  });

  it('free-text (no slash) replies with help text', async () => {
    const out = await dispatch('hello bot what do you do');
    expect(out.emitted).toBe(false);
    expect(out.reply).toBe(HELP_TEXT);
  });

  it('bare /steward with no body replies with usage hint, emits nothing', async () => {
    const out = await dispatch('/steward');
    expect(out.emitted).toBe(false);
    expect(out.reply).toMatch(/Usage:.*\/steward/s);
    expect(store.getEvents({ kinds: ['operator_directive'], limit: 10 }).events.length).toBe(0);
  });

  it('bare /scope and /ask with no body also reply with usage hints', async () => {
    const scope = await dispatch('/scope');
    expect(scope.emitted).toBe(false);
    expect(scope.reply).toMatch(/Usage:.*\/scope/s);
    const ask = await dispatch('/ask');
    expect(ask.emitted).toBe(false);
    expect(ask.reply).toMatch(/Usage:.*\/ask/s);
  });

  it('empty message emits nothing and replies with help', async () => {
    const out = await dispatch('');
    expect(out.emitted).toBe(false);
    expect(out.reply).toBe(HELP_TEXT);
  });
});
