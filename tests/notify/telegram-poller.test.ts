import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { Notifier } from '../../src/notify/notifier.js';
import { RateLimiter } from '../../src/notify/rate-limit.js';
import { ReplyRouter } from '../../src/notify/reply-router.js';
import { TelegramPoller, type TgTransport } from '../../src/notify/telegram-poller.js';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../../src/notify/types.js';

class CapChannel implements NotificationChannel {
  readonly id = 'cap';
  isConfigured(): boolean {
    return true;
  }
  async send(_input: ChannelSendInput): Promise<NotificationDispatch> {
    return { channelId: this.id, ok: true };
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

interface MockTransport extends TgTransport {
  calls: Array<{ path: string; body: string }>;
}

function mockTransport(responses: Array<{ status: number; body: string }>): MockTransport {
  const calls: Array<{ path: string; body: string }> = [];
  let i = 0;
  const fn: TgTransport = async (path, body) => {
    calls.push({ path, body });
    const res = responses[i] ?? responses[responses.length - 1] ?? { status: 200, body: '{"ok":true,"result":[]}' };
    i++;
    return res;
  };
  (fn as MockTransport).calls = calls;
  return fn as MockTransport;
}

describe('v0.6 TelegramPoller', () => {
  let store: EventStore;
  let notifier: Notifier;
  let router: ReplyRouter;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    notifier.registerChannel(new CapChannel());
    router = new ReplyRouter(broker);
  });

  afterEach(async () => {
    await tick();
    store.close();
  });

  it('isConfigured reflects bot token presence', () => {
    const a = new TelegramPoller({ botToken: undefined, notifier, router, secret: 's', db: store.rawDb });
    expect(a.isConfigured()).toBe(false);
    const b = new TelegramPoller({ botToken: 'x', notifier, router, secret: 's', db: store.rawDb });
    expect(b.isConfigured()).toBe(true);
  });

  it('pollOnce handles a callback_query and routes to decision', async () => {
    store.createDecision('dec-x', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    const notifyResult = await notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-x' }],
    });
    await tick();

    const cidPrefix = notifyResult.correlationId.slice(0, 50);
    const callbackData = `${cidPrefix}:decision:yes`.slice(0, 64);
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: 'cb1',
                from: { id: 99 },
                message: { chat: { id: 99 } },
                data: callbackData,
              },
            },
          ],
        }),
      },
      { status: 200, body: '{"ok":true}' }, // answerCallbackQuery
    ]);
    const poller = new TelegramPoller({
      botToken: 'bot:x',
      notifier,
      router,
      secret: 'test-secret',
      db: store.rawDb,
      transport,
    });
    const handled = await poller.pollOnce();
    expect(handled).toBe(1);
    expect(store.getDecision('dec-x')?.chosen_option_id).toBe('yes');
    expect(transport.calls.some((c) => c.path.includes('answerCallbackQuery'))).toBe(true);
  });

  it('ignores callbacks with bad cid prefix', async () => {
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: 'cb1',
                from: { id: 1 },
                message: { chat: { id: 1 } },
                data: 'unknown-prefix:decision:yes',
              },
            },
          ],
        }),
      },
      { status: 200, body: '{"ok":true}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 'test-secret',
      db: store.rawDb,
      transport,
    });
    const handled = await poller.pollOnce();
    expect(handled).toBe(0);
  });

  it('does not double-consume on repeat callback', async () => {
    store.createDecision('dec-r', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    const notifyResult = await notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-r' }],
    });
    await tick();
    const cidPrefix = notifyResult.correlationId.slice(0, 50);
    const cb = {
      update_id: 5,
      callback_query: {
        id: 'cb5',
        from: { id: 1 },
        message: { chat: { id: 1 } },
        data: `${cidPrefix}:decision:yes`.slice(0, 64),
      },
    };
    const transport = mockTransport([
      { status: 200, body: JSON.stringify({ ok: true, result: [cb] }) },
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: JSON.stringify({ ok: true, result: [cb] }) },
      { status: 200, body: '{"ok":true}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 'test-secret',
      db: store.rawDb,
      transport,
    });
    expect(await poller.pollOnce()).toBe(1);
    expect(await poller.pollOnce()).toBe(0);
  });

  it('start/stop sets and clears the timer', () => {
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport: mockTransport([{ status: 200, body: '{"ok":true,"result":[]}' }]),
      intervalMs: 100000,
    });
    poller.start();
    poller.stop();
  });
});

