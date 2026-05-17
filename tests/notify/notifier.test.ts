import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Notifier } from '../../src/notify/notifier.js';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../../src/notify/types.js';

class FakeChannel implements NotificationChannel {
  readonly id: string;
  configured = true;
  shouldFail = false;
  shouldThrow = false;
  sent: ChannelSendInput[] = [];

  constructor(id: string) {
    this.id = id;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async send(input: ChannelSendInput): Promise<NotificationDispatch> {
    this.sent.push(input);
    if (this.shouldThrow) throw new Error('fake explosion');
    if (this.shouldFail) {
      return { channelId: this.id, ok: false, error: 'fake error' };
    }
    return { channelId: this.id, ok: true };
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('v0.6 Notifier', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
  });

  afterEach(async () => {
    await tick();
    store.close();
  });

  it('persists a notification row + dispatches to configured channels', async () => {
    const notifier = new Notifier({
      secret: 'test-secret',
      replyBaseUrl: 'http://localhost:3030',
      db: store.rawDb,
    });
    const ntfy = new FakeChannel('ntfy');
    notifier.registerChannel(ntfy);

    const result = await notifier.notify({
      kind: 'health_alert',
      severity: 'warn',
      title: 'test',
      body: 'something happened',
    });

    expect(result.id).toBeTruthy();
    expect(result.correlationId).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await tick();
    expect(ntfy.sent.length).toBe(1);
    expect(ntfy.sent[0].title).toBe('test');

    const row = store.rawDb
      .prepare(`SELECT * FROM notifications WHERE id = ?`)
      .get(result.id) as { kind: string; delivered_channels: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row!.kind).toBe('health_alert');
    expect(row!.delivered_channels).toBe('ntfy');
  });

  it('records failed_channels on send error without throwing', async () => {
    const notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    const ntfy = new FakeChannel('ntfy');
    ntfy.shouldFail = true;
    notifier.registerChannel(ntfy);

    await notifier.notify({ kind: 'health_alert', severity: 'warn', title: 't', body: 'b' });
    await tick();

    const row = store.rawDb
      .prepare(`SELECT failed_channels FROM notifications`)
      .get() as { failed_channels: string | null };
    expect(row.failed_channels).toBe('ntfy');

    const channel = store.rawDb
      .prepare(`SELECT last_error FROM notification_channels WHERE id = 'ntfy'`)
      .get() as { last_error: string | null };
    expect(channel.last_error).toBe('fake error');
  });

  it('swallows channel exceptions (fire-and-forget)', async () => {
    const notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    const ntfy = new FakeChannel('ntfy');
    ntfy.shouldThrow = true;
    notifier.registerChannel(ntfy);
    await expect(
      notifier.notify({ kind: 'health_alert', severity: 'warn', title: 't', body: 'b' }),
    ).resolves.toBeTruthy();
  });

  it('skips channels that report not-configured', async () => {
    const notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    b.configured = false;
    notifier.registerChannel(a);
    notifier.registerChannel(b);

    await notifier.notify({ kind: 'health_alert', severity: 'info', title: 't', body: 'b' });
    await tick();
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(0);
  });

  it('awaits dispatch synchronously for crit notifications', async () => {
    const notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    const ch = new FakeChannel('ntfy');
    notifier.registerChannel(ch);
    const result = await notifier.notify({
      kind: 'health_alert',
      severity: 'crit',
      title: 't',
      body: 'b',
    });
    // Crit awaits: delivered should be true immediately, no tick needed.
    expect(result.delivered).toBe(true);
    expect(result.dispatchedChannels).toEqual(['ntfy']);
  });

  it('builds reply URLs for non-link actions', async () => {
    const notifier = new Notifier({
      secret: 'test-secret',
      replyBaseUrl: 'http://localhost:3030',
      db: store.rawDb,
    });
    const ch = new FakeChannel('ntfy');
    notifier.registerChannel(ch);

    await notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 'approve?',
      body: 'sure?',
      actions: [
        { label: 'Approve', action_id: 'approve', kind: 'approve' },
        { label: 'Deny', action_id: 'deny', kind: 'deny' },
        { label: 'Dashboard', action_id: 'open', kind: 'link', url: 'http://localhost:3030/decide' },
      ],
    });
    await tick();
    const urls = ch.sent[0].replyUrls;
    expect(urls.approve).toContain('cid=');
    expect(urls.approve).toContain('action=approve');
    expect(urls.deny).toContain('action=deny');
    expect(urls.open).toBeUndefined(); // link actions don't get reply URLs
  });

  it('markConsumed enforces one-shot semantics', async () => {
    const notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    const ch = new FakeChannel('ntfy');
    notifier.registerChannel(ch);
    const result = await notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
    });
    const first = notifier.markConsumed(result.correlationId, 'test:1');
    const second = notifier.markConsumed(result.correlationId, 'test:2');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('reports channel status', async () => {
    const notifier = new Notifier({ secret: 's', db: store.rawDb });
    const a = new FakeChannel('a');
    const b = new FakeChannel('b');
    b.configured = false;
    notifier.registerChannel(a);
    notifier.registerChannel(b);
    const statuses = notifier.getChannelStatus();
    expect(statuses.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(statuses.find((s) => s.id === 'a')!.configured).toBe(true);
    expect(statuses.find((s) => s.id === 'b')!.configured).toBe(false);
  });
});
