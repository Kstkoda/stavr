import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { createSwitchServer } from '../src/server.js';
import { startupDecisionSweep } from '../src/tools/decisions.js';

interface ConnectedClient {
  client: Client;
  notifications: Array<{ method: string; params: any }>;
  close: () => Promise<void>;
}

async function connectClient(broker: Broker, name: string): Promise<ConnectedClient> {
  const handle = createSwitchServer(broker);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverT);
  const client = new Client({ name, version: '0.0.0' });
  const notifications: Array<{ method: string; params: any }> = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push({ method: n.method, params: n.params });
  };
  await client.connect(clientT);
  return {
    client,
    notifications,
    close: async () => {
      await client.close();
      broker.removeSession(handle.sessionId);
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  return { parsed: JSON.parse(text), raw: res };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Phase B — decision flow', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('resolves await_decision when respond_to_decision arrives', async () => {
    const cc = await connectClient(broker, 'cc');
    const cowork = await connectClient(broker, 'cowork');

    await callTool(cowork.client, 'subscribe_to_events', { kinds: ['decision_request'] });

    // CC opens decision (don't await yet).
    const awaitPromise = callTool(cc.client, 'await_decision', {
      question: 'pick one',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Bravo' },
      ],
      timeout_sec: 5,
    });

    // Give the notification a moment to reach cowork.
    await sleep(50);
    expect(cowork.notifications.length).toBe(1);
    const correlation = cowork.notifications[0].params.correlation_id;
    expect(correlation).toBeTruthy();

    // Cowork responds.
    const resp = await callTool(cowork.client, 'respond_to_decision', {
      correlation_id: correlation,
      chosen_option_id: 'a',
      reason: 'A is the answer',
      responder: 'cowork-user',
    });
    expect(resp.parsed.ok).toBe(true);

    const settled = await awaitPromise;
    expect(settled.parsed.chosen_option_id).toBe('a');
    // Phase 4.5 — the responder ARG to respond_to_decision is advisory
    // only; the tool records the VERIFIED actor (logContext.actor_id) as
    // responder. In an in-memory MCP test client there is no HTTP
    // middleware stamping actor_id, so the verified caller falls through
    // to 'unstamped-loopback' — the loopback default the tool's policy
    // treats as the operator.
    expect(settled.parsed.responder).toBe('unstamped-loopback');
    expect(settled.parsed.timed_out).toBe(false);

    await cc.close();
    await cowork.close();
  });

  it('falls back to default_option_id on timeout', async () => {
    const cc = await connectClient(broker, 'cc');
    const start = Date.now();
    const settled = await callTool(cc.client, 'await_decision', {
      question: 'nobody home',
      options: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
      default_option_id: 'x',
      timeout_sec: 1,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(settled.parsed.timed_out).toBe(true);
    expect(settled.parsed.chosen_option_id).toBe('x');
    expect(settled.parsed.responder).toBe('switch-default');
    await cc.close();
  });

  it('errors on timeout when no default is provided', async () => {
    const cc = await connectClient(broker, 'cc');
    const res = await cc.client.callTool({
      name: 'await_decision',
      arguments: {
        question: 'nobody home, no default',
        options: [{ id: 'x', label: 'X' }],
        timeout_sec: 1,
      },
    });
    expect(res.isError).toBe(true);
    await cc.close();
  });

  it('records decision_late_response when a response arrives after fallback', async () => {
    const cc = await connectClient(broker, 'cc');
    const cowork = await connectClient(broker, 'cowork');
    await callTool(cowork.client, 'subscribe_to_events', {
      kinds: ['decision_request', 'decision_late_response'],
    });

    const settled = await callTool(cc.client, 'await_decision', {
      question: 'will be late',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      default_option_id: 'a',
      timeout_sec: 1,
    });
    expect(settled.parsed.responder).toBe('switch-default');
    const correlation = settled.parsed.correlation_id;

    const lateResp = await callTool(cowork.client, 'respond_to_decision', {
      correlation_id: correlation,
      chosen_option_id: 'b',
      responder: 'cowork-user',
    });
    expect(lateResp.parsed.ok).toBe(false);
    expect(lateResp.parsed.error).toBe('already_responded');

    await sleep(30);
    const late = cowork.notifications.find((n) => n.params.kind === 'decision_late_response');
    expect(late).toBeTruthy();
    expect((late!.params.payload as any).fallback_was).toBe('a');

    await cc.close();
    await cowork.close();
  });

  it('rejects respond_to_decision for unknown or invalid options', async () => {
    const cc = await connectClient(broker, 'cc');
    const cowork = await connectClient(broker, 'cowork');

    // Unknown correlation
    const r1 = await callTool(cowork.client, 'respond_to_decision', {
      correlation_id: 'nope',
      chosen_option_id: 'a',
      responder: 'cowork-user',
    });
    expect(r1.parsed.ok).toBe(false);
    expect(r1.parsed.error).toBe('not_found');

    // Open one, then invalid option
    const awaitPromise = callTool(cc.client, 'await_decision', {
      question: 'q',
      options: [{ id: 'a', label: 'A' }],
      default_option_id: 'a',
      timeout_sec: 5,
    });
    await sleep(20);
    const decisions = broker.store.listRecentDecisions(1);
    const cid = decisions[0].correlation_id;

    const r2 = await callTool(cowork.client, 'respond_to_decision', {
      correlation_id: cid,
      chosen_option_id: 'zzz',
      responder: 'cowork-user',
    });
    expect(r2.parsed.ok).toBe(false);
    expect(r2.parsed.error).toBe('invalid_option');

    // Valid response unblocks the awaiting call.
    await callTool(cowork.client, 'respond_to_decision', {
      correlation_id: cid,
      chosen_option_id: 'a',
      responder: 'cowork-user',
    });
    const settled = await awaitPromise;
    expect(settled.parsed.chosen_option_id).toBe('a');

    await cc.close();
    await cowork.close();
  });

  it('persists across restart: open & overdue decisions expire on startup sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stavr-test-'));
    const dbPath = join(dir, 'runestone.db');
    try {
      // First run: open a decision with very short timeout, then close without responding.
      const store1 = new EventStore();
      store1.init(dbPath);
      store1.createDecision('overdue-1', 'q', [{ id: 'd', label: 'D' }], 1, 'd');
      // Manually back-date expires_at so the sweep picks it up.
      (store1 as any).db
        .prepare(`UPDATE decisions SET expires_at = ? WHERE correlation_id = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), 'overdue-1');
      store1.close();

      // Second run: startup sweep expires it and fires decision_late_response.
      const store2 = new EventStore();
      store2.init(dbPath);
      const broker2 = new Broker(store2);
      const swept = await startupDecisionSweep(broker2);
      expect(swept).toBe(1);
      const after = store2.getDecision('overdue-1');
      expect(after?.status).toBe('expired');
      const lateEvents = store2.getEvents({ kinds: ['decision_late_response'] }).events;
      expect(lateEvents.length).toBe(1);
      expect(lateEvents[0].correlation_id).toBe('overdue-1');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
