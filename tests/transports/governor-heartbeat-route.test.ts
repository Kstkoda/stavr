import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { heartbeatStore } from '../../src/governor/heartbeat-store.js';

interface Harness {
  store: EventStore;
  broker: Broker;
  transports: MountedTransports;
  base: string;
}

async function boot(): Promise<Harness> {
  heartbeatStore.reset();
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
  const addr = transports.httpServer!.address() as AddressInfo;
  return { store, broker, transports, base: `http://127.0.0.1:${addr.port}` };
}

describe('governor-polish Cluster C — POST /governor/heartbeat', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.transports.shutdown();
    heartbeatStore.reset();
  });

  it('happy path: accepts a valid payload, returns 204, records it for diagnostics to read', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.6.11', signing: 'dev-signed', rust_version: '1.77.2' }),
    });
    expect(r.status).toBe(204);
    const cur = heartbeatStore.current();
    expect(cur).not.toBeNull();
    expect(cur?.version).toBe('0.6.11');
    expect(cur?.signing).toBe('dev-signed');
    expect(cur?.rust_version).toBe('1.77.2');
  });

  it('accepts the minimal valid payload (version only)', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.6.11' }),
    });
    expect(r.status).toBe(204);
    expect(heartbeatStore.current()?.version).toBe('0.6.11');
  });

  it('rejects unknown fields with 400 (strict schema)', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.6.11', extra: 'no' }),
    });
    expect(r.status).toBe(400);
    expect(heartbeatStore.current()).toBeNull();
  });

  it('rejects oversized version with 400', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v'.repeat(200) }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects signing values outside the enum with 400', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.6.11', signing: 'totally-trusted' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects missing version with 400', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signing: 'unsigned' }),
    });
    expect(r.status).toBe(400);
  });

  it('rejects oversized body (>1 KB) with 413, not 400', async () => {
    // Pack the body well past 1 KB. Server-side limit kicks in before
    // our schema validator does.
    const huge = JSON.stringify({ version: 'v'.repeat(2000) });
    const r = await fetch(`${h.base}/governor/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    // express.json({ limit: '1kb' }) returns 413 on PayloadTooLarge.
    expect(r.status).toBe(413);
    expect(heartbeatStore.current()).toBeNull();
  });

  it('GET on the heartbeat route is not allowed', async () => {
    const r = await fetch(`${h.base}/governor/heartbeat`);
    // Express returns 404 for an unmatched method/path combination.
    expect([404, 405]).toContain(r.status);
  });
});
