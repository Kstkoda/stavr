import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { createSwitchServer } from '../src/server.js';

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
  return JSON.parse(text);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Phase A — event flow', () => {
  let store: EventStore;
  let broker: Broker;

  beforeAll(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterAll(() => {
    store.close();
  });

  it('subscribes, receives broadcast, replays missed events on resubscribe', async () => {
    const a = await connectClient(broker, 'client-a');
    const b = await connectClient(broker, 'client-b');

    const subRes = await callTool(a.client, 'subscribe_to_events', { kinds: ['*'] });
    expect(subRes.kinds).toContain('*');

    const emitted: Array<{ kind: string; payload: any }> = [
      { kind: 'session_started', payload: { handoff_path: '/x', model: 'opus', mode: 'auto-accept' } },
      { kind: 'phase_started', payload: { phase_name: 'A', phase_index: 0, total_phases: 2 } },
      { kind: 'file_written', payload: { path: 'src/x.ts', lines_added: 10, lines_removed: 0 } },
      { kind: 'command_run', payload: { command: 'tsc', exit_code: 0, duration_ms: 1234 } },
      { kind: 'verification', payload: { check: 'tsc', status: 'pass' } },
    ];

    const eventIds: string[] = [];
    for (const e of emitted) {
      const r = await callTool(b.client, 'emit_event', { ...e, source_agent: 'cc' });
      eventIds.push(r.event_id);
    }

    // Allow fanout microtasks to flush.
    await sleep(30);

    expect(a.notifications.length).toBe(5);
    const receivedKinds = a.notifications.map((n) => n.params.kind);
    expect(receivedKinds).toEqual(emitted.map((e) => e.kind));
    // Ordering preserved by seq.
    const ids = a.notifications.map((n) => n.params.id);
    expect(ids).toEqual(eventIds);

    // Disconnect A.
    const lastSeen = a.notifications[a.notifications.length - 1].params.id;
    await a.close();

    // B emits 3 more events while A is offline.
    const moreEmitted = [
      { kind: 'progress', payload: { message: 'still cooking' } },
      { kind: 'commit_pushed', payload: { sha: 'abc', message: 'feat', branch: 'main' } },
      { kind: 'pr_opened', payload: { url: 'https://github.com/x/y/pull/1', title: 'WIP' } },
    ];
    for (const e of moreEmitted) {
      await callTool(b.client, 'emit_event', { ...e, source_agent: 'cc' });
    }

    // A reconnects and replays from lastSeen.
    const a2 = await connectClient(broker, 'client-a');
    const subRes2 = await callTool(a2.client, 'subscribe_to_events', {
      kinds: ['*'],
      since_event_id: lastSeen,
    });
    expect(subRes2.replayed_events).toBe(3);
    await sleep(30);
    expect(a2.notifications.length).toBe(3);
    expect(a2.notifications.map((n) => n.params.kind)).toEqual(['progress', 'commit_pushed', 'pr_opened']);

    await a2.close();
    await b.close();
  });

  it('filters by kind', async () => {
    const a = await connectClient(broker, 'a2');
    const b = await connectClient(broker, 'b2');
    const before = a.notifications.length;

    await callTool(a.client, 'subscribe_to_events', { kinds: ['error'] });
    await callTool(b.client, 'emit_event', {
      kind: 'progress',
      payload: { message: 'noise' },
      source_agent: 'cc',
    });
    await callTool(b.client, 'emit_event', {
      kind: 'error',
      payload: { message: 'boom', recoverable: false },
      source_agent: 'cc',
    });
    await sleep(30);
    expect(a.notifications.length).toBe(before + 1);
    expect(a.notifications[a.notifications.length - 1].params.kind).toBe('error');

    await a.close();
    await b.close();
  });

  it('rejects unknown event kinds', async () => {
    const a = await connectClient(broker, 'a3');
    const res = await a.client.callTool({
      name: 'emit_event',
      arguments: { kind: 'not_a_real_kind', payload: {}, source_agent: 'cc' },
    });
    expect(res.isError).toBe(true);
    await a.close();
  });

  it('get_events returns the persisted log', async () => {
    const a = await connectClient(broker, 'a4');
    const result = await callTool(a.client, 'get_events', { limit: 1000 });
    expect(result.events.length).toBeGreaterThan(0);
    expect(typeof result.has_more).toBe('boolean');
    await a.close();
  });
});
