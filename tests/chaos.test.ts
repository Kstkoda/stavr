/**
 * Spec 44 — chaos tests.
 *
 * A. Daemon kill mid-decision: a decision opens, the store is force-closed
 *    (the in-process equivalent of SIGKILL — we can't actually kill the test
 *    process), a new store reopens the same SQLite file, and we assert that
 *    the startup sweep moves the still-open decision to `expired` with a
 *    `decision_late_response` event that a new client can replay.
 *
 * B. Multi-client disconnect + resume: two SSE clients subscribe; one is
 *    forcibly closed; events fan out only to the remaining one; the closed
 *    client reconnects and resumes from `since_event_id`, receiving the gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports, type MountedTransports } from '../src/transports.js';
import { startupDecisionSweep } from '../src/tools/decisions.js';

interface SseClient {
  client: Client;
  notifications: Array<{ method: string; params: { kind?: string; id?: string } }>;
  close: () => Promise<void>;
}

async function makeClient(url: string, name: string): Promise<SseClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name, version: '0.0.0' });
  const notifications: SseClient['notifications'] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push({ method: n.method, params: (n.params ?? {}) as { kind?: string; id?: string } });
  };
  await client.connect(transport);
  return {
    client,
    notifications,
    close: async () => {
      await client.close();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  return text ? JSON.parse(text) : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Spec 44 — chaos: decisions survive daemon kill', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-chaos-'));
    dbPath = join(tmp, 'runestone.db');
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows can hold WAL handles briefly; not material to the assertion */
    }
  });

  it('open decision is rescued by the startup sweep after a hard daemon close', async () => {
    // ---- daemon "instance 1": create an open decision, then yank the store ----
    const storeA = new EventStore();
    storeA.init(dbPath);
    const brokerA = new Broker(storeA);

    const correlation = 'chaos-decision-1';
    brokerA.store.createDecision(
      correlation,
      'pretend a worker asked something',
      [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
      300, // 5min timeout
      'no',
    );
    // Force the decision to be considered expired by the time the next process
    // sees it — sweep runs `expires_at < now`, so we hand it an expired stamp.
    // The chaos point is that the original process never got to respond.
    (storeA as any).db.prepare(`UPDATE decisions SET expires_at = ? WHERE correlation_id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      correlation,
    );
    expect(existsSync(dbPath)).toBe(true);
    expect(brokerA.store.pendingDecisionCount()).toBe(1);

    // Simulate SIGKILL: close the DB handle without any graceful shutdown.
    storeA.close();

    // ---- daemon "instance 2": fresh store opening the same file ----
    const storeB = new EventStore();
    storeB.init(dbPath);
    const brokerB = new Broker(storeB);

    // The decision must still be there with status='open' on disk.
    const before = storeB.getDecision(correlation);
    expect(before?.status).toBe('open');

    // Startup sweep moves it to 'expired' AND publishes decision_late_response.
    const sweptCount = await startupDecisionSweep(brokerB);
    expect(sweptCount).toBe(1);

    const after = storeB.getDecision(correlation);
    expect(after?.status).toBe('expired');

    // A fresh subscriber can replay-history and see the late-response event.
    const replay = storeB.getEvents({ kinds: ['decision_late_response'] });
    expect(replay.events.length).toBe(1);
    expect(replay.events[0].correlation_id).toBe(correlation);

    storeB.close();
  });
});

describe('Spec 44 — chaos: multi-client disconnect + resume', () => {
  let store: EventStore;
  let broker: Broker;
  let transports: MountedTransports;
  let url: string;

  beforeEach(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
    const addr = transports.httpServer!.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterEach(async () => {
    await transports.shutdown();
  });

  it('disconnected client can reconnect and resume from since_event_id', async () => {
    const a = await makeClient(url, 'client-a');
    const b = await makeClient(url, 'client-b');

    await callTool(a.client, 'subscribe_to_events', { kinds: ['*'] });
    await callTool(b.client, 'subscribe_to_events', { kinds: ['*'] });
    await sleep(50);

    // First event — both receive.
    const e1 = await callTool(a.client, 'emit_event', {
      kind: 'progress',
      payload: { message: 'before disconnect' },
      source_agent: 'client-a',
    });
    await sleep(150);
    expect(a.notifications.filter((n) => n.params.id === e1.event_id).length).toBe(1);
    expect(b.notifications.filter((n) => n.params.id === e1.event_id).length).toBe(1);

    // Force-close B's TCP transport. The daemon's `res.on('close')` removes
    // the broker session.
    await b.close();
    await sleep(100);

    // Second event — only A should receive.
    const e2 = await callTool(a.client, 'emit_event', {
      kind: 'progress',
      payload: { message: 'while B is gone' },
      source_agent: 'client-a',
    });
    await sleep(150);
    expect(a.notifications.filter((n) => n.params.id === e2.event_id).length).toBe(1);
    expect(b.notifications.filter((n) => n.params.id === e2.event_id).length).toBe(0);

    // B reconnects and resumes with since_event_id=e1.event_id — should be
    // told about e2 via the replay path inside subscribe_to_events.
    const bReconnected = await makeClient(url, 'client-b-rejoin');
    const subRes = await callTool(bReconnected.client, 'subscribe_to_events', {
      kinds: ['*'],
      since_event_id: e1.event_id,
    });
    await sleep(150);
    expect(subRes.replayed_events).toBeGreaterThanOrEqual(1);
    const replayedE2 = bReconnected.notifications.filter((n) => n.params.id === e2.event_id);
    expect(replayedE2.length).toBe(1);

    await a.close();
    await bReconnected.close();
  }, 15_000);
});
