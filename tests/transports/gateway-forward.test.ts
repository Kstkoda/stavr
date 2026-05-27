/**
 * family-son-mcp Phase 5 Phase 3b — forward-handler tests with a mocked
 * upstream. NO real api.anthropic.com calls are made; the boot harness
 * passes `anthropicUpstreamFetch` to mountTransports so every fetch
 * lands on a stub the test controls.
 *
 * Scenarios covered:
 *
 *   happy path (200) — usage extracted, llm_gateway_completed emitted,
 *                      response body returned verbatim to the son.
 *   401  upstream    — body forwarded transparently, llm_gateway_error
 *                      emitted with error_class='upstream_status_401'.
 *   429  upstream    — body forwarded transparently (retry-after etc).
 *   500  upstream    — body forwarded; error_class='upstream_status_500'.
 *   malformed JSON   — 5xx-shape returned, body=undefined; error_class
 *                      ='upstream_body_not_json'.
 *   timeout/abort    — 504 returned; error_class='upstream_timeout'.
 *   no credential    — 500 'no_active_credential' BEFORE any upstream
 *                      call; error_class='no_active_credential'.
 *   F2 version       — son's anthropic-version is the value the upstream
 *                      receives in its x-api-key sibling header.
 *   key-bytes grep   — across every captured response + log + audit
 *                      payload, the synthetic key value does not appear.
 *                      This is the in-suite analog of the F6 manual
 *                      smoke that runs after operator approval with the
 *                      operator's real key bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore, type StoredEvent } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { CredentialStore } from '../../src/credentials/store.js';
import { setCredentialStore } from '../../src/server.js';

const SYNTHETIC_KEY = 'sk-ant-test-FORWARD-FAKE-KEY-DO-NOT-LEAK-9b8c7a6e5f4d3c2b1a';

interface MockUpstream {
  /** Captured headers from the most recent forward */
  lastRequestHeaders?: Headers;
  /** Captured body from the most recent forward */
  lastRequestBody?: string;
  /** Captured URL from the most recent forward */
  lastRequestUrl?: string;
  /** Number of times fetch was invoked. */
  callCount: number;
}

interface Harness {
  store: EventStore;
  broker: Broker;
  credStore: CredentialStore;
  transports: MountedTransports;
  base: string;
  /** All events the broker has persisted. */
  events: StoredEvent[];
  /** Mock upstream control surface. */
  mock: MockUpstream;
  /** The credential id seeded into the vault. */
  credentialId: string;
}

interface BootOpts {
  /** What the mock upstream returns. */
  upstreamResponse?: () => Promise<Response> | Response;
  /** Skip seeding a vault credential (tests the no-credential path). */
  skipVaultSeed?: boolean;
}

async function boot(opts: BootOpts = {}): Promise<Harness> {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  const masterKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) masterKey[i] = i;
  const credStore = new CredentialStore(store, masterKey);
  setCredentialStore(broker, credStore);

  let credentialId = '';
  if (!opts.skipVaultSeed) {
    const cred = credStore.add({
      user_id: 'operator',
      service: 'anthropic',
      kind: 'api_key',
      plaintext: SYNTHETIC_KEY,
      metadata: { purpose: 'gateway', seeded_via: 'test-fixture' },
    });
    credentialId = cred.id;
  }

  const events: StoredEvent[] = [];
  broker.onRawEvent((ev) => events.push(ev));

  const mock: MockUpstream = { callCount: 0 };
  const upstreamFetch: typeof fetch = async (input, init) => {
    mock.callCount += 1;
    mock.lastRequestUrl = typeof input === 'string' ? input : (input as Request).url;
    if (init?.headers) {
      mock.lastRequestHeaders = new Headers(init.headers as HeadersInit);
    }
    if (init?.body && typeof init.body === 'string') {
      mock.lastRequestBody = init.body;
    }
    if (opts.upstreamResponse) {
      return opts.upstreamResponse();
    }
    return new Response('{}', { status: 200 });
  };

  const transports = await mountTransports(broker, {
    mode: 'daemon',
    port: 0,
    silent: true,
    anthropicUpstreamFetch: upstreamFetch,
  });
  const addr = transports.httpServer!.address() as AddressInfo;
  return {
    store,
    broker,
    credStore,
    transports,
    base: `http://127.0.0.1:${addr.port}`,
    events,
    mock,
    credentialId,
  };
}

const REQ_BODY = JSON.stringify({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'ping' }],
});

const SUCCESS_BODY = {
  id: 'msg_01ABC',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'pong' }],
  model: 'claude-opus-4-7',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

function assertKeyBytesAbsent(blob: string, label: string): void {
  expect(blob, `${label} contained the SYNTHETIC_KEY bytes`).not.toContain(SYNTHETIC_KEY);
  // Defensive 8-byte prefix.
  expect(blob, `${label} contained the SYNTHETIC_KEY prefix`).not.toContain(SYNTHETIC_KEY.slice(0, 12));
}

