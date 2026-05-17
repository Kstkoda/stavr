import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Notifier } from '../../src/notify/notifier.js';
import { DigestScheduler } from '../../src/notify/digest.js';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../../src/notify/types.js';

class CapChannel implements NotificationChannel {
  readonly id = 'cap';
  sent: ChannelSendInput[] = [];
  isConfigured(): boolean {
    return true;
  }
  async send(input: ChannelSendInput): Promise<NotificationDispatch> {
    this.sent.push(input);
    return { channelId: this.id, ok: true };
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('v0.6 daily digest', () => {
  let store: EventStore;
  let notifier: Notifier;
  let channel: CapChannel;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    notifier = new Notifier({ secret: 's', db: store.rawDb });
    channel = new CapChannel();
    notifier.registerChannel(channel);
  });

  afterEach(async () => {
    await tick();
    store.close();
  });

  it('tick() fires once when clock crosses configured hour', async () => {
    const sched = new DigestScheduler(notifier, {
      hour: 9,
      minute: 0,
      now: () => new Date(2026, 4, 17, 9, 0, 0),
      db: store.rawDb,
    });
    const fired = await sched.tick();
    await tick();
    expect(fired).toBe(true);
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].kind).toBe('digest');
    expect(channel.sent[0].title).toMatch(/2026-05-1[67]/);
  });

  it('tick() does not fire when hour does not match', async () => {
    const sched = new DigestScheduler(notifier, {
      hour: 9,
      now: () => new Date(2026, 4, 17, 11, 0, 0),
      db: store.rawDb,
    });
    const fired = await sched.tick();
    expect(fired).toBe(false);
    expect(channel.sent.length).toBe(0);
  });

  it('tick() suppresses duplicate fires within 23h', async () => {
    let clock = new Date(2026, 4, 17, 9, 0, 0);
    const sched = new DigestScheduler(notifier, {
      hour: 9,
      now: () => clock,
      db: store.rawDb,
    });
    await sched.tick();
    await tick();
    clock = new Date(2026, 4, 17, 9, 1, 0);
    const second = await sched.tick();
    expect(second).toBe(false);
    expect(channel.sent.length).toBe(1);
  });

  it('disable() prevents future fires', async () => {
    const sched = new DigestScheduler(notifier, {
      hour: 9,
      now: () => new Date(2026, 4, 17, 9, 0, 0),
      db: store.rawDb,
    });
    sched.disable();
    const fired = await sched.tick();
    expect(fired).toBe(false);
  });

  it('buildDigest counts decisions + scopes + workers + errors', async () => {
    // Seed some data
    store.rawDb
      .prepare(
        `INSERT INTO decisions (correlation_id, question, options_json, timeout_sec, status, requested_at, expires_at, responded_at)
         VALUES ('d1','q','[]',60,'responded',?,?,?)`,
      )
      .run(new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), new Date().toISOString());
    store.rawDb
      .prepare(
        `INSERT INTO trust_scopes (id, title, description, granted_by, granted_at, expires_at, allowed_actions_json, reporting_json, status)
         VALUES ('s1','t','d','op',?,?, '[]','{}','active')`,
      )
      .run(new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
    store.rawDb
      .prepare(
        `INSERT INTO workers (id, name, type, cwd, status, started_at, metadata_json, spawn_params_hash)
         VALUES ('w1','n','cc','/','running',?,'{}','h')`,
      )
      .run(new Date().toISOString());

    const sched = new DigestScheduler(notifier, { db: store.rawDb });
    const stats = sched.buildDigest();
    expect(stats.decisions).toBe(1);
    expect(stats.decisionsResponded).toBe(1);
    expect(stats.scopesGranted).toBe(1);
    expect(stats.workersRun).toBe(1);
  });
});
