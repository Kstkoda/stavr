import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { Notifier } from '../../src/notify/notifier.js';
import { wireNotifications, notifyHealthState } from '../../src/notify/wiring.js';
import type {
  ChannelSendInput,
  NotificationChannel,
  NotificationDispatch,
} from '../../src/notify/types.js';

class CapturingChannel implements NotificationChannel {
  readonly id = 'capture';
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

describe('v0.6 notify wiring', () => {
  let store: EventStore;
  let broker: Broker;
  let notifier: Notifier;
  let channel: CapturingChannel;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    notifier = new Notifier({ secret: 'test-secret', db: store.rawDb });
    channel = new CapturingChannel();
    notifier.registerChannel(channel);
  });

  afterEach(async () => {
    await tick();
    store.close();
  });

  it('turns decision_request into decision_required notification with mapped actions', async () => {
    wireNotifications(broker, notifier);
    await broker.publish({
      kind: 'decision_request',
      at: new Date().toISOString(),
      correlation_id: 'dec-1',
      source_agent: 'cc',
      payload: {
        question: 'Approve the PR?',
        options: [
          { id: 'yes', label: 'Approve' },
          { id: 'no', label: 'Deny' },
        ],
        deadline_seconds: 60,
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    const n = channel.sent[0];
    expect(n.kind).toBe('decision_required');
    expect(n.title).toBe('Decision required');
    expect(n.body).toBe('Approve the PR?');
    expect(n.actions.find((a) => a.label === 'Approve')!.kind).toBe('approve');
    expect(n.actions.find((a) => a.label === 'Deny')!.kind).toBe('deny');
  });

  it('emits scope_expired notification for trust_scope_revoked', async () => {
    wireNotifications(broker, notifier);
    await broker.publish({
      kind: 'trust_scope_revoked',
      at: new Date().toISOString(),
      source_agent: 'switch',
      payload: { scope_id: 'sc-99', revoked_by: 'operator', reason: 'manual' },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].kind).toBe('scope_expired');
    expect(channel.sent[0].severity).toBe('warn');
    expect(channel.sent[0].body).toContain('sc-99');
  });

  it('emits info-severity scope_expired for trust_scope_completed', async () => {
    wireNotifications(broker, notifier);
    await broker.publish({
      kind: 'trust_scope_completed',
      at: new Date().toISOString(),
      source_agent: 'switch',
      payload: { scope_id: 'sc-42' },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].severity).toBe('info');
  });

  it('emits work_complete for crashed workers but NOT for plain "completed"', async () => {
    wireNotifications(broker, notifier);
    await broker.publish({
      kind: 'worker_terminated',
      at: new Date().toISOString(),
      source_agent: 'orch',
      payload: { id: 'w-1', reason: 'completed' },
    });
    await broker.publish({
      kind: 'worker_terminated',
      at: new Date().toISOString(),
      source_agent: 'orch',
      payload: { id: 'w-2', reason: 'crashed', exit_code: 1 },
    });
    await tick();
    // Only the crashed worker triggers a live notification.
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].title).toContain('crashed');
    expect(channel.sent[0].severity).toBe('warn');
  });

  it('does not emit for unrelated event kinds', async () => {
    wireNotifications(broker, notifier);
    await broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'cc',
      payload: { stage: 'planning', detail: 'x' },
    });
    await tick();
    expect(channel.sent.length).toBe(0);
  });

  it('disposable: returned function unregisters the tap', async () => {
    const off = wireNotifications(broker, notifier);
    off();
    await broker.publish({
      kind: 'decision_request',
      at: new Date().toISOString(),
      correlation_id: 'dec-x',
      source_agent: 'cc',
      payload: { question: 'q', options: [{ id: 'y', label: 'Yes' }], deadline_seconds: 30 },
    });
    await tick();
    expect(channel.sent.length).toBe(0);
  });

  it('notifyHealthState sends warn but skips info transitions', async () => {
    await notifyHealthState(notifier, { severity: 'info', reason: 'recovered' });
    expect(channel.sent.length).toBe(0);
    await notifyHealthState(notifier, { severity: 'warn', reason: 'high memory', details: '92%' });
    await tick();
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].kind).toBe('health_alert');
    expect(channel.sent[0].body).toBe('92%');
  });
});
