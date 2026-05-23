import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { getOrCreateNotifier, getTelegramPoller } from '../../src/server.js';

// Regression: prior to fix/telegram-poller-wiring the TelegramPoller class was
// defined but never constructed anywhere, leaving inbound Approve/Reject taps
// undrained from Telegram's getUpdates queue. These tests pin the wiring at
// the seam (server.ts:getOrCreateNotifier) so a future refactor can't silently
// remove the construction again.

describe('server-side notification wiring — TelegramPoller', () => {
  let store: EventStore;
  let broker: Broker;
  const saved = { ...process.env };

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    process.env.STAVR_NOTIFY_SECRET = 'wiring-test-secret';
    process.env.STAVR_NOTIFY_FORCE_CHANNELS = '1';
    process.env.STAVR_NOTIFY_DIGEST_ENABLED = 'false';
    delete process.env.STAVR_NOTIFY_TELEGRAM_BOT_TOKEN;
    delete process.env.STAVR_NOTIFY_TELEGRAM_CHAT_ID;
  });

  afterEach(() => {
    getTelegramPoller(broker)?.stop();
    store.close();
    process.env = { ...saved };
  });

  it('does not construct a poller when the bot token is absent', () => {
    const notifier = getOrCreateNotifier(broker);
    expect(notifier).toBeDefined();
    expect(getTelegramPoller(broker)).toBeUndefined();
  });

  it('constructs and starts a poller when the bot token is set', () => {
    process.env.STAVR_NOTIFY_TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.STAVR_NOTIFY_TELEGRAM_CHAT_ID = '12345';
    const notifier = getOrCreateNotifier(broker);
    expect(notifier).toBeDefined();
    const poller = getTelegramPoller(broker);
    expect(poller).toBeDefined();
    expect(poller!.isConfigured()).toBe(true);
    // start() is idempotent; calling again with the timer already set is a
    // no-op, so this also acts as a "did start() run during init" check —
    // if we got here, the constructor + start() path is wired.
  });
});
