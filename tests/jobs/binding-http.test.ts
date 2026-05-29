/**
 * tests/jobs/binding-http.test.ts — http binding contract.
 *
 * Uses a fake fetcher injected via the factory so no real network call is
 * made. Covers happy path (2xx), failure path (4xx → crashed), terminate,
 * capability declaration, target naming, JSON body serialization, and
 * streaming response chunks → log events.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHttpBinding } from '../../src/jobs/binding-http.js';
import type { BindingContext, JobExitInfo, JobLogInfo } from '../../src/jobs/types.js';

const ctx: BindingContext = {
  jobId: 'invoke-test',
  jobName: 'http-test',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  });
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe('http binding', () => {
  it('happy path: 200 + JSON body parses, exits completed with result', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ answer: 42 }, { status: 200 }));
    const binding = createHttpBinding({
      target: 'ollama-local',
      displayName: 'Ollama Local',
      description: 'test',
      fetcher,
    });
    const handle = await binding.dispatch(
      { url: 'http://localhost:11434/api/tags', method: 'GET', stream: false },
      ctx,
    );
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(fetcher).toHaveBeenCalled();
    expect(exit.reason).toBe('completed');
    expect(exit.exitCode).toBe(0);
    const result = exit.result as { status: number; body: unknown };
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ answer: 42 });
  });

  it('classifies 4xx as crashed with exit_code equal to status', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 404 }));
    const binding = createHttpBinding({
      target: 'api',
      displayName: 'API',
      description: 'test',
      fetcher,
    });
    const handle = await binding.dispatch(
      { url: 'http://example.test/missing', method: 'GET', stream: false },
      ctx,
    );
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(exit.reason).toBe('crashed');
    expect(exit.exitCode).toBe(404);
  });

  it('classifies 5xx as crashed', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 503 }));
    const binding = createHttpBinding({
      target: 'api',
      displayName: 'API',
      description: 'test',
      fetcher,
    });
    const handle = await binding.dispatch(
      { url: 'http://example.test/down', method: 'GET', stream: false },
      ctx,
    );
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(exit.reason).toBe('crashed');
    expect(exit.exitCode).toBe(503);
  });

  it('thrown fetch error emits job_error + crashed exit', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const binding = createHttpBinding({
      target: 'api',
      displayName: 'API',
      description: 'test',
      fetcher,
    });
    const handle = await binding.dispatch(
      { url: 'http://example.test/x', method: 'GET', stream: false },
      ctx,
    );
    const errs: Array<{ message: string }> = [];
    handle.events.on('error', (info) => errs.push(info));
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(errs[0].message).toContain('ECONNREFUSED');
    expect(exit.reason).toBe('crashed');
  });

  it('serializes object bodies as JSON and sets content-type', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return jsonResponse({ ok: true });
    });
    const binding = createHttpBinding({
      target: 'api',
      displayName: 'API',
      description: 'test',
      fetcher: fetcher as never,
    });
    const handle = await binding.dispatch(
      {
        url: 'http://example.test/echo',
        method: 'POST',
        body: { prompt: 'hi' },
        stream: false,
      },
      ctx,
    );
    await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(captured?.init.method).toBe('POST');
    expect(captured?.init.body).toBe(JSON.stringify({ prompt: 'hi' }));
    expect((captured?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
  });

  it('stream=true emits one job_log per line and a single exit at end', async () => {
    const chunks = ['line one\n', 'line two\n', 'partial-no-newline'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    const binding = createHttpBinding({
      target: 'stream-api',
      displayName: 'Streaming',
      description: 'test',
      fetcher,
    });
    const handle = await binding.dispatch(
      { url: 'http://example.test/stream', method: 'GET', stream: true },
      ctx,
    );
    const logs: JobLogInfo[] = [];
    handle.events.on('log', (info) => logs.push(info));
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(logs.map((l) => l.line)).toEqual(['line one', 'line two', 'partial-no-newline']);
    expect(exit.reason).toBe('completed');
  });

  it('terminate(force=true) aborts an in-flight fetch and emits terminated exit', async () => {
    // Fetcher returns a never-resolving promise UNTIL the signal aborts.
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const binding = createHttpBinding({
      target: 'hanging',
      displayName: 'Hanging',
      description: 'test',
      fetcher: fetcher as never,
    });
    const handle = await binding.dispatch(
      { url: 'http://example.test/slow', method: 'GET', stream: false, timeoutMs: 60_000 },
      ctx,
    );
    const exitPromise = new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    await handle.terminate(true);
    const exit = await exitPromise;
    expect(exit.reason).toBe('terminated');
  });

  it('declares inject = false (no mid-flight injection for HTTP)', () => {
    const binding = createHttpBinding({
      target: 't',
      displayName: 'T',
      description: 'test',
      fetcher: vi.fn() as never,
    });
    expect(binding.capabilities.inject).toBe(false);
  });

  it('honors a custom target name', () => {
    const binding = createHttpBinding({
      target: 'api-openai',
      displayName: 'OpenAI API',
      description: 'test',
      fetcher: vi.fn() as never,
    });
    expect(binding.target).toBe('api-openai');
    expect(binding.kind).toBe('http');
  });
});
