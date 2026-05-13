import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('Spec 49 Layer 2 — dashboard steward routes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('POST /dashboard/steward/prompt emits steward_prompt + returns 202 + correlation_id', async () => {
    const r = await fetch(`${h.base}/dashboard/steward/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello steward' }),
    });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.correlation_id).toBe('string');

    const events = h.store.getEvents({ kinds: ['steward_prompt'] }).events;
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.correlation_id).toBe(body.correlation_id);
    expect((ev.payload as { text: string }).text).toBe('hello steward');
  });

  it('POST /dashboard/steward/prompt rejects empty text', async () => {
    const r = await fetch(`${h.base}/dashboard/steward/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(r.status).toBe(400);
  });

  it('GET /dashboard/steward/responses streams only matching-correlation events', async () => {
    // Open the SSE first so we don't miss the emit.
    const otherCid = 'prompt-other';
    const wantedCid = 'prompt-wanted';
    const controller = new AbortController();
    const res = await fetch(
      `${h.base}/dashboard/steward/responses?correlation_id=${wantedCid}`,
      { headers: { accept: 'text/event-stream' }, signal: controller.signal },
    );
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Emit one event we want and one we don't.
    await h.broker.publish({
      kind: 'steward_response',
      at: new Date().toISOString(),
      correlation_id: otherCid,
      source_agent: 'steward',
      payload: { text: 'IGNORE ME' },
    });
    await h.broker.publish({
      kind: 'steward_response',
      at: new Date().toISOString(),
      correlation_id: wantedCid,
      source_agent: 'steward',
      payload: { text: 'KEEP ME' },
    });

    // Collect up to ~1 second of SSE chunks.
    let buf = '';
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('KEEP ME')) break;
    }
    controller.abort();

    expect(buf).toContain('KEEP ME');
    expect(buf).not.toContain('IGNORE ME');
  });
});
