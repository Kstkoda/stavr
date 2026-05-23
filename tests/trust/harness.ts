import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { TrustStore } from '../../src/trust/store.js';
import { registerTrustScopeTools } from '../../src/trust/tools.js';
import { registerDecisionTools } from '../../src/tools/decisions.js';
import {
  registerGithubWriteTools,
  type WriteExecRunner,
  type WriteExecOpts,
} from '../../src/adapters/github-writes.js';
import {
  __resetTrustReporter,
  initTrustReporter,
  type TrustReporterOptions,
} from '../../src/trust/reporter.js';

export interface TrustHarness {
  client: Client;
  broker: Broker;
  store: EventStore;
  trustStore: TrustStore;
  events: StoredEvent[];
  ghCalls: Array<{ args: string[]; input?: string }>;
  close: () => Promise<void>;
}

export interface TrustHarnessOptions {
  /** Plan responses for `gh` invocations. */
  ghPlan?: (args: string[], input?: string) => { stdout: string } | { error: { message: string; code?: number; stderr?: string } };
  /** Decision timeout for github-write gating. Defaults short for fast tests. */
  decisionTimeoutSec?: number;
  /** Reporter timer overrides for test determinism. */
  reporterOptions?: TrustReporterOptions;
}

export async function makeTrustHarness(opts: TrustHarnessOptions = {}): Promise<TrustHarness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const trustStore = new TrustStore(store);

  const events: StoredEvent[] = [];
  const origPublish = broker.publish.bind(broker);
  broker.publish = async (event) => {
    const stored = await origPublish(event);
    events.push(stored);
    return stored;
  };

  initTrustReporter(broker, trustStore, opts.reporterOptions);

  const ghCalls: Array<{ args: string[]; input?: string }> = [];
  const exec: WriteExecRunner = async (
    _file: string,
    args: string[],
    options: WriteExecOpts,
  ) => {
    ghCalls.push({ args, input: options.input });
    const plan = opts.ghPlan ?? (() => ({ stdout: '' }));
    const r = plan(args, options.input);
    if ('error' in r) {
      const err = new Error(r.error.message) as Error & { stderr?: string; code?: number };
      err.stderr = r.error.stderr;
      err.code = r.error.code;
      throw err;
    }
    return { stdout: r.stdout, stderr: '' };
  };

  const server = new McpServer({ name: 'trust-test', version: '0.0.0' });
  registerDecisionTools(server, broker);
  registerTrustScopeTools(server, broker, trustStore);
  registerGithubWriteTools(server, broker, {
    exec,
    decisionTimeoutSec: opts.decisionTimeoutSec ?? 5,
    trustStore,
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'trust-test-client', version: '0.0.0' });
  await client.connect(clientT);

  return {
    client,
    broker,
    store,
    trustStore,
    events,
    ghCalls,
    close: async () => {
      await client.close();
      await server.close();
      __resetTrustReporter(broker);
      store.close();
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: any; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  let parsed: any = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave undefined */
  }
  return { parsed, isError: res.isError === true };
}

export async function waitForOpenDecision(broker: Broker, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const recent = broker.store.listRecentDecisions(5);
    const open = recent.find((d) => d.status === 'open');
    if (open) return open.correlation_id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no open decision after timeout');
}

export function approve(broker: Broker, correlationId: string, reason = 'approved'): void {
  // Phase 4.6 — operator-shape backstop is aligned with mayRespond
  // (loopback OR notify-verified-remote). Use the canonical stdio
  // loopback shape for direct-store callers.
  const r = broker.store.respondToDecision(correlationId, 'approve', reason, 'unstamped-loopback');
  if (!r.ok) throw new Error(`respondToDecision failed: ${(r as any).error}`);
}

export function reject(broker: Broker, correlationId: string, reason = 'rejected'): void {
  const r = broker.store.respondToDecision(correlationId, 'reject', reason, 'unstamped-loopback');
  if (!r.ok) throw new Error(`respondToDecision failed: ${(r as any).error}`);
}

/**
 * Propose + grant a scope, handling the await_decision approval inside trust_scope_grant.
 * Returns the active scope id.
 */
export async function proposeAndGrant(
  h: TrustHarness,
  proposeArgs: Record<string, unknown>,
): Promise<string> {
  const prop = await callTool(h.client, 'trust_scope_propose', proposeArgs);
  if (!prop.parsed?.scope_id) throw new Error('propose failed: ' + JSON.stringify(prop));
  const grantPromise = callTool(h.client, 'trust_scope_grant', {
    id: prop.parsed.scope_id,
    granted_by: 'user-direct',
    timeout_sec: 10,
  });
  const cid = await waitForOpenDecision(h.broker);
  approve(h.broker, cid);
  const granted = await grantPromise;
  if (!granted.parsed?.ok) throw new Error('grant failed: ' + JSON.stringify(granted));
  return prop.parsed.scope_id as string;
}

export function eventsOfKind(h: TrustHarness, kind: string): StoredEvent[] {
  return h.events.filter((e) => e.kind === kind);
}
