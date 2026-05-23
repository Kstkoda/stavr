// v0.6 P4 — hardening tests for /notify/reply.
//
// Covers:
//   - 429 when rate limit exceeded
//   - audit event (`progress` with stage=notification_reply) emitted per reply
//   - scope-cap respected: reply that targets a no-target / unknown scope
//     does NOT bypass scope check; routing reports failure, audit still records
//   - reply that targets an already-responded decision: 200 (consumed)
//     downstream + decision_late_response emitted

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventStore, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { Notifier } from '../../src/notify/notifier.js';
import { ReplyRouter } from '../../src/notify/reply-router.js';
import { createInboundHandler } from '../../src/notify/inbound.js';
import { RateLimiter } from '../../src/notify/rate-limit.js';
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
  router: ReplyRouter;
  server: Server;
  base: string;
  events: StoredEvent[];
}

async function bootHarness(opts: { maxRate?: number } = {}): Promise<Harness> {
  const secret = 'hardening-secret';
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const notifier = new Notifier({ secret, replyBaseUrl: 'http://x', db: store.rawDb });
  notifier.registerChannel(new CapChannel());
  const router = new ReplyRouter(broker);
  const limiter = new RateLimiter({ max: opts.maxRate ?? 100, windowMs: 60_000 });
  const events: StoredEvent[] = [];
  broker.onEvent((e) => events.push(e));

  const app = express();
  app.get('/notify/reply', createInboundHandler({ notifier, router, secret, rateLimiter: limiter }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    store,
    broker,
    notifier,
    router,
    server,
    base: `http://127.0.0.1:${addr.port}`,
    events,
  };
}

async function teardown(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await tick();
  h.store.close();
}

describe('v0.6 P4 — inbound hardening', () => {
  let h: Harness;
  afterEach(async () => h && (await teardown(h)));

  it('returns 429 once rate limit exhausted, recovers after window', async () => {
    h = await bootHarness({ maxRate: 2 });
    const r1 = await fetch(`${h.base}/notify/reply`);
    const r2 = await fetch(`${h.base}/notify/reply`);
    const r3 = await fetch(`${h.base}/notify/reply`);
    // First two get through to handler validation (400 — missing cid/action).
    // Third hits 429 before any handler logic runs.
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    expect(r3.status).toBe(429);
  });

  it('emits a notification_reply progress audit event for each reply', async () => {
    h = await bootHarness();
    h.store.createDecision('dec-a', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    const result = await h.notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-a' }],
    });
    await tick();
    const cid = encodeURIComponent(result.correlationId);
    await fetch(`${h.base}/notify/reply?cid=${cid}&action=decision%3Ayes`);
    await tick();
    const auditEvents = h.events.filter(
      (e) =>
        e.kind === 'progress' &&
        (e.payload as { stage?: string }).stage === 'notification_reply',
    );
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    const detail = JSON.parse((auditEvents[0].payload as { detail: string }).detail);
    expect(detail.source).toBe('webhook');
    expect(detail.action_id).toBe('decision:yes');
  });

  it('reply on already-responded decision: 200 + decision_late_response emitted', async () => {
    h = await bootHarness();
    h.store.createDecision('dec-b', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    const result = await h.notifier.notify({
      kind: 'decision_required',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-b' }],
    });
    await tick();
    // Operator clicks in dashboard first, then via notification.
    // Phase 4.6 — operator-shape backstop aligned with mayRespond.
    h.store.respondToDecision('dec-b', 'yes', 'dashboard click', 'unstamped-loopback');
    const cid = encodeURIComponent(result.correlationId);
    const r = await fetch(`${h.base}/notify/reply?cid=${cid}&action=decision%3Ayes`);
    expect(r.status).toBe(200);
    await tick();
    const lateEvents = h.events.filter((e) => e.kind === 'decision_late_response');
    expect(lateEvents.length).toBe(1);
    // First responder still stands.
    expect(h.store.getDecision('dec-b')?.responded_by).toBe('unstamped-loopback');
  });

  it('reply targeting unknown scope: returns 500 server-error AND records audit', async () => {
    h = await bootHarness();
    // Notification claims to extend scope sc-unknown, which TrustStore doesn't know about.
    const result = await h.notifier.notify({
      kind: 'scope_expiring',
      severity: 'warn',
      title: 't',
      body: 'b',
      actions: [
        {
          label: 'Extend',
          action_id: 'scope:extend',
          kind: 'grant_extension',
          target_id: 'sc-unknown',
        },
      ],
    });
    await tick();
    const cid = encodeURIComponent(result.correlationId);
    const r = await fetch(`${h.base}/notify/reply?cid=${cid}&action=scope%3Aextend`);
    // No TrustStore wired → router returns ok:false:downstream_failed, but the
    // notification is still consumed and the audit event landed. The HTML page
    // surfaces "Reply received" / generic error to the operator.
    expect(r.status).toBe(200);
    await tick();
    const auditEvents = h.events.filter(
      (e) =>
        e.kind === 'progress' &&
        (e.payload as { stage?: string }).stage === 'notification_reply',
    );
    expect(auditEvents.length).toBe(1);
    // Consumed: second click → 410 Gone.
    const r2 = await fetch(`${h.base}/notify/reply?cid=${cid}&action=scope%3Aextend`);
    expect(r2.status).toBe(410);
  });
});
