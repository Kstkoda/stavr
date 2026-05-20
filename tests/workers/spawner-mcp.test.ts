/**
 * tests/workers/spawner-mcp.test.ts
 *
 * Integration coverage for the MCP-server-as-worker adapter. We inject a
 * mock MCP `Client` via the spawner's `clientFactory` option so the tests
 * don't actually spawn a child process — verifying the protocol round-trip
 * (worker_init → poll worker_step → worker_finalize) and the bus emissions
 * the orchestrator depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpSpawner } from '../../src/workers/spawner-mcp.js';
import type { WorkerMcpManifestEntry } from '../../src/workers/spawner-protocol.js';
import type {
  WorkerInstance,
  WorkerProgressInfo,
  WorkerExitInfo,
  WorkerErrorInfo,
  WorkerMetadataInfo,
  WorkerLogInfo,
} from '../../src/workers/types.js';

interface ScriptedStep {
  result: unknown;
}

interface MockClientOpts {
  initResult?: unknown;
  steps?: ScriptedStep[];
  initThrows?: Error;
  stepThrows?: Error;
  finalizeThrows?: Error;
  /** Mark whether the mock client received a finalize call. */
  onFinalize?: (args: unknown) => void;
}

function makeMockClient(opts: MockClientOpts): { client: Client; calls: string[] } {
  const calls: string[] = [];
  let stepIndex = 0;
  const steps = opts.steps ?? [];
  const client = {
    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      calls.push(req.name);
      if (req.name === 'worker_init') {
        if (opts.initThrows) throw opts.initThrows;
        return wrap(opts.initResult ?? defaultInitResult());
      }
      if (req.name === 'worker_step') {
        if (opts.stepThrows) throw opts.stepThrows;
        const next = steps[stepIndex++];
        if (!next) {
          // No more scripted steps — return idle indefinitely. The test
          // harness aborts via terminate() so we don't loop forever.
          return wrap({ kind: 'idle' });
        }
        return wrap(next.result);
      }
      if (req.name === 'worker_finalize') {
        opts.onFinalize?.(req.arguments);
        if (opts.finalizeThrows) throw opts.finalizeThrows;
        return wrap({ ok: true });
      }
      throw new Error(`unexpected tool: ${req.name}`);
    },
    async close() {
      calls.push('close');
    },
  } as unknown as Client;
  return { client, calls };
}

function wrap(payload: unknown): { structuredContent: unknown; content: never[] } {
  return { structuredContent: payload, content: [] };
}

function defaultInitResult(): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    capabilities: { inject: false, inspect: false, pause_resume: false },
  };
}

function makeEntry(overrides: Partial<WorkerMcpManifestEntry> = {}): WorkerMcpManifestEntry {
  return {
    type: 'test-mcp',
    display_name: 'Test MCP Worker',
    description: 'Unit test backing.',
    tier: 'auto',
    command: 'node',
    args: [],
    ...overrides,
  };
}

function fakeContext() {
  return {
    workerId: 'w-1',
    workerName: 'demo',
    broker: {} as never,
    store: {} as never,
    emit: async () => undefined,
  };
}

