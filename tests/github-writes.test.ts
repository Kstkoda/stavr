import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import type { StoredEvent } from '../src/persistence.js';
import {
  GITHUB_WRITE_TOOL_NAMES,
  registerGithubWriteTools,
  type WriteExecOpts,
  type WriteExecRunner,
} from '../src/adapters/github-writes.js';

type ExecCall = { args: string[]; input?: string };
type ExecResponse =
  | { stdout: string; stderr?: string }
  | { error: { message: string; stderr?: string; code?: number } };

interface Harness {
  client: Client;
  broker: Broker;
  store: EventStore;
  calls: ExecCall[];
  events: StoredEvent[];
  close: () => Promise<void>;
}

async function makeWriteHarness(
  plan: (args: string[], input?: string) => ExecResponse,
  decisionTimeoutSec = 5,
): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const calls: ExecCall[] = [];
  const events: StoredEvent[] = [];

  const origPublish = broker.publish.bind(broker);
  broker.publish = async (event) => {
    const stored = await origPublish(event);
    events.push(stored);
    return stored;
  };

  const exec: WriteExecRunner = async (
    _file: string,
    args: string[],
    opts: WriteExecOpts,
  ) => {
    calls.push({ args, input: opts.input });
    const r = plan(args, opts.input);
    if ('error' in r) {
      const err = new Error(r.error.message) as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = r.error.stderr;
      err.code = r.error.code;
      throw err;
    }
    return { stdout: r.stdout, stderr: r.stderr ?? '' };
  };

  const server = new McpServer({ name: 'gw-test', version: '0.0.0' });
  registerGithubWriteTools(server, broker, { exec, decisionTimeoutSec });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'gw-test-client', version: '0.0.0' });
  await client.connect(clientT);

  return {
    client,
    broker,
    store,
    calls,
    events,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  let structured: any = undefined;
  try {
    structured = JSON.parse(text);
  } catch {
    /* leave undefined */
  }
  return { structured, isError: res.isError === true, text };
}

async function waitForPendingDecision(
  broker: Broker,
  timeoutMs = 2000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const recent = broker.store.listRecentDecisions(5);
    const open = recent.find((d) => d.status === 'open');
    if (open) return open.correlation_id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no pending decision after timeout');
}

async function approve(broker: Broker, correlationId: string): Promise<void> {
  const r = broker.store.respondToDecision(
    correlationId,
    'approve',
    'test approve',
    'unstamped-loopback',
  );
  if (!r.ok) throw new Error(`approve failed: ${r.error}`);
  await broker.publish({
    kind: 'decision_response',
    at: r.result.responded_at,
    correlation_id: correlationId,
    source_agent: 'unstamped-loopback',
    payload: {
      chosen_option_id: 'approve',
      reason: 'test approve',
      responder: 'unstamped-loopback',
    },
  });
}

async function reject(broker: Broker, correlationId: string): Promise<void> {
  const r = broker.store.respondToDecision(
    correlationId,
    'reject',
    'test reject',
    'unstamped-loopback',
  );
  if (!r.ok) throw new Error(`reject failed: ${r.error}`);
  await broker.publish({
    kind: 'decision_response',
    at: r.result.responded_at,
    correlation_id: correlationId,
    source_agent: 'unstamped-loopback',
    payload: {
      chosen_option_id: 'reject',
      reason: 'test reject',
      responder: 'unstamped-loopback',
    },
  });
}

