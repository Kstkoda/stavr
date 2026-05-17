// host_exec — regression lock corpus (BOM P5 acceptance).
//
// Each test here corresponds to a specific failure mode the BOM (and the
// allowlist's footgun appendix) calls out. If any of these flips green ->
// red in CI, the host_exec security boundary is COMPROMISED — investigate
// before merging. Do NOT loosen an assertion to make a test pass; either
// fix the regression or amend the BOM.
//
// The handler tests in host-exec-handler.test.ts cover the happy paths and
// scope transitions. This file is the "and stays denied" companion.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { createSwitchServer, getOrCreateTrustStore } from '../../src/server.js';
import type { TrustStore } from '../../src/trust/store.js';

interface Harness {
  client: Client;
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
  const client = new Client({ name: 'host-exec-regression', version: '0.0.0' });
  await client.connect(clientT);
  return {
    client,
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

function grantOpenHostExec(trustStore: TrustStore): string {
  const scope = trustStore.createProposal({
    title: 'host-ops',
    description: 'open host_exec scope for regression corpus',
    allowed_actions: [{ tool: 'host_exec' }],
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  trustStore.grant(scope.id, 'regression-test');
  return scope.id;
}

describe('host_exec — regression locks (negative corpus)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  // ---- Locks that hold even with an open scope --------------------------

  it('LOCK rm-is-denied: command "rm" with -rf / refused via ALLOWLIST_DENIED', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, { command: 'rm', args: ['-rf', '/'] });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
  });

  it('LOCK shell-metachar-in-command: "git ; rm -rf /" rejected without spawn', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'git ; rm -rf /',
      args: ['status'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
    // The reason must indicate metachars or absence from allowlist — either
    // way the call MUST NOT have reached spawn().
    expect(r.error).toMatch(/metachar|not in allowlist/);
  });

  it('LOCK git-rebase-interactive: -i variant refused', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'git',
      args: ['rebase', '-i', 'HEAD~3'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
    expect(r.error).toMatch(/rebase -i|interactive/i);
  });

  it('LOCK git-config-global: --global identity write refused', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'git',
      args: ['config', '--global', 'user.email', 'attacker@evil'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
    expect(r.error).toContain('--global');
  });

  it('LOCK git-filter-repo: history-rewrite tools refused', async () => {
    grantOpenHostExec(h.trustStore);
    expect((await callHostExec(h.client, { command: 'git', args: ['filter-repo'] })).error_code).toBe(
      'ALLOWLIST_DENIED',
    );
    expect(
      (await callHostExec(h.client, { command: 'git', args: ['filter-branch'] })).error_code,
    ).toBe('ALLOWLIST_DENIED');
  });

  it('LOCK npm-publish: package publishing refused', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, { command: 'npm', args: ['publish'] });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
  });

  it('LOCK npm-token-write: config set _authToken refused', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'npm',
      args: ['config', 'set', '//registry.npmjs.org/:_authToken', 'leaked'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
    expect(r.error).toMatch(/token/i);
  });

  it('LOCK pm2-set: global PM2 config writes refused', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, { command: 'pm2', args: ['set', 'foo', 'bar'] });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
  });

  it('LOCK node-disabled-by-default: node -e refused even with scope', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
    expect(r.error).toMatch(/disabled/i);
  });

  it('LOCK absolute-path-as-command: "/usr/bin/git" refused (must be a binary name)', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: '/usr/bin/git',
      args: ['status'],
    });
    expect(r.error_code).toBe('ALLOWLIST_DENIED');
  });

  it('LOCK cwd-escape: cwd ../../../etc refused via CWD_DENIED', async () => {
    grantOpenHostExec(h.trustStore);
    const r = await callHostExec(h.client, {
      command: 'git',
      args: ['--version'],
      cwd: '../../../etc',
    });
    expect(r.error_code).toBe('CWD_DENIED');
  });

  it('LOCK absolute-cwd-foreign: cwd targeting a foreign root refused via CWD_DENIED', async () => {
    grantOpenHostExec(h.trustStore);
    const foreign = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const r = await callHostExec(h.client, {
      command: 'git',
      args: ['--version'],
      cwd: foreign,
    });
    expect(r.error_code).toBe('CWD_DENIED');
  });

  // ---- Locks that hold even before/after scope -------------------------

  it('LOCK no-scope: every call refused without a scope', async () => {
    const r = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(r.error_code).toBe('SCOPE_DENIED');
  });

  it('LOCK expired-scope: scope flipped to expired no longer authorizes', async () => {
    const scopeId = grantOpenHostExec(h.trustStore);
    h.trustStore.markExpired(scopeId);
    const r = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(r.error_code).toBe('SCOPE_DENIED');
  });

  it('LOCK revoked-scope: revoking mid-session blocks subsequent calls', async () => {
    const scopeId = grantOpenHostExec(h.trustStore);
    const ok = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(ok.ok).toBe(true);
    h.trustStore.revoke(scopeId);
    const denied = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(denied.error_code).toBe('SCOPE_DENIED');
  });
});

describe('host_exec — positive smoke corpus', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
    grantOpenHostExec(h.trustStore);
  });
  afterEach(async () => {
    await h.close();
  });

  it('SMOKE git --version → exit 0, version text in stdout', async () => {
    const r = await callHostExec(h.client, { command: 'git', args: ['--version'] });
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout as string).toMatch(/git version/i);
  });

  it('SMOKE npm --version → exit 0 with semver-shaped stdout', async () => {
    const r = await callHostExec(h.client, { command: 'npm', args: ['--version'] });
    if (r.exit_code === -1) {
      // npm not installed on this CI host — skip per BOM P5 ("if PM2 not
      // installed, skip with note"; same applies to npm).
      console.warn('[host-exec smoke] npm not resolvable on this host — skipped');
      return;
    }
    if (r.exit_code !== 0) {
      throw new Error(
        `npm --version exited ${r.exit_code}: stderr=${String(r.stderr).slice(0, 400)} stdout=${String(r.stdout).slice(0, 200)}`,
      );
    }
    expect(r.ok).toBe(true);
    expect(r.stdout as string).toMatch(/^\d+\.\d+\.\d+/);
  });
});
