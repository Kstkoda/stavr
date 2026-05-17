import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { Notifier } from '../../src/notify/notifier.js';
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
