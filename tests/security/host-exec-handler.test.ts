import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { createSwitchServer, getOrCreateTrustStore } from '../../src/server.js';
import type { TrustStore } from '../../src/trust/store.js';

// P4 acceptance — wired handler: scope gate + audit emission.
//
// Each test boots an in-memory broker + a fresh MCP session, optionally
// grants a host_exec scope, then asserts both the tool response shape AND
// the event-log entries that were emitted as side effects.

interface Harness {
  client: Client;
  broker: Broker;
  store: EventStore;
  trustStore: TrustStore;
  close: () => Promise<void>;
}

async function bootHarness(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const handle = createSwitchServer(broker);
  const trustStore = getOrCreateTrustStore(broker);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverT);
  const client = new Client({ name: 'host-exec-handler-test', version: '0.0.0' });
  await client.connect(clientT);
  return {
    client,
    broker,
    store,
    trustStore,
    close: async () => {
      await client.close();
      broker.removeSession(handle.sessionId);
      store.close();
    },
  };
}

async function callHostExec(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: 'host_exec', arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  return JSON.parse(text) as Record<string, unknown>;
}

function grantHostExecScope(
  trustStore: TrustStore,
  opts: { paramConstraints?: Record<string, unknown>; ttlMs?: number } = {},
): string {
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? 15 * 60 * 1000)).toISOString();
  const scope = trustStore.createProposal({
    title: 'host-ops',
    description: 'Routine git/npm/pm2 ops on this host',
    allowed_actions: [
      {
        tool: 'host_exec',
        param_constraints: opts.paramConstraints,
      },
    ],
    expires_at: expiresAt,
  });
  const granted = trustStore.grant(scope.id, 'test-operator');
  if (!granted || granted.status !== 'active') {
    throw new Error('failed to grant scope in test');
  }
  return scope.id;
}

function eventsByKind(store: EventStore, kind: string) {
  return store.getEvents({ kinds: [kind] }).events;
}

