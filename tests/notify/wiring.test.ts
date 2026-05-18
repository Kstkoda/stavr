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

  // v0.6.X bonus — extended outbound coverage.

  it('trust_scope_proposed emits a notification with Grant + Reject actions', async () => {
    wireNotifications(broker, notifier, { dashboardBaseUrl: 'http://127.0.0.1:7777' });
    await broker.publish({
      kind: 'trust_scope_proposed',
      at: new Date().toISOString(),
      source_agent: 'cowork-claude',
      payload: {
        scope_id: 'scp-1',
        title: 'apps/web review-only',
        description: 'one-hour read access',
        allowed_actions: [{ tool: 'fs.read' }],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        reporting: { cadence: 'on-completion-only', channels: ['dashboard'] },
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    const sent = channel.sent[0];
    expect(sent.kind).toBe('scope_proposed');
    expect(sent.severity).toBe('warn');
    expect(sent.title).toContain('proposed');
    expect(sent.body).toContain('one-hour read access');
    expect(sent.actions.length).toBeGreaterThanOrEqual(2);
    const grantAction = sent.actions.find((a) => a.action_id === 'scope:grant');
    expect(grantAction?.kind).toBe('grant_scope');
    expect(grantAction?.target_id).toBe('scp-1');
    const rejectAction = sent.actions.find((a) => a.action_id === 'scope:reject');
    expect(rejectAction?.kind).toBe('reject_scope');
  });

  it('host_exec_denied emits a notification with View audit link (no remediation)', async () => {
    wireNotifications(broker, notifier, { dashboardBaseUrl: 'http://127.0.0.1:7777' });
    await broker.publish({
      kind: 'host_exec_denied',
      at: new Date().toISOString(),
      source_agent: 'cowork-claude',
      payload: {
        command: 'rm -rf /',
        reason: 'allowlist deny',
        actor: 'cowork-claude',
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    const sent = channel.sent[0];
    expect(sent.kind).toBe('host_exec_denied');
    expect(sent.severity).toBe('warn');
    expect(sent.body).toContain('[cowork-claude]');
    expect(sent.body).toContain('rm -rf');
    expect(sent.body).toContain('allowlist deny');
    // Only the View-audit link — no remediation buttons (BOM rule).
    const remediation = sent.actions.find((a) => a.kind === 'approve' || a.kind === 'deny');
    expect(remediation).toBeUndefined();
    const auditLink = sent.actions.find((a) => a.action_id === 'open:audit');
    expect(auditLink?.kind).toBe('link');
  });

  it('worker_dispatch_failed emits a crit notification with View logs link', async () => {
    wireNotifications(broker, notifier, { dashboardBaseUrl: 'http://127.0.0.1:7777' });
    await broker.publish({
      kind: 'worker_dispatch_failed',
      at: new Date().toISOString(),
      source_agent: 'worker-spawner',
      payload: {
        target_worker_id: 'w42',
        name: 'tsc-watch',
        reason: 'av_block',
        detail: 'Windows Defender quarantined the binary',
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    const sent = channel.sent[0];
    expect(sent.kind).toBe('worker_dispatch_failed');
    expect(sent.severity).toBe('crit');
    expect(sent.body).toContain('w42');
    expect(sent.body).toContain('av_block');
    const logs = sent.actions.find((a) => a.action_id === 'open:logs');
    expect(logs?.kind).toBe('link');
    expect(logs?.url).toContain('/dashboard/workers/w42');
  });

  it('worker_blocked_by_av emits a warn notification with whitelist hint', async () => {
    wireNotifications(broker, notifier, { dashboardBaseUrl: 'http://127.0.0.1:7777' });
    await broker.publish({
      kind: 'worker_blocked_by_av',
      at: new Date().toISOString(),
      source_agent: 'worker-spawner',
      payload: {
        worker_id: 'w-blocked',
        name: 'cc-runner',
        av_product_name: 'Windows Defender',
        av_event_id: 1116,
        av_event_message: 'HackTool:PowerShell/Adgholas.A',
        script_path: 'C:\\Users\\op\\.stavr\\worker-scripts\\w-blocked.ps1',
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    const sent = channel.sent[0];
    expect(sent.severity).toBe('warn');
    expect(sent.title).toContain('blocked by AV');
    expect(sent.body).toContain('cc-runner');
    expect(sent.body).toContain('Windows Defender');
    expect(sent.body).toContain('HackTool');
    expect(sent.body).toContain('w-blocked.ps1');
    expect(sent.body).toContain('whitelist');
    const link = sent.actions.find((a) => a.action_id === 'open:worker');
    expect(link?.kind).toBe('link');
    expect(link?.url).toContain('/dashboard/workers/w-blocked');
  });

  it('cc_quota_warning emits warn at 90% and crit at 95%+', async () => {
    wireNotifications(broker, notifier, { dashboardBaseUrl: 'http://127.0.0.1:7777' });
    await broker.publish({
      kind: 'cc_quota_warning',
      at: new Date().toISOString(),
      source_agent: 'cc-observer',
      payload: {
        percent: 92,
        remaining: 120,
        detail: 'Approaching quota',
      },
    });
    await tick();
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0].severity).toBe('warn');
    expect(channel.sent[0].body).toContain('120 calls left');

    await broker.publish({
      kind: 'cc_quota_warning',
      at: new Date().toISOString(),
      source_agent: 'cc-observer',
      payload: {
        percent: 98,
        detail: 'Critical',
      },
    });
    await tick();
    expect(channel.sent.length).toBe(2);
    expect(channel.sent[1].severity).toBe('crit');
    expect(channel.sent[1].title).toContain('98%');
  });
});
