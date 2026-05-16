import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderShell } from '../../src/dashboard/shell.js';
import { renderCaptureButton, CAPTURE_BUTTON_JS } from '../../src/dashboard/components/capture-button.js';

describe('Capture ⊕ button — surface', () => {
  it('renders the floating action button + the modal shell', () => {
    const html = renderCaptureButton();
    expect(html).toContain('data-role="capture-fab"');
    expect(html).toContain('data-role="capture-modal"');
    expect(html).toContain('data-role="capture-comment"');
    expect(html).toContain('data-role="capture-type"');
    expect(html).toContain('data-role="capture-priority"');
    expect(html).toContain('data-role="capture-send"');
  });

  it('client JS gathers a snapshot via /healthz + /metrics and POSTs /dashboard/capture', () => {
    expect(CAPTURE_BUTTON_JS).toContain("'/healthz'");
    expect(CAPTURE_BUTTON_JS).toContain("'/metrics'");
    expect(CAPTURE_BUTTON_JS).toContain("'/dashboard/capture'");
    // Snapshot fields the brief calls out:
    expect(CAPTURE_BUTTON_JS).toContain('daemon_health');
    expect(CAPTURE_BUTTON_JS).toContain('process_resident_memory_bytes');
  });

  it('is mounted into the shell exactly once', () => {
    const html = renderShell({ title: 't', activePage: 'helm', body: '' });
    const markupOnly = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const count = markupOnly.split('data-role="capture-fab"').length - 1;
    expect(count).toBe(1);
  });
});

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

describe('POST /dashboard/capture — write path', () => {
  let h: Harness;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('400s on missing comment', async () => {
    const r = await fetch(`${h.base}/dashboard/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bug', snapshot: {} }),
    });
    expect(r.status).toBe(400);
  });

  it('400s on unknown type', async () => {
    const r = await fetch(`${h.base}/dashboard/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'x', type: 'oops', snapshot: {} }),
    });
    expect(r.status).toBe(400);
  });

  it('writes a record and emits a capture_filed event', async () => {
    const before = h.store.eventCount();
    const r = await fetch(`${h.base}/dashboard/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comment: 'Helm page rendered wrong on small screens.',
        type: 'bug',
        priority: 'high',
        snapshot: { page: 'helm', url: 'http://127.0.0.1/dashboard/helm' },
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.id).toMatch(/^cap_/);
    expect(j.destination).toBe('local');
    // The event count should have advanced — the capture_filed audit event
    // is the contract that survives 90d retention (ADR-030).
    expect(h.store.eventCount()).toBeGreaterThan(before);
    const events = h.store.getEvents({ limit: 50 }).events;
    expect(events.some((e) => e.kind === 'capture_filed')).toBe(true);
  });
});
