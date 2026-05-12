import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports, type MountedTransports } from '../src/transports.js';

interface SseClient {
  client: Client;
  notifications: Array<{ method: string; params: { kind?: string; id?: string } }>;
  close: () => Promise<void>;
}

async function makeClient(url: string, name: string): Promise<SseClient> {
  const transport = new SSEClientTransport(new URL(url));
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

describe('Spec 40 Phase 1 — daemon multi-client fan-out', () => {
  let store: EventStore;
  let broker: Broker;
  let transports: MountedTransports;
  let url: string;

  beforeAll(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    // Port 0 → kernel picks an ephemeral port; we read it back below.
    transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
    const addr = transports.httpServer!.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/mcp/sse`;
  });

  afterAll(async () => {
    await transports.shutdown();
  });

  it('fans out events to all subscribed clients and survives one client disconnect', async () => {
    const a = await makeClient(url, 'client-a');
    const b = await makeClient(url, 'client-b');
    const c = await makeClient(url, 'client-c');

    // All three subscribe to every kind.
    await callTool(a.client, 'subscribe_to_events', { kinds: ['*'] });
    await callTool(b.client, 'subscribe_to_events', { kinds: ['*'] });
    await callTool(c.client, 'subscribe_to_events', { kinds: ['*'] });

    // Give the server a beat to register all three sessions.
    await sleep(50);

    // A emits.
    const emit1 = await callTool(a.client, 'emit_event', {
      kind: 'progress',
      payload: { message: 'hello from A' },
      source_agent: 'client-a',
    });

    // Wait for fan-out.
    await sleep(150);

    const aGot1 = a.notifications.filter((n) => n.params.id === emit1.event_id).length;
    const bGot1 = b.notifications.filter((n) => n.params.id === emit1.event_id).length;
    const cGot1 = c.notifications.filter((n) => n.params.id === emit1.event_id).length;
    // The emitting client subscribes to *, so it also receives its own event.
    expect(aGot1).toBe(1);
    expect(bGot1).toBe(1);
    expect(cGot1).toBe(1);

    // Disconnect B.
    await b.close();
    await sleep(100);

    // A emits again — only A and C should receive.
    const emit2 = await callTool(a.client, 'emit_event', {
      kind: 'progress',
      payload: { message: 'hello after B left' },
      source_agent: 'client-a',
    });
    await sleep(150);

    const aGot2 = a.notifications.filter((n) => n.params.id === emit2.event_id).length;
    const bGot2 = b.notifications.filter((n) => n.params.id === emit2.event_id).length;
    const cGot2 = c.notifications.filter((n) => n.params.id === emit2.event_id).length;
    expect(aGot2).toBe(1);
    expect(bGot2).toBe(0); // B is gone.
    expect(cGot2).toBe(1);

    await a.close();
    await c.close();
  }, 15_000);
});