describe('host_exec handler — scope gate + audit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('SCOPE_DENIED when no active scope covers host_exec', async () => {
    const res = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe('SCOPE_DENIED');
    const denials = eventsByKind(h.store, 'host_exec_denied');
    expect(denials).toHaveLength(1);
    expect((denials[0].payload as Record<string, unknown>).error_code).toBe('SCOPE_DENIED');
    // No started/completed should fire when we never got past the gate.
    expect(eventsByKind(h.store, 'host_exec_started')).toHaveLength(0);
    expect(eventsByKind(h.store, 'host_exec_completed')).toHaveLength(0);
  });

  it('SCOPE_DENIED when scope is granted then revoked', async () => {
    const scopeId = grantHostExecScope(h.trustStore);
    h.trustStore.revoke(scopeId);
    const res = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(res.error_code).toBe('SCOPE_DENIED');
  });

  it('SCOPE_DENIED when scope is granted but expired', async () => {
    // Grant a scope that expired 1 second ago by directly inserting the row
    // through the API: propose with a past expires_at, then grant (which
    // re-bumps to default TTL). To force expiry we instead grant fresh,
    // then mark expired via the public store method.
    const scopeId = grantHostExecScope(h.trustStore);
    h.trustStore.markExpired(scopeId);
    const res = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(res.error_code).toBe('SCOPE_DENIED');
  });

  it('SCOPE-allowed but ALLOWLIST_DENIED for rm', async () => {
    grantHostExecScope(h.trustStore);
    const res = await callHostExec(h.client, { command: 'rm', args: ['-rf', '/'] });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe('ALLOWLIST_DENIED');
    const denials = eventsByKind(h.store, 'host_exec_denied');
    expect(denials).toHaveLength(1);
    const payload = denials[0].payload as Record<string, unknown>;
    expect(payload.error_code).toBe('ALLOWLIST_DENIED');
    expect(payload.command).toBe('rm');
    // No started/completed should fire — allowlist rejects before run.
    expect(eventsByKind(h.store, 'host_exec_started')).toHaveLength(0);
    expect(eventsByKind(h.store, 'host_exec_completed')).toHaveLength(0);
  });

  it('SCOPE-allowed but ALLOWLIST_DENIED for git rebase -i (interactive)', async () => {
    grantHostExecScope(h.trustStore);
    const res = await callHostExec(h.client, {
      command: 'git',
      args: ['rebase', '-i', 'HEAD~1'],
    });
    expect(res.error_code).toBe('ALLOWLIST_DENIED');
    expect(res.error).toMatch(/rebase -i|interactive/i);
  });

  it('end-to-end success: scope + allowlist OK → emits started + completed and runs git --version', async () => {
    const scopeId = grantHostExecScope(h.trustStore);
    const res = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(res.ok).toBe(true);
    expect(res.scope_id).toBe(scopeId);
    expect(res.exit_code).toBe(0);
    expect(res.stdout as string).toMatch(/git version/i);

    const started = eventsByKind(h.store, 'host_exec_started');
    const completed = eventsByKind(h.store, 'host_exec_completed');
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    // Correlation id ties started and completed together.
    const startedCorr = (started[0].payload as Record<string, unknown>).correlation_id;
    const completedCorr = (completed[0].payload as Record<string, unknown>).correlation_id;
    expect(startedCorr).toBe(completedCorr);
    expect(startedCorr).toBe(res.correlation_id);
    // Scope action recorded — actions_executed should be 1.
    const scope = h.trustStore.get(scopeId);
    expect(scope?.actions_executed).toBe(1);
  });

  it('scope param_constraints narrow the grant — git allowed, npm denied', async () => {
    // Operator grants a scope that ONLY covers `command === 'git'`.
    grantHostExecScope(h.trustStore, {
      paramConstraints: { command: 'git' },
    });
    const gitRes = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(gitRes.ok).toBe(true);
    const npmRes = await callHostExec(h.client, { command: 'npm', args: ['--version'] });
    expect(npmRes.ok).toBe(false);
    expect(npmRes.error_code).toBe('SCOPE_DENIED');
  });

  it('CWD_DENIED when cwd resolves outside project root', async () => {
    grantHostExecScope(h.trustStore);
    const res = await callHostExec(h.client, {
      command: 'git',
      args: ['--version'],
      cwd: '../../../',
    });
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe('CWD_DENIED');
    const denials = eventsByKind(h.store, 'host_exec_denied');
    expect(denials).toHaveLength(1);
    expect((denials[0].payload as Record<string, unknown>).error_code).toBe('CWD_DENIED');
    // started fires (we committed to run) but completed does NOT.
    expect(eventsByKind(h.store, 'host_exec_started')).toHaveLength(1);
    expect(eventsByKind(h.store, 'host_exec_completed')).toHaveLength(0);
  });

  it('audit log totals: 10 mixed calls produce one event per call across started/completed/denied', async () => {
    grantHostExecScope(h.trustStore);
    // 5 allowed, 5 denied (mix of SCOPE_DENIED via revoke-and-restore and
    // ALLOWLIST_DENIED).
    for (let i = 0; i < 3; i++) {
      const r = await callHostExec(h.client, { command: 'git', args: ['--version'] });
      expect(r.ok).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      const r = await callHostExec(h.client, { command: 'rm', args: ['-rf', String(i)] });
      expect(r.ok).toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      const r = await callHostExec(h.client, {
        command: 'git',
        args: ['rebase', '-i', `HEAD~${i + 1}`],
      });
      expect(r.ok).toBe(false);
    }
    // Briefly revoke + call to produce SCOPE_DENIED.
    const stillActive = h.trustStore.list({ status: 'active' })[0];
    if (stillActive) {
      h.trustStore.revoke(stillActive.id);
      for (let i = 0; i < 3; i++) {
        const r = await callHostExec(h.client, { command: 'git', args: ['log'] });
        expect(r.ok).toBe(false);
        expect(r.error_code).toBe('SCOPE_DENIED');
      }
    }

    const started = eventsByKind(h.store, 'host_exec_started');
    const completed = eventsByKind(h.store, 'host_exec_completed');
    const denied = eventsByKind(h.store, 'host_exec_denied');
    expect(started).toHaveLength(3);
    expect(completed).toHaveLength(3);
    expect(denied).toHaveLength(7); // 2 ALLOWLIST + 2 ALLOWLIST + 3 SCOPE
  });
});