async function collectEvents(
  instance: WorkerInstance,
  until: (kind: string, payload: unknown) => boolean,
  timeoutMs = 2000,
): Promise<Array<{ kind: string; payload: unknown }>> {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('event collection timed out')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const record = (kind: string) => (payload: unknown) => {
      events.push({ kind, payload });
      if (until(kind, payload)) {
        clearTimeout(timer);
        resolve();
      }
    };
    instance.events.on('progress', record('progress') as (info: WorkerProgressInfo) => void);
    instance.events.on('log', record('log') as (info: WorkerLogInfo) => void);
    instance.events.on('metadata', record('metadata') as (info: WorkerMetadataInfo) => void);
    instance.events.on('error', record('error') as (info: WorkerErrorInfo) => void);
    instance.events.on('exit', record('exit') as (info: WorkerExitInfo) => void);
  });
  await done;
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createMcpSpawner', () => {
  it('connects the client, calls worker_init, and exposes the WorkerSpawner shape', async () => {
    const { client, calls } = makeMockClient({});
    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });

    expect(spawner.type).toBe('test-mcp');
    expect(spawner.displayName).toBe('Test MCP Worker');
    expect(spawner.tier).toBe('auto');

    const instance = await spawner.spawn({ params: { x: 1 } }, fakeContext());
    expect(calls[0]).toBe('worker_init');
    expect((instance.metadata as { spawner_kind: string }).spawner_kind).toBe('mcp');
    expect((instance.metadata as { mcp_session_id: string }).mcp_session_id).toBe('sess-1');

    await instance.terminate(false);
  });

  it('translates worker_step progress / log / metadata into bus events', async () => {
    const { client } = makeMockClient({
      steps: [
        { result: { kind: 'progress', message: 'tick one' } },
        { result: { kind: 'log', stream: 'stdout', line: 'L1' } },
        { result: { kind: 'metadata', patch: { score: 7 } } },
        { result: { kind: 'completed' } },
      ],
    });

    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });
    const instance = await spawner.spawn({ params: {} }, fakeContext());

    const events = await collectEvents(instance, (kind) => kind === 'exit');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('progress');
    expect(kinds).toContain('log');
    expect(kinds).toContain('metadata');
    expect(kinds[kinds.length - 1]).toBe('exit');
    const exit = events.find((e) => e.kind === 'exit')!.payload as WorkerExitInfo;
    expect(exit.reason).toBe('completed');
  });

  it('surfaces error steps and continues polling until completed', async () => {
    const { client } = makeMockClient({
      steps: [
        { result: { kind: 'error', message: 'transient', recoverable: true } },
        { result: { kind: 'progress', message: 'recovered' } },
        { result: { kind: 'completed', exit_code: 0 } },
      ],
    });
    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });
    const instance = await spawner.spawn({ params: {} }, fakeContext());
    const events = await collectEvents(instance, (kind) => kind === 'exit');
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect(events.some((e) => e.kind === 'progress')).toBe(true);
    const exit = events.find((e) => e.kind === 'exit')!.payload as WorkerExitInfo;
    expect(exit.reason).toBe('completed');
    expect(exit.exitCode).toBe(0);
  });

  it('emits a synthetic exit if worker_step throws', async () => {
    let stepCallCount = 0;
    const client = {
      async callTool(req: { name: string }) {
        if (req.name === 'worker_init') return wrap(defaultInitResult());
        if (req.name === 'worker_step') {
          stepCallCount++;
          throw new Error('mcp transport closed');
        }
        if (req.name === 'worker_finalize') return wrap({ ok: true });
        throw new Error('unexpected: ' + req.name);
      },
      async close() {},
    } as unknown as Client;
    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });
    const instance = await spawner.spawn({ params: {} }, fakeContext());
    const events = await collectEvents(instance, (kind) => kind === 'exit');
    expect(stepCallCount).toBeGreaterThan(0);
    const errorEvent = events.find((e) => e.kind === 'error')!.payload as WorkerErrorInfo;
    expect(errorEvent.message).toContain('mcp transport closed');
    const exit = events.find((e) => e.kind === 'exit')!.payload as WorkerExitInfo;
    expect(exit.reason).toBe('crashed');
  });

  it('calls worker_finalize on terminate and emits exit reason=terminated', async () => {
    let finalizeArgs: unknown;
    const { client } = makeMockClient({
      onFinalize: (args) => {
        finalizeArgs = args;
      },
    });
    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });
    const instance = await spawner.spawn({ params: {} }, fakeContext());

    // Wait one event-loop tick so the poller is running.
    await new Promise((r) => setImmediate(r));

    await instance.terminate(true);
    expect(finalizeArgs).toMatchObject({
      session_id: 'sess-1',
      reason: 'terminated',
      force: true,
    });
  });

  it('propagates worker_init failures and tears down the client', async () => {
    let closed = false;
    const client = {
      async callTool() {
        throw new Error('init exploded');
      },
      async close() {
        closed = true;
      },
    } as unknown as Client;
    const spawner = createMcpSpawner(makeEntry(), {
      clientFactory: async () => client,
      stepMaxWaitMs: 10,
    });
    await expect(spawner.spawn({ params: {} }, fakeContext())).rejects.toThrow(/init exploded/);
    expect(closed).toBe(true);
  });

  it('rejects a manifest entry with a malformed type at create time', () => {
    expect(() =>
      createMcpSpawner(
        makeEntry({ type: 'Bad-Type' }),
        { clientFactory: async () => makeMockClient({}).client },
      ),
    ).toThrow();
  });
});
