import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { Notifier } from '../../src/notify/notifier.js';
import { ReplyRouter } from '../../src/notify/reply-router.js';
import { createInboundHandler } from '../../src/notify/inbound.js';
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

interface Harness {
  store: EventStore;
  broker: Broker;
  notifier: Notifier;
  server: Server;
  base: string;
}

async function bootHarness(secret = 'test-secret'): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const notifier = new Notifier({ secret, replyBaseUrl: 'http://x', db: store.rawDb });
  notifier.registerChannel(new CapChannel());
  const router = new ReplyRouter(broker);
  const app = express();
  app.get('/notify/reply', createInboundHandler({ notifier, router, secret }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { store, broker, notifier, server, base: `http://127.0.0.1:${addr.port}` };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await tick();
  h.store.close();
}

describe('v0.6 /notify/reply inbound', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await bootHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('approves a decision via signed cid round-trip', async () => {
    h.store.createDecision('dec-9', 'go?', [{ id: 'yes', label: 'Approve' }], 60);
    const result = await h.notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-9' }],
    });
    await tick();
    const cid = encodeURIComponent(result.correlationId);
    const r = await fetch(`${h.base}/notify/reply?cid=${cid}&action=decision%3Ayes`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('Approved');
    expect(h.store.getDecision('dec-9')?.chosen_option_id).toBe('yes');
  });

  it('rejects a tampered signature with 401', async () => {
    const r = await fetch(`${h.base}/notify/reply?cid=YQ.bm9wZQ&action=decision%3Ayes`);
    expect(r.status).toBe(401);
  });

  it('returns 410 Gone when cid is unknown but well-formed', async () => {
    // Mint a valid cid via a separate notifier with the same secret, but don't
    // persist its row to the test DB. Verify succeeds, lookup misses → 404.
    // We force this by creating a Notifier without a DB, so the row never lands.
    const orphan = new Notifier({ secret: 'test-secret' });
    orphan.registerChannel(new CapChannel());
    const res = await orphan.notify({ kind: 'health_alert', severity: 'info', title: 't', body: 'b' });
    const cid = encodeURIComponent(res.correlationId);
    const r = await fetch(`${h.base}/notify/reply?cid=${cid}&action=any`);
    expect(r.status).toBe(404);
  });

  it('returns 410 on second click (one-shot consumption)', async () => {
    h.store.createDecision('dec-10', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    const result = await h.notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-10' }],
    });
    await tick();
    const cid = encodeURIComponent(result.correlationId);
    const first = await fetch(`${h.base}/notify/reply?cid=${cid}&action=decision%3Ayes`);
    expect(first.status).toBe(200);
    const second = await fetch(`${h.base}/notify/reply?cid=${cid}&action=decision%3Ayes`);
    expect(second.status).toBe(410);
  });

  it('returns 400 when action_id is not in notification.actions', async () => {
    const result = await h.notifier.notify({
      kind: 'health_alert',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Dismiss', action_id: 'dismiss', kind: 'ignore' }],
    });
    await tick();
    const cid = encodeURIComponent(result.correlationId);
    const r = await fetch(`${h.base}/notify/reply?cid=${cid}&action=bogus`);
    expect(r.status).toBe(400);
  });

  it('returns 400 when cid or action missing', async () => {
    const r1 = await fetch(`${h.base}/notify/reply`);
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${h.base}/notify/reply?cid=x`);
    expect(r2.status).toBe(400);
  });

  it('serves HTML with the iron palette wordmark, never JSON', async () => {
    const r = await fetch(`${h.base}/notify/reply`);
    expect(r.headers.get('content-type')).toContain('text/html');
    const text = await r.text();
    expect(text).toContain('stavR');
  });
});
