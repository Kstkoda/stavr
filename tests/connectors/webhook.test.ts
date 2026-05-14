// tests/connectors/webhook.test.ts
//
// Unit tests for WebhookConnector — fully offline using a fake fetch.

import { describe, it, expect } from 'vitest';
import { WebhookConnector } from '../../src/connectors/webhook.js';
import type { ExecContext } from '../../src/connectors/index.js';

function ctx(): ExecContext {
  return { workerId: 'test-worker', profileMode: 'balanced' };
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

describe('WebhookConnector', () => {
  it('testConnection() against an endpoint returning 405 reports ok', async () => {
    const w = new WebhookConnector({
      config: { url: 'https://httpbin.example/get' },
      fetchImpl: fakeFetch(async () => new Response(null, { status: 405 })),
    });
    const status = await w.testConnection();
    expect(status.kind).toBe('ok');
    expect(status.detail).toMatch(/405/);
  });

  it('POST with bearer token sets the auth header and echoes body', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    const w = new WebhookConnector({
      config: {
        url: 'https://httpbin.example/post',
        method: 'POST',
        auth_method: 'bearer',
        auth_value: 's3cret',
      },
      fetchImpl: fakeFetch(async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ echoed: 'yes' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const result = await w.exec('webhook_fire', { body: { test: 'hello' } }, ctx());
    expect(result.ok).toBe(true);
    expect(capturedHeaders['authorization']).toBe('Bearer s3cret');
    expect(capturedHeaders['content-type']).toBe('application/json');
    expect(capturedBody).toBe(JSON.stringify({ test: 'hello' }));
    expect((result.data as { status: number }).status).toBe(200);
  });

  it('enforces timeout via AbortController', async () => {
    const w = new WebhookConnector({
      config: { url: 'https://slow.example/delay', timeout_ms: 50 },
      fetchImpl: ((async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as typeof fetch),
    });
    const result = await w.exec('webhook_fire', { body: {} }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });

  it('returns an error on unknown capability', async () => {
    const w = new WebhookConnector({ config: { url: 'https://x.example' } });
    const r = await w.exec('not_real', {}, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown capability/);
  });
});
