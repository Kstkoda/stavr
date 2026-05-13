import { describe, expect, it, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { registerStewardAskTool } from '../src/steward-ask-tool.js';

async function harness() {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerStewardAskTool(server, broker);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientT);
  return { store, broker, server, client };
}

function parseText(res: { content: unknown }): { parsed: any; raw: string } {
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  let parsed: any = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave undefined */
  }
  return { parsed, raw: text };
}

describe('Spec 49 Layer 2 — mcp__cowire__steward_ask', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });

  it('wait_for_response=false returns correlation_id immediately and emits steward_prompt', async () => {
    const res = await h.client.callTool({
      name: 'steward_ask',
      arguments: { text: 'hello', wait_for_response: false },
    });
    const { parsed } = parseText(res);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.correlation_id).toBe('string');
    const events = h.store.getEvents({ kinds: ['steward_prompt'] }).events;
    expect(events).toHaveLength(1);
    expect(events[0].correlation_id).toBe(parsed.correlation_id);
  });

  it('wait_for_response=true returns the matching steward_response.text', async () => {
    // Pre-publish a steward_response after a short delay matching the next correlation_id.
    // We can't know the correlation_id in advance, so we install a one-shot tap that
    // replies as soon as we see the steward_prompt fire.
    // Defer the mock response with setTimeout so it lands AFTER the tool
    // handler has subscribed via waitForResponse. Publishing synchronously
    // inside the same fanout tick would beat the subscriber to the punch.
    const dispose = h.broker.onEvent((ev) => {
      if (ev.kind === 'steward_prompt') {
        const cid = ev.correlation_id;
        setTimeout(() => {
          void h.broker.publish({
            kind: 'steward_response',
            at: new Date().toISOString(),
            correlation_id: cid,
            source_agent: 'mock-steward',
            payload: { text: 'mock answer' },
          });
        }, 20);
      }
    });
    try {
      const res = await h.client.callTool({
        name: 'steward_ask',
        arguments: { text: 'question', wait_for_response: true, timeout_ms: 2000 },
      });
      const { parsed } = parseText(res);
      expect(parsed.ok).toBe(true);
      expect(parsed.text).toBe('mock answer');
    } finally {
      dispose();
    }
  });

  it('times out cleanly when no response arrives in timeout_ms', async () => {
    const res = await h.client.callTool({
      name: 'steward_ask',
      arguments: { text: 'question', wait_for_response: true, timeout_ms: 100 },
    });
    const { parsed } = parseText(res);
    expect(parsed.timeout).toBe(true);
    expect(parsed.waited_ms).toBe(100);
  });
});