describe('GitHub write adapter — gated by await_decision', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('registers all 10 write tools', async () => {
    harness = await makeWriteHarness(() => ({ stdout: '' }));
    const list = await harness.client.listTools();
    const names = list.tools.map((t) => t.name);
    for (const expected of GITHUB_WRITE_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(GITHUB_WRITE_TOOL_NAMES.length).toBe(10);
  });

  // ── github.create_pr ──────────────────────────────────────────────────
  describe('github.create_pr', () => {
    it('approve path: emits decision_request then pr_opened, runs gh, returns pr_url and pr_number', async () => {
      harness = await makeWriteHarness((args) => {
        expect(args.slice(0, 2)).toEqual(['pr', 'create']);
        expect(args).toContain('--repo');
        expect(args).toContain('stenlund/stavr');
        expect(args).toContain('--head');
        expect(args).toContain('feat/test');
        expect(args).toContain('--base');
        expect(args).toContain('main');
        expect(args).toContain('--title');
        expect(args).toContain('Phase B smoke');
        expect(args).toContain('--body-file');
        expect(args).toContain('-');
        expect(args).toContain('--draft');
        return { stdout: 'https://github.com/stenlund/stavr/pull/42\n' };
      });

      const pending = callTool(harness.client, 'github.create_pr', {
        repo: 'stenlund/stavr',
        head: 'feat/test',
        base: 'main',
        title: 'Phase B smoke',
        body: 'a longer body\nwith newlines',
        draft: true,
      });

      const correlationId = await waitForPendingDecision(harness.broker);
      await approve(harness.broker, correlationId);

      const { structured, isError } = await pending;
      expect(isError).toBe(false);
      expect(structured.ok).toBe(true);
      expect(structured.pr_url).toBe('https://github.com/stenlund/stavr/pull/42');
      expect(structured.pr_number).toBe(42);

      // exec received the body via stdin (not on the command line)
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0].input).toBe('a longer body\nwith newlines');

      // events: decision_request emitted before pr_opened
      const kinds = harness.events.map((e) => e.kind);
      const reqIdx = kinds.indexOf('decision_request');
      const openedIdx = kinds.indexOf('pr_opened');
      expect(reqIdx).toBeGreaterThanOrEqual(0);
      expect(openedIdx).toBeGreaterThan(reqIdx);
      const prOpened = harness.events[openedIdx];
      expect((prOpened.payload as any).url).toBe('https://github.com/stenlund/stavr/pull/42');
      expect((prOpened.payload as any).title).toBe('Phase B smoke');
    });

    it('reject path: no gh call, no pr_opened event, returns rejected_by_user', async () => {
      harness = await makeWriteHarness(() => ({ stdout: 'should-not-be-called' }));

      const pending = callTool(harness.client, 'github.create_pr', {
        repo: 'stenlund/stavr',
        head: 'feat/x',
        base: 'main',
        title: 'Should be rejected',
        body: '',
      });

      const correlationId = await waitForPendingDecision(harness.broker);
      await reject(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('rejected_by_user');
      expect(harness.calls).toHaveLength(0);
      expect(harness.events.find((e) => e.kind === 'pr_opened')).toBeUndefined();
    });

    it('timeout path: no gh call, returns rejected_by_user via switch-default', async () => {
      harness = await makeWriteHarness(
        () => ({ stdout: 'should-not-be-called' }),
        1, // 1-second timeout
      );

      const { structured } = await callTool(harness.client, 'github.create_pr', {
        repo: 'stenlund/stavr',
        head: 'feat/x',
        base: 'main',
        title: 'Will time out',
        body: '',
      });

      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('rejected_by_user');
      expect(harness.calls).toHaveLength(0);
      // switch-default fallback fired
      const fallback = harness.events.find(
        (e) =>
          e.kind === 'decision_response' &&
          (e.payload as any)?.responder === 'switch-default',
      );
      expect(fallback).toBeDefined();
    });

    it('invalid input: Zod rejects non-string repo before opening a decision', async () => {
      harness = await makeWriteHarness(() => ({ stdout: '' }));
      const res = await harness.client.callTool({
        name: 'github.create_pr',
        arguments: {
          repo: 123 as unknown as string,
          head: 'feat/x',
          base: 'main',
          title: 'x',
          body: '',
        },
      });
      expect(res.isError).toBe(true);
      // No decision opened, no gh call.
      expect(harness.broker.store.listRecentDecisions(5)).toHaveLength(0);
      expect(harness.calls).toHaveLength(0);
    });

    it('gh failure: approve path with execFile rejecting — returns gh_failed, no pr_opened event', async () => {
      harness = await makeWriteHarness(() => ({
        error: { message: 'gh: not authenticated', stderr: 'auth required', code: 4 },
      }));

      const pending = callTool(harness.client, 'github.create_pr', {
        repo: 'stenlund/stavr',
        head: 'feat/x',
        base: 'main',
        title: 'gh will fail',
        body: '',
      });

      const correlationId = await waitForPendingDecision(harness.broker);
      await approve(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('gh_failed');
      expect(structured.message).toMatch(/gh pr create.*failed/);
      expect(harness.calls).toHaveLength(1);
      expect(harness.events.find((e) => e.kind === 'pr_opened')).toBeUndefined();
    });
  });

  // ── github.merge_pr ───────────────────────────────────────────────────
  describe('github.merge_pr', () => {
    it('approve path: runs merge then fetches mergeCommit oid', async () => {
      let callIdx = 0;
      harness = await makeWriteHarness((args) => {
        callIdx++;
        if (callIdx === 1) {
          expect(args.slice(0, 3)).toEqual(['pr', 'merge', '42']);
          expect(args).toContain('--squash');
          expect(args).toContain('--delete-branch');
          return { stdout: '' };
        }
        // second call: gh pr view ... --json mergeCommit
        expect(args.slice(0, 2)).toEqual(['pr', 'view']);
        expect(args).toContain('mergeCommit');
        return { stdout: JSON.stringify({ mergeCommit: { oid: 'abc123def' } }) };
      });

      const pending = callTool(harness.client, 'github.merge_pr', {
        repo: 'stenlund/stavr',
        number: 42,
      });

      const correlationId = await waitForPendingDecision(harness.broker);
      await approve(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(true);
      expect(structured.merged_sha).toBe('abc123def');
      expect(harness.calls).toHaveLength(2);
    });

    it('reject path: no merge call, returns rejected_by_user', async () => {
      harness = await makeWriteHarness(() => ({ stdout: '' }));

      const pending = callTool(harness.client, 'github.merge_pr', {
        repo: 'stenlund/stavr',
        number: 42,
      });
      const correlationId = await waitForPendingDecision(harness.broker);
      await reject(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('rejected_by_user');
      expect(harness.calls).toHaveLength(0);
    });

    it('timeout path: no merge call', async () => {
      harness = await makeWriteHarness(() => ({ stdout: '' }), 1);
      const { structured } = await callTool(harness.client, 'github.merge_pr', {
        repo: 'stenlund/stavr',
        number: 42,
      });
      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('rejected_by_user');
      expect(harness.calls).toHaveLength(0);
    });

    it('threads the optional reason into the decision question', async () => {
      harness = await makeWriteHarness(() => ({ stdout: '' }));
      const pending = callTool(harness.client, 'github.merge_pr', {
        repo: 'stenlund/stavr',
        number: 99,
        reason: 'CI green on both runners; review blocker cleared',
      });
      const correlationId = await waitForPendingDecision(harness.broker);
      await reject(harness.broker, correlationId);
      await pending;
      const req = harness.events.find((e) => e.kind === 'decision_request');
      expect(req).toBeDefined();
      expect(String((req!.payload as { question?: string }).question)).toContain(
        'Reason: CI green on both runners; review blocker cleared',
      );
    });
  });

  // ── github.create_pr_comment ──────────────────────────────────────────
  describe('github.create_pr_comment', () => {
    it('approve path: pipes body via stdin, returns comment_url', async () => {
      harness = await makeWriteHarness((args, input) => {
        expect(args.slice(0, 3)).toEqual(['pr', 'comment', '7']);
        expect(args).toContain('--body-file');
        expect(args).toContain('-');
        expect(input).toBe('LGTM — merge after CI passes.');
        return {
          stdout: 'https://github.com/stenlund/stavr/pull/7#issuecomment-555\n',
        };
      });

      const pending = callTool(harness.client, 'github.create_pr_comment', {
        repo: 'stenlund/stavr',
        number: 7,
        body: 'LGTM — merge after CI passes.',
      });
      const correlationId = await waitForPendingDecision(harness.broker);
      await approve(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(true);
      expect(structured.comment_url).toBe(
        'https://github.com/stenlund/stavr/pull/7#issuecomment-555',
      );
    });

    it('reject path: no gh call', async () => {
      harness = await makeWriteHarness(() => ({ stdout: 'unreachable' }));
      const pending = callTool(harness.client, 'github.create_pr_comment', {
        repo: 'stenlund/stavr',
        number: 7,
        body: 'whatever',
      });
      const correlationId = await waitForPendingDecision(harness.broker);
      await reject(harness.broker, correlationId);

      const { structured } = await pending;
      expect(structured.ok).toBe(false);
      expect(structured.reason).toBe('rejected_by_user');
      expect(harness.calls).toHaveLength(0);
    });
  });
});
