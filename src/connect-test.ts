import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface ConnectTestOptions {
  url: string;
  waitMs: number;
}

export interface ConnectTestResult {
  ok: boolean;
  connected_to: string;
  emitted_event_id?: string;
  subscribed_kinds: string[];
  received_count: number;
  received_kinds: string[];
}

export async function runConnectTest(opts: ConnectTestOptions): Promise<ConnectTestResult> {
  const transport = new SSEClientTransport(new URL(opts.url));
  const client = new Client({ name: 'cowire-connect-test', version: '0.0.1' });

  const received: Array<{ method: string; params: { kind?: string } }> = [];
  client.fallbackNotificationHandler = async (n) => {
    received.push({ method: n.method, params: (n.params ?? {}) as { kind?: string } });
  };

  await client.connect(transport);

  // Subscribe to all kinds first so we observe our own emit.
  const subRes = await callTool(client, 'subscribe_to_events', { kinds: ['*'] });

  // Emit a probe event.
  const emitRes = await callTool(client, 'emit_event', {
    kind: 'progress',
    payload: { message: 'connect-test probe' },
    source_agent: 'cowire-connect-test',
  });

  // Wait for the notification to arrive.
  await sleep(opts.waitMs);

  await client.close();

  return {
    ok: true,
    connected_to: opts.url,
    emitted_event_id: typeof emitRes?.event_id === 'string' ? emitRes.event_id : undefined,
    subscribed_kinds: Array.isArray(subRes?.kinds) ? (subRes!.kinds as string[]) : [],
    received_count: received.length,
    received_kinds: received.map((n) => n.params.kind ?? '(none)'),
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }> | undefined;
  if (!content) return undefined;
  const text = content.map((c) => c.text ?? '').join('');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
