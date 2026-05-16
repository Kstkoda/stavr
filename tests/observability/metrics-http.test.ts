/**
 * Integration test for the /metrics scrape endpoint.
 * Spec: bom-diagnostics-2026.md C1.4 acceptance.
 *
 * Boots a real daemon on an ephemeral port, hits /metrics, and asserts the
 * response is Prometheus OpenMetrics text containing both default node
 * runtime metrics and stavr custom metrics. Also verifies that the HTTP
 * duration histogram observes other routes (and excludes /metrics itself).
 */
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

describe('GET /metrics', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot();
  });

  afterEach(async () => {
    await h.transports.shutdown();
  });

  it('returns Prometheus text format with default + custom metrics', async () => {
    const res = await fetch(`${h.base}/metrics`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/text\/plain.*version=0\.0\.4/);
    const body = await res.text();
    expect(body).toMatch(/^# HELP/m);
    // Node runtime defaults from prom-client.
    expect(body).toMatch(/process_cpu_seconds_total|nodejs_heap_size_total_bytes/);
    // Stavr custom metrics declared.
    expect(body).toContain('stavr_events_emitted_total');
    expect(body).toContain('stavr_workers_alive');
    expect(body).toContain('stavr_sse_sessions');
    expect(body).toContain('stavr_http_request_duration_seconds');
    expect(body).toContain('stavr_bom_state');
  });

  it('http_request_duration_seconds observes other routes (not /metrics itself)', async () => {
    await fetch(`${h.base}/healthz`);
    const res = await fetch(`${h.base}/metrics`);
    const body = await res.text();
    // The histogram should have at least one sample for /healthz after the call above.
    expect(body).toMatch(/stavr_http_request_duration_seconds_count\{[^}]*route="\/healthz"[^}]*\}\s+[1-9]/);
    // /metrics is excluded from the histogram (no sample for route="/metrics").
    expect(body).not.toMatch(/route="\/metrics"/);
  });

  it('attaches a correlation_id header to every response', async () => {
    const res = await fetch(`${h.base}/healthz`);
    const cid = res.headers.get('x-correlation-id');
    expect(cid).toBeTruthy();
    expect(cid!).toMatch(/[0-9a-f-]{36}/);
  });

  it('echoes a caller-supplied correlation_id back in the response header', async () => {
    const res = await fetch(`${h.base}/healthz`, {
      headers: { 'x-correlation-id': 'caller-cid-xyz' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('caller-cid-xyz');
  });
});