describe('Phase 5 Phase 3b · /anthropic/v1/messages forward (mocked upstream)', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.transports.shutdown();
  });

  it('SUCCESS — upstream 200 → response forwarded, usage extracted, llm_gateway_completed emitted', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(JSON.stringify(SUCCESS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual(SUCCESS_BODY);

    const completed = h.events.find((e) => e.kind === 'llm_gateway_completed');
    expect(completed).toBeDefined();
    const payload = completed!.payload as Record<string, unknown>;
    expect(payload.tokens_in).toBe(12);
    expect(payload.tokens_out).toBe(5);
    expect(payload.upstream_status).toBe(200);
    expect(payload.model).toBe('claude-opus-4-7');
    expect(payload.credential_id).toBe(h.credentialId);

    // Allowed emit precedes completed.
    const allowedIdx = h.events.findIndex((e) => e.kind === 'llm_gateway_allowed');
    const completedIdx = h.events.findIndex((e) => e.kind === 'llm_gateway_completed');
    expect(allowedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(allowedIdx);

    // No key bytes leak in any captured surface.
    for (const ev of h.events) {
      assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
    }
    assertKeyBytesAbsent(JSON.stringify(body), 'success response body');
  });

  it('UPSTREAM 401 — body forwarded verbatim, llm_gateway_error emitted with error_class=upstream_status_401', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');

    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect(errEv).toBeDefined();
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_status_401');
    expect((errEv!.payload as Record<string, unknown>).upstream_status).toBe(401);

    for (const ev of h.events) assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
    assertKeyBytesAbsent(JSON.stringify(body), '401 response body');
  });

  it('UPSTREAM 429 — body forwarded verbatim with retry-after-like payload', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.error.type).toBe('rate_limit_error');

    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_status_429');

    for (const ev of h.events) assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
    assertKeyBytesAbsent(JSON.stringify(body), '429 response body');
  });

  it('UPSTREAM 500 — body forwarded; error_class=upstream_status_500', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream broke' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(500);
    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_status_500');
    for (const ev of h.events) assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
  });

  it('UPSTREAM MALFORMED JSON — 5xx-shape returned; error_class=upstream_body_not_json', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response('<!DOCTYPE html><html>upstream returned HTML</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    // forwardAnthropicMessages returns status=res.status when parse fails.
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('upstream_body_not_json');

    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_body_not_json');
    for (const ev of h.events) assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
    assertKeyBytesAbsent(JSON.stringify(body), 'malformed-json response body');
  });

  it('UPSTREAM TIMEOUT — fetch aborts; 504 returned with error_class=upstream_timeout', async () => {
    h = await boot({
      upstreamResponse: () => {
        const err = new Error('aborted');
        (err as Error & { name: string }).name = 'AbortError';
        return Promise.reject(err);
      },
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(504);
    const body = await r.json();
    expect(body.error).toBe('upstream_timeout');

    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_timeout');
    for (const ev of h.events) assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
  });

  it('UPSTREAM UNREACHABLE — fetch throws non-Abort; 502 returned with error_class=upstream_unreachable', async () => {
    h = await boot({
      upstreamResponse: () => Promise.reject(new Error('ECONNREFUSED 192.0.2.0:443')),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe('upstream_unreachable');
    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('upstream_unreachable');
  });

  it('NO ACTIVE CREDENTIAL — vault empty → 500 BEFORE any upstream call', async () => {
    h = await boot({ skipVaultSeed: true });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe('no_active_credential');
    expect(h.mock.callCount).toBe(0); // upstream never touched

    const errEv = h.events.find((e) => e.kind === 'llm_gateway_error');
    expect((errEv!.payload as Record<string, unknown>).error_class).toBe('no_active_credential');
  });

  it('UPSTREAM HEADERS — x-api-key carries the seeded synthetic key, anthropic-version pass-through', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(JSON.stringify(SUCCESS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2024-10-22',
      },
      body: REQ_BODY,
    });
    expect(h.mock.lastRequestHeaders?.get('x-api-key')).toBe(SYNTHETIC_KEY);
    expect(h.mock.lastRequestHeaders?.get('anthropic-version')).toBe('2024-10-22');
    expect(h.mock.lastRequestHeaders?.get('content-type')).toBe('application/json');
    // Confirm no other headers leak from the request through to upstream.
    // (Whitelist enforcement is implicit in the helper's header object.)
    expect(h.mock.lastRequestUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  it('UPSTREAM HEADERS — when son omits anthropic-version, the helper falls back to its bundled default', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(JSON.stringify(SUCCESS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    expect(h.mock.lastRequestHeaders?.get('anthropic-version')).toBe('2023-06-01');
  });

  it('REQUEST BODY — son\'s JSON body reaches the upstream verbatim', async () => {
    h = await boot({
      upstreamResponse: () =>
        new Response(JSON.stringify(SUCCESS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const sonBody = {
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello operator' }],
      temperature: 0.7,
    };
    await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sonBody),
    });
    expect(h.mock.lastRequestBody).toBeDefined();
    const upstreamBody = JSON.parse(h.mock.lastRequestBody!);
    expect(upstreamBody).toEqual(sonBody);
  });

  it('KEY-BYTES GREP — no captured surface contains the synthetic key (in-suite F6 analog)', async () => {
    // Run a successful forward, then capture EVERYTHING:
    //   - all audit events
    //   - response body
    //   - request body sent upstream (must contain NO key by design)
    h = await boot({
      upstreamResponse: () =>
        new Response(JSON.stringify(SUCCESS_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const r = await fetch(`${h.base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: REQ_BODY,
    });
    const responseBody = await r.text();

    // The upstream request body (son's body) must not contain the key.
    assertKeyBytesAbsent(h.mock.lastRequestBody ?? '', 'upstream request body');
    // The response body returned to the son must not contain the key.
    assertKeyBytesAbsent(responseBody, 'son response body');
    // No audit event payload contains the key.
    for (const ev of h.events) {
      assertKeyBytesAbsent(JSON.stringify(ev), `event ${ev.kind}`);
    }
    // The upstream x-api-key header IS the key (by design — that's the whole point).
    // Confirm it's exactly there, nowhere else.
    expect(h.mock.lastRequestHeaders?.get('x-api-key')).toBe(SYNTHETIC_KEY);
  });
});
