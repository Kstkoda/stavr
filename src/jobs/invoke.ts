/**
 * `invoke` — the synchronous primitive (Phase 1 of worker-dispatch-bom).
 *
 * Paired with `job` (the async lifecycle record). A short call to an MCP tool
 * or a one-shot CLI exec doesn't deserve a JobRecord — it has no budget, no
 * crash recovery, no audit trail beyond the call itself. `invoke` runs the
 * binding to completion in-process and returns a single InvokeResult.
 *
 * Behaviourally:
 *   - run binding.dispatch(); subscribe to its event channel
 *   - aggregate logs + progress entries into the result
 *   - on the binding's `exit` event, return the result (with exit_code)
 *   - on timeout, terminate(force=true) and return with `timed_out: true`
 *
 * Phase 1 ships invoke with the process-spawn binding. Phases 2 ships the
 * other three; invoke handles all four uniformly because the binding
 * interface is uniform.
 *
 * NOT persisted. The BOM says: "invoke = a synchronous call ... request →
 * response." If a caller wants persistence + budget + lifecycle, they
 * dispatch a job, not an invoke.
 */
import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';
import type { ExecutorBinding, BindingContext } from './types.js';

export interface InvokeOptions {
  /** Tag the invocation in logs / metrics. Free-form. */
  name?: string;
  /** Hard cap on runtime. After this the binding is terminated and
   *  `timed_out: true` is returned. Default 30s. */
  timeoutMs?: number;
  /** Used by the binding's emit channel — passed through so bindings that
   *  publish broker events have a place to send them. Optional — most
   *  invoke callers will pass undefined for ephemeral invocations. */
  broker?: Broker;
  store?: EventStore;
}

export interface InvokeResult {
  ok: boolean;
  exit_code?: number;
  reason: 'completed' | 'crashed' | 'terminated' | 'timed_out';
  /** Stdout lines (process-spawn) or `progress` messages (mcp-call / http). */
  output: string[];
  /** Stderr lines (process-spawn). Empty for other bindings unless they
   *  classify a stream as stderr. */
  stderr: string[];
  /** Last error info, if any. */
  error?: { message: string; recoverable: boolean };
  /** Wall-clock duration. */
  duration_ms: number;
  timed_out: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function invoke<TParams>(
  binding: ExecutorBinding<TParams>,
  params: TParams,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = opts.name ?? `invoke-${binding.kind}-${binding.target}`;
  const t0 = Date.now();

  // Validate params via the binding's own schema. Bindings expect validated
  // input on dispatch; invoke is the entry point so we validate here.
  const parsed = binding.paramsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'crashed',
      output: [],
      stderr: [],
      error: { message: `invalid params: ${parsed.error.message}`, recoverable: false },
      duration_ms: Date.now() - t0,
      timed_out: false,
    };
  }

  // The binding context normally carries a broker + store. For invoke we
  // build a no-op context unless the caller passed real ones.
  const ctx: BindingContext = {
    jobId: `invoke-${Date.now()}`,
    jobName: name,
    broker: opts.broker as Broker,
    store: opts.store as EventStore,
    emit: async () => {
      /* no-op when broker is undefined; the binding decides whether to call it */
    },
  };

  const output: string[] = [];
  const stderr: string[] = [];
  let lastError: InvokeResult['error'];

  let handle;
  try {
    handle = await binding.dispatch(parsed.data as TParams, ctx);
  } catch (err) {
    return {
      ok: false,
      reason: 'crashed',
      output,
      stderr,
      error: { message: (err as Error).message, recoverable: false },
      duration_ms: Date.now() - t0,
      timed_out: false,
    };
  }

  let timedOut = false;

  const exitPromise = new Promise<{ exitCode?: number; reason: 'completed' | 'crashed' | 'terminated' }>(
    (resolve) => {
      handle.events.on('progress', (info) => {
        output.push(info.message);
      });
      handle.events.on('log', (info) => {
        const line = info.line ?? (info.event !== undefined ? JSON.stringify(info.event) : '');
        if (info.stream === 'stderr') stderr.push(line);
        else output.push(line);
      });
      handle.events.on('error', (info) => {
        lastError = { message: info.message, recoverable: info.recoverable };
      });
      handle.events.on('exit', (info) => {
        resolve({ exitCode: info.exitCode, reason: info.reason });
      });
    },
  );

  const timeoutPromise = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    t.unref?.();
  });

  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === null) {
    timedOut = true;
    try {
      await handle.terminate(true);
    } catch {
      /* binding may have died on its own */
    }
    return {
      ok: false,
      reason: 'timed_out',
      output,
      stderr,
      error: lastError,
      duration_ms: Date.now() - t0,
      timed_out: true,
    };
  }

  const exit = race;
  return {
    ok: exit.reason === 'completed' && (exit.exitCode === undefined || exit.exitCode === 0),
    exit_code: exit.exitCode,
    reason: exit.reason,
    output,
    stderr,
    error: lastError,
    duration_ms: Date.now() - t0,
    timed_out: timedOut,
  };
}
