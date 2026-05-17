import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { ReplyRouter } from '../../src/notify/reply-router.js';
import type { NotificationAction } from '../../src/notify/types.js';

describe('v0.6 ReplyRouter', () => {
  let store: EventStore;
  let broker: Broker;
  let router: ReplyRouter;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    router = new ReplyRouter(broker);
  });

  afterEach(() => {
    store.close();
  });

  it('routes decision:approve to respondToDecision', async () => {
    store.createDecision('dec-1', 'Approve?', [
      { id: 'yes', label: 'Approve' },
      { id: 'no', label: 'Deny' },
    ], 60);

    const actions: NotificationAction[] = [
      { label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-1' },
      { label: 'Deny', action_id: 'decision:no', kind: 'deny', target_id: 'dec-1' },
    ];

    const result = await router.route({
      notificationId: 'n1',
      notificationCorrelationId: 'cid1',
      source: 'webhook',
      sourceLabel: '127.0.0.1',
      actionId: 'decision:yes',
      actions,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'decision') {
      expect(result.outcome).toBe('responded');
      expect(result.chosenOptionId).toBe('yes');
    }

    const decision = store.getDecision('dec-1');
    expect(decision?.status).toBe('responded');
    expect(decision?.chosen_option_id).toBe('yes');
    expect(decision?.responded_by).toBe('notify:webhook');
  });

  it('records late response when decision already responded', async () => {
    store.createDecision('dec-2', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    store.respondToDecision('dec-2', 'yes', 'fast click', 'operator');

    const actions: NotificationAction[] = [
      { label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-2' },
    ];

    const result = await router.route({
      notificationId: 'n1',
      notificationCorrelationId: 'cid2',
      source: 'webhook',
      sourceLabel: '1.2.3.4',
      actionId: 'decision:yes',
      actions,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'decision') {
      expect(result.outcome).toBe('late');
    }
  });

  it('returns action_not_in_notification when action_id is unknown', async () => {
    const result = await router.route({
      notificationId: 'n1',
      notificationCorrelationId: 'cid3',
      source: 'webhook',
      sourceLabel: 'x',
      actionId: 'decision:bogus',
      actions: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('action_not_in_notification');
  });

  it('returns ok for ignore kind without dispatching', async () => {
    const actions: NotificationAction[] = [
      { label: 'Dismiss', action_id: 'dismiss', kind: 'ignore' },
    ];
    const result = await router.route({
      notificationId: 'n',
      notificationCorrelationId: 'c',
      source: 'webhook',
      sourceLabel: 'x',
      actionId: 'dismiss',
      actions,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe('ignore');
  });

  it('returns ok for link kind without dispatching', async () => {
    const actions: NotificationAction[] = [
      { label: 'Open', action_id: 'open', kind: 'link', url: 'http://x' },
    ];
    const result = await router.route({
      notificationId: 'n',
      notificationCorrelationId: 'c',
      source: 'webhook',
      sourceLabel: 'x',
      actionId: 'open',
      actions,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe('link');
  });

  it('publishes audit progress event for every reply', async () => {
    const events: string[] = [];
    broker.onEvent((ev) => events.push(ev.kind));

    store.createDecision('dec-3', 'q', [{ id: 'yes', label: 'Approve' }], 60);
    await router.route({
      notificationId: 'n',
      notificationCorrelationId: 'cidlong',
      source: 'telegram',
      sourceLabel: '12345',
      actionId: 'decision:yes',
      actions: [{ label: 'Approve', action_id: 'decision:yes', kind: 'approve', target_id: 'dec-3' }],
    });
    expect(events).toContain('progress');
    expect(events).toContain('decision_response');
  });
});
