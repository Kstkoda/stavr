/**
 * C4 acceptance — Decide page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { renderDecidePage, type DecideData } from '../../src/dashboard/pages/decide.js';
import type { DecisionRecord } from '../../src/persistence.js';

function dec(over: Partial<DecisionRecord> = {}): DecisionRecord {
  const now = Date.now();
  return {
    correlation_id: 'dec_' + Math.random().toString(36).slice(2, 8),
    question: 'sample?',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no',  label: 'No' },
    ],
    default_option_id: 'no',
    timeout_sec: 300,
    status: 'open',
    requested_at: new Date(now).toISOString(),
    expires_at: new Date(now + 300_000).toISOString(),
    ...over,
  };
}

describe('Decide page — unit', () => {
  it('renders one card per open decision with question + options', () => {
    const html = renderDecidePage({
      open: [
        dec({ correlation_id: 'a', question: 'Approve PR?' }),
        dec({ correlation_id: 'b', question: 'Promote to prod?' }),
      ],
      resolved: [],
    });
    expect(html).toContain('Approve PR?');
    expect(html).toContain('Promote to prod?');
    expect(html).toContain('data-corr="a"');
    expect(html).toContain('data-corr="b"');
    expect(html).toContain('data-role="respond"');
    expect(html).toContain('data-option="yes"');
    expect(html).toContain('data-option="no"');
  });

  it('marks the default option visually and shows the timeout fallback line', () => {
    const html = renderDecidePage({
      open: [dec({ correlation_id: 'a', default_option_id: 'no' })],
      resolved: [],
    });
    expect(html).toContain('opt-default');
    expect(html).toContain('switches to');
    expect(html).toContain('on timeout');
  });

  it('flags decisions with no default as error-class', () => {
    const html = renderDecidePage({
      open: [dec({ correlation_id: 'a', default_option_id: undefined })],
      resolved: [],
    });
    expect(html).toContain('no default — timeout errors');
  });

  it('passes the expires_at epoch to the client for the countdown', () => {
    const at = new Date('2030-01-01T00:05:00Z').toISOString();
    const html = renderDecidePage({
      open: [dec({ correlation_id: 'a', expires_at: at })],
      resolved: [],
    });
    expect(html).toContain(`data-expires="${Date.parse(at)}"`);
    expect(html).toContain('data-role="timer"');
  });

  it('renders a resolved section below for recent responses', () => {
    const html = renderDecidePage({
      open: [],
      resolved: [
        dec({
          correlation_id: 'r1',
          question: 'Push?',
          status: 'responded',
          chosen_option_id: 'yes',
          responded_by: 'kenneth',
          response_reason: 'approved by hand',
        }),
      ],
    });
    expect(html).toContain('Recently resolved');
    expect(html).toContain('Push?');
    expect(html).toContain('→ Yes');
    expect(html).toContain('by kenneth');
    expect(html).toContain('approved by hand');
  });

  it('shows an empty state when nothing is open', () => {
    const html = renderDecidePage({ open: [], resolved: [] });
    expect(html).toContain('No open decisions');
  });

  it('wires up SSE refresh on decision_* events', () => {
    const html = renderDecidePage({ open: [], resolved: [] });
    expect(html).toContain('/dashboard/stream');
    expect(html).toContain('decision_request');
    expect(html).toContain('decision_response');
    expect(html).toContain('EventSource');
  });

  it('includes a lazy context block per decision', () => {
    const html = renderDecidePage({
      open: [dec({ correlation_id: 'c' })],
      resolved: [],
    });
    expect(html).toContain('data-role="ctx"');
    expect(html).toContain('data-loaded="false"');
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

describe('Decide page — integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await boot(); });
  afterEach(async () => { await h.transports.shutdown(); });

  it('GET /dashboard/decide renders an open decision through the shell', async () => {
    h.store.createDecision('d-int', 'Merge?', [
      { id: 'merge', label: 'Merge' },
      { id: 'hold', label: 'Hold' },
    ], 120, 'hold');
    const r = await fetch(`${h.base}/dashboard/decide`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('Merge?');
    expect(body).toContain('data-corr="d-int"');
    expect(body).toContain('data-page="decide"');
    expect(body).toContain('data-option="merge"');
  });

  it('a responded decision shows up in the resolved section, not open', async () => {
    h.store.createDecision('d-resp', 'Run?', [{ id: 'go', label: 'Go' }, { id: 'no', label: 'No' }], 120, 'no');
    // Phase 4.5 — store-level operator-shape check; use a recognised label.
    h.store.respondToDecision('d-resp', 'go', 'manual', 'user-direct');
    const r = await fetch(`${h.base}/dashboard/decide`);
    const body = await r.text();
    expect(body).toContain('Run?');
    expect(body).toContain('Recently resolved');
    // The card should be in the resolved-card class, not decide-card
    expect(body).toContain('class="resolved-card" data-corr="d-resp"');
  });

  it('POST /dashboard/decisions/:id/respond still resolves (existing API, no change)', async () => {
    h.store.createDecision('d-x', 'q', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 120, 'b');
    const r = await fetch(`${h.base}/dashboard/decisions/d-x/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chosen_option_id: 'a' }),
    });
    expect(r.status).toBe(200);
    expect(h.store.getDecision('d-x')?.status).toBe('responded');
    expect(h.store.getDecision('d-x')?.chosen_option_id).toBe('a');
  });
});