// v0.6.X — operator directive routing on `message` updates.
describe('v0.6.X TelegramPoller — message events route to directives', () => {
  let store: EventStore;
  let notifier: Notifier;
  let router: ReplyRouter;
  let broker: Broker;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    notifier.registerChannel(new CapChannel());
    router = new ReplyRouter(broker);
    rateLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });
  });

  afterEach(async () => {
    await tick();
    store.close();
  });

  function makeMsgUpdate(text: string, chatId: number, updateId = 1) {
    return {
      update_id: updateId,
      message: {
        message_id: 100 + updateId,
        date: 1_715_000_000,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, username: 'op' },
        text,
      },
    };
  }

  it('subscribes to message updates only when directives are enabled', async () => {
    // Without broker + chat-id + rate limiter, pollOnce should request
    // callback_query only (back-compat).
    const transport = mockTransport([
      { status: 200, body: '{"ok":true,"result":[]}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
    });
    await poller.pollOnce();
    expect(transport.calls.length).toBe(1);
    expect(transport.calls[0].path).toContain('allowed_updates=');
    expect(transport.calls[0].path).toContain(encodeURIComponent('["callback_query"]'));
    expect(transport.calls[0].path).not.toContain(encodeURIComponent('message'));
  });

  it('subscribes to both update types when directives are enabled', async () => {
    const transport = mockTransport([
      { status: 200, body: '{"ok":true,"result":[]}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
    });
    await poller.pollOnce();
    expect(transport.calls[0].path).toContain(
      encodeURIComponent('["callback_query","message"]'),
    );
  });

  it('routes /steward to operator_directive and replies via sendMessage', async () => {
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [makeMsgUpdate('/steward investigate the May-15 zombies', 8739810100)],
        }),
      },
      { status: 200, body: '{"ok":true}' }, // sendMessage response
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
    });
    const handled = await poller.pollOnce();
    expect(handled).toBe(1);
    const evs = store.getEvents({ kinds: ['operator_directive'], limit: 10 }).events;
    expect(evs.length).toBe(1);
    expect((evs[0].payload as { text: string }).text).toContain('May-15 zombies');
    // sendMessage was called with the dispatcher's confirmation reply.
    const sendCalls = transport.calls.filter((c) => c.path.includes('sendMessage'));
    expect(sendCalls.length).toBe(1);
    const body = JSON.parse(sendCalls[0].body) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(8739810100);
    expect(body.text).toMatch(/Directive received/);
  });

  it('silently drops non-operator chat (no sendMessage, audit event emitted)', async () => {
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [makeMsgUpdate('/steward malicious payload', 99999)],
        }),
      },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
    });
    await poller.pollOnce();
    // No sendMessage call (bot existence stays unconfirmable).
    expect(transport.calls.some((c) => c.path.includes('sendMessage'))).toBe(false);
    // Audit event landed.
    const rej = store.getEvents({ kinds: ['telegram_directive_rejected'], limit: 10 }).events;
    expect(rej.length).toBe(1);
    expect((rej[0].payload as { chat_id: string }).chat_id).toBe('99999');
  });

  it('/status uses the operator-supplied status provider', async () => {
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [makeMsgUpdate('/status', 8739810100)],
        }),
      },
      { status: 200, body: '{"ok":true}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
      statusProvider: () => 'stavR · Healthy · 7 active workers',
    });
    const handled = await poller.pollOnce();
    expect(handled).toBe(1);
    // No event emitted for /status (read-only per BOM).
    expect(store.getEvents({ limit: 50 }).events.filter(e => e.kind !== 'sse_session_opened' && e.kind !== 'sse_session_closed').length).toBe(0);
    const sendCalls = transport.calls.filter((c) => c.path.includes('sendMessage'));
    expect(sendCalls.length).toBe(1);
    const body = JSON.parse(sendCalls[0].body) as { text: string };
    expect(body.text).toContain('Healthy');
    expect(body.text).toContain('7 active workers');
  });

  it('unknown command replies with help text', async () => {
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [makeMsgUpdate('hello bot', 8739810100)],
        }),
      },
      { status: 200, body: '{"ok":true}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 's',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
    });
    await poller.pollOnce();
    const sendCalls = transport.calls.filter((c) => c.path.includes('sendMessage'));
    expect(sendCalls.length).toBe(1);
    const body = JSON.parse(sendCalls[0].body) as { text: string };
    expect(body.text).toContain('/steward');
    expect(body.text).toContain('/scope');
  });

  it('handles a callback_query and a message in the same batch', async () => {
    store.createDecision('dec-mix', 'mix?', [{ id: 'yes', label: 'Approve' }], 60);
    const notifyResult = await notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-mix' }],
    });
    await tick();
    const cidPrefix = notifyResult.correlationId.slice(0, 50);
    const callbackData = `${cidPrefix}:decision:yes`.slice(0, 64);
    const transport = mockTransport([
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              callback_query: {
                id: 'cb-mix',
                from: { id: 1 },
                message: { chat: { id: 1 } },
                data: callbackData,
              },
            },
            makeMsgUpdate('/ask what is up?', 8739810100, 2),
          ],
        }),
      },
      // answerCallbackQuery + sendMessage responses
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    const poller = new TelegramPoller({
      botToken: 'b',
      notifier,
      router,
      secret: 'test-secret',
      db: store.rawDb,
      transport,
      broker,
      authorisedChatId: '8739810100',
      directiveRateLimiter: rateLimiter,
    });
    const handled = await poller.pollOnce();
    expect(handled).toBe(2);
    expect(store.getDecision('dec-mix')?.chosen_option_id).toBe('yes');
    expect(store.getEvents({ kinds: ['operator_ask'], limit: 10 }).events.length).toBe(1);
  });
});
