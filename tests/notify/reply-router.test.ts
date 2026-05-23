import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { ReplyRouter } from '../../src/notify/reply-router.js';
import { TrustStore } from '../../src/trust/store.js';
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
    // Phase 4.6 — operator-shape backstop aligned with mayRespond.
    store.respondToDecision('dec-2', 'yes', 'fast click', 'unstamped-loopback');

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

  // v0.6.X bonus — grant_scope / reject_scope actions.

  describe('grant_scope / reject_scope routing', () => {
    let trustStore: TrustStore;
    let routerWithTrust: ReplyRouter;

    beforeEach(() => {
      trustStore = new TrustStore(store);
      routerWithTrust = new ReplyRouter(broker, trustStore);
    });

    function makeProposedScope() {
      return trustStore.createProposal({
        title: 'apps/web review-only',
        description: 'one-hour read access',
        allowed_actions: [{ tool: 'fs.read' }],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        reporting: { cadence: 'on-completion-only', channels: ['dashboard'] },
      });
    }

    it('grant_scope flips status to active and emits trust_scope_granted', async () => {
      const scope = makeProposedScope();
      const events: string[] = [];
      broker.onEvent((ev) => events.push(ev.kind));

      const result = await routerWithTrust.route({
        notificationId: 'n-grant',
        notificationCorrelationId: 'cid-grant',
        source: 'telegram',
        sourceLabel: '8739810100',
        actionId: 'scope:grant',
        actions: [{
          label: 'Grant',
          action_id: 'scope:grant',
          kind: 'grant_scope',
          target_id: scope.id,
        }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.kind).toBe('scope_granted');
      const after = trustStore.get(scope.id);
      expect(after?.status).toBe('active');
      expect(after?.granted_by).toBe('notify:telegram');
      expect(events).toContain('trust_scope_granted');
    });

    it('reject_scope marks scope revoked and emits trust_scope_rejected', async () => {
      const scope = makeProposedScope();
      const events: string[] = [];
      broker.onEvent((ev) => events.push(ev.kind));

      const result = await routerWithTrust.route({
        notificationId: 'n-rej',
        notificationCorrelationId: 'cid-rej',
        source: 'telegram',
        sourceLabel: '8739810100',
        actionId: 'scope:reject',
        actions: [{
          label: 'Reject',
          action_id: 'scope:reject',
          kind: 'reject_scope',
          target_id: scope.id,
        }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.kind).toBe('scope_rejected');
      const after = trustStore.get(scope.id);
      expect(after?.status).toBe('revoked');
      expect(events).toContain('trust_scope_rejected');
    });

    it('grant_scope returns wrong_state when scope is already active', async () => {
      const scope = makeProposedScope();
      trustStore.grant(scope.id, 'dashboard');
      const result = await routerWithTrust.route({
        notificationId: 'n-x',
        notificationCorrelationId: 'cid-x',
        source: 'telegram',
        sourceLabel: '8739810100',
        actionId: 'scope:grant',
        actions: [{
          label: 'Grant',
          action_id: 'scope:grant',
          kind: 'grant_scope',
          target_id: scope.id,
        }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('wrong_state');
    });

    it('grant_scope without TrustStore returns downstream_failed', async () => {
      const routerWithoutTrust = new ReplyRouter(broker); // no trustStore
      const result = await routerWithoutTrust.route({
        notificationId: 'n-y',
        notificationCorrelationId: 'cid-y',
        source: 'telegram',
        sourceLabel: '0',
        actionId: 'scope:grant',
        actions: [{
          label: 'Grant',
          action_id: 'scope:grant',
          kind: 'grant_scope',
          target_id: 'any-id',
        }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('downstream_failed');
    });
  });
});
