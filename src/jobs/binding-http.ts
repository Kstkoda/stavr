/**
 * http binding — Phase 2 of worker-dispatch-bom.md.
 *
 * Fetches a URL and returns the body as the job's terminal result. Local
 * Ollama, remote inference endpoints, REST APIs — any unary HTTP call.
 *
 * Capability declaration:
 *   inject = false. HTTP requests are request → response; there is no
 *   mid-flight injection channel. (A streaming endpoint that wants
 *   mid-flight steering should layer on top via a different binding kind,
 *   not by extending the http binding's contract.)
 *
 * Lifecycle:
 *   dispatch → fetch under AbortController → on response, emit progress with
 *   status + body, emit exit (reason='completed' for 2xx/3xx, 'crashed' for
 *   4xx/5xx). exit_code carries the status code so the orchestrator's
 *   "non-zero exit ⇒ completed-error" derivation keeps working.
 *
 * Streaming bodies:
 *   For text/event-stream the binding emits one `log` event per chunk +
 *   one `exit` at end. Non-streaming bodies are buffered and emitted as a
 *   single progress payload.
 */
import { z } from 'zod';
import { JobEventBus } from './event-bus.js';
import type {
  BindingCapabilities,
  BindingContext,
  BindingHandle,
  ExecutorBinding,
} from './types.js';

export const HttpCallParams = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  /** Body — string or object (will be JSON-serialized with content-type
   *  application/json if no content-type is set). */
  body: z.union([z.string(), z.record(z.unknown()), z.null()]).optional(),
  /** Per-call timeout. Default 30s. */
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /** Treat the response body as a stream and emit per-chunk log events
   *  instead of buffering. Default false. */
  stream: z.boolean().optional().default(false),
  /** Parse response as JSON before emitting. Auto-true when Content-Type
   *  starts with application/json AND stream=false. */
  parse_json: z.boolean().optional(),
});

export type HttpCallParamsT = z.infer<typeof HttpCallParams>;

type Fetcher = typeof fetch;

export interface HttpBindingOptions {
  /** Named target inside the http kind (e.g. 'ollama-local', 'api-openai'). */
  target: string;
  displayName: string;
  description: string;
  /** Override the global fetch — used by tests. */
  fetcher?: Fetcher;
}

const CAPABILITIES: BindingCapabilities = { inject: false };
const DEFAULT_TIMEOUT_MS = 30_000;

export function createHttpBinding(opts: HttpBindingOptions): ExecutorBinding<HttpCallParamsT> {
  const fetchFn: Fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);

  return {
    kind: 'http',
    target: opts.target,
    displayName: opts.displayName,
    description: opts.description,
    capabilities: CAPABILITIES,
    paramsSchema: HttpCallParams,

    async dispatch(params, _ctx: BindingContext): Promise<BindingHandle> {
      const bus = new JobEventBus();
      const controller = new AbortController();
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let exited = false;
      let terminated = false;

      const timer = setTimeout(() => {
        controller.abort(new Error('http-binding timeout'));
      }, timeoutMs);
      timer.unref?.();

      const fetchPromise = doFetch(fetchFn, params, controller.signal, bus)
        .then(async (resp) => {
          clearTimeout(timer);
          if (exited) return;
          const status = resp.status;
          const ok = resp.ok;
          let bodyValue: unknown;
          if (params.stream) {
            // Streaming path — emit one log per chunk; bodyValue stays
            // undefined (operator sees the log stream).
            await streamResponseAsLogs(resp, bus);
          } else {
            const text = await resp.text();
            const wantJson =
              params.parse_json ?? (resp.headers.get('content-type') ?? '').startsWith('application/json');
            if (wantJson && text.length > 0) {
              try {
                bodyValue = JSON.parse(text);
              } catch {
                bodyValue = text;
              }
            } else {
              bodyValue = text;
            }
            bus.emitProgress({
              message: `http:${opts.target} ${params.method ?? 'GET'} ${status}`,
              payload: bodyValue,
            });
          }
          exited = true;
          bus.emitExit({
            reason: ok ? 'completed' : 'crashed',
            // Map HTTP status into exit_code so non-2xx → completed-error.
            exitCode: ok ? 0 : status,
            result: { status, body: bodyValue, headers: headerObject(resp.headers) },
          });
        })
        .catch((err) => {
          clearTimeout(timer);
          if (exited) return;
          if (terminated) {
            exited = true;
            bus.emitExit({ reason: 'terminated' });
            return;
          }
          bus.emitError({ message: (err as Error).message, recoverable: false });
          exited = true;
          bus.emitExit({ reason: 'crashed' });
        });

      return {
        pid: undefined,
        metadata: {
          url: params.url,
          method: params.method ?? 'GET',
          stream: params.stream ?? false,
        },
        events: bus,
        async terminate(_force: boolean) {
          if (terminated) return {};
          terminated = true;
          controller.abort(new Error('terminated'));
          await fetchPromise.catch(() => {
            /* already swallowed */
          });
          // If the fetch path didn't emit exit (e.g. it had already
          // resolved with a response), synthesize one.
          if (!exited) {
            exited = true;
            bus.emitExit({ reason: 'terminated' });
          }
          return {};
        },
      };
    },
  };
}

async function doFetch(
  fetcher: Fetcher,
  params: HttpCallParamsT,
  signal: AbortSignal,
  bus: JobEventBus,
): Promise<Response> {
  bus.emitActivity({ detail: `${params.method ?? 'GET'} ${params.url}` });
  let body: string | undefined;
  const headers: Record<string, string> = { ...(params.headers ?? {}) };
  if (params.body !== undefined && params.body !== null) {
    if (typeof params.body === 'string') {
      body = params.body;
    } else {
      body = JSON.stringify(params.body);
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }
    }
  }
  const init: RequestInit = {
    method: params.method ?? 'GET',
    headers,
    signal,
  };
  if (body !== undefined) init.body = body;
  return fetcher(params.url, init);
}

async function streamResponseAsLogs(resp: Response, bus: JobEventBus): Promise<void> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    // Emit complete lines; keep the trailing partial in the buffer.
    let idx;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      bus.emitLog({ stream: 'stdout', line, format: 'raw' });
    }
  }
  // Flush any trailing content as a final partial-line log entry.
  if (buffered.length > 0) {
    bus.emitLog({ stream: 'stdout', line: buffered, format: 'raw' });
  }
}

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
