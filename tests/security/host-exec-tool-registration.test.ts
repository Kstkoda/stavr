import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { createSwitchServer } from '../../src/server.js';

// Contract test (BOM P2 acceptance): host_exec must appear in tools/list
// once the server boots. Catches regressions where the registration is
// accidentally moved behind a flag or dropped.

describe('host_exec — MCP tool registration', () => {
  let store: EventStore;
  let broker: Broker;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    const handle = createSwitchServer(broker);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverT);
    client = new Client({ name: 'host-exec-test', version: '0.0.0' });
    await client.connect(clientT);
    close = async () => {
      await client.close();
      broker.removeSession(handle.sessionId);
    };
  });

  afterAll(async () => {
    await close();
    store.close();
  });

  it('exposes host_exec in tools/list', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('host_exec');
  });

  it('host_exec advertises command/args/cwd/timeout_ms in its inputSchema', async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === 'host_exec');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(Object.keys(props!)).toEqual(
      expect.arrayContaining(['command', 'args', 'cwd', 'timeout_ms']),
    );
  });

  it('handler refuses without an active scope (SCOPE_DENIED)', async () => {
    const res = await client.callTool({
      name: 'host_exec',
      arguments: { command: 'git', args: ['status'] },
    });
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? '')
      .join('');
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe('SCOPE_DENIED');
    expect(parsed.correlation_id).toBeTypeOf('string');
  });
});
