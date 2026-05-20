/**
 * tests/workers/spawner-protocol.test.ts
 *
 * Schema-level coverage for the spawner protocol contract (ADR-042 §Decision 5).
 * These tests pin the shapes the MCP-spawner adapter and worker MCP server
 * authors rely on — adding a new step kind or breaking the manifest schema
 * has to come through here.
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TOOLS,
  OPTIONAL_TOOLS,
  SESSION_STATES,
  STEP_KINDS,
  FEDERATION_ROLES,
  WorkerInitInputSchema,
  WorkerInitResultSchema,
  WorkerStepInputSchema,
  WorkerStepResultSchema,
  WorkerFinalizeInputSchema,
  WorkerInjectInputSchema,
  WorkerMcpManifestEntrySchema,
  WorkerMcpManifestSchema,
} from '../../src/workers/spawner-protocol.js';

describe('spawner protocol constants', () => {
  it('declares the three required MCP tools per ADR-042', () => {
    expect(REQUIRED_TOOLS).toEqual(['worker_init', 'worker_step', 'worker_finalize']);
  });

  it('declares the four optional capability tools', () => {
    expect(new Set(OPTIONAL_TOOLS)).toEqual(
      new Set(['worker_inject', 'worker_inspect', 'worker_pause', 'worker_resume']),
    );
  });

  it('lists six lifecycle states including terminated + errored', () => {
    expect(SESSION_STATES).toContain('initializing');
    expect(SESSION_STATES).toContain('running');
    expect(SESSION_STATES).toContain('completed');
    expect(SESSION_STATES).toContain('errored');
    expect(SESSION_STATES).toContain('terminated');
  });

  it('lists six step kinds with completed as the terminal kind', () => {
    expect(new Set(STEP_KINDS)).toEqual(
      new Set(['idle', 'progress', 'log', 'metadata', 'error', 'completed']),
    );
  });

  it('declares the three federation roles (Decision 1 cross-link)', () => {
    expect(FEDERATION_ROLES).toEqual(['originator', 'participant', 'convener']);
  });
});

describe('worker_init schemas', () => {
  it('accepts a minimal valid init input', () => {
    const parsed = WorkerInitInputSchema.parse({
      params: { foo: 'bar' },
      context: { worker_id: 'w1', worker_name: 'demo' },
    });
    expect(parsed.context.worker_id).toBe('w1');
  });

  it('rejects context missing worker_id', () => {
    const result = WorkerInitInputSchema.safeParse({
      params: {},
      context: { worker_name: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a federation_role attribution', () => {
    const parsed = WorkerInitInputSchema.parse({
      params: {},
      context: {
        worker_id: 'w1',
        worker_name: 'demo',
        federation_role: 'participant',
        originator_peer: 'peer-kenneth-laptop',
      },
    });
    expect(parsed.context.federation_role).toBe('participant');
    expect(parsed.context.originator_peer).toBe('peer-kenneth-laptop');
  });

  it('rejects an unknown federation_role', () => {
    const result = WorkerInitInputSchema.safeParse({
      params: {},
      context: { worker_id: 'w1', worker_name: 'demo', federation_role: 'admin' },
    });
    expect(result.success).toBe(false);
  });

  it('requires all three capability flags to be explicit (no silent defaults)', () => {
    const ok = WorkerInitResultSchema.parse({
      session_id: 's1',
      capabilities: { inject: false, inspect: false, pause_resume: false },
    });
    expect(ok.capabilities.inject).toBe(false);

    const partial = WorkerInitResultSchema.safeParse({
      session_id: 's1',
      capabilities: { inject: true },
    });
    expect(partial.success).toBe(false);
  });
});

describe('worker_step schemas', () => {
  it('defaults max_wait_ms to 5000', () => {
    const parsed = WorkerStepInputSchema.parse({ session_id: 's1' });
    expect(parsed.max_wait_ms).toBe(5000);
  });

  it('caps max_wait_ms at 60 seconds', () => {
    const result = WorkerStepInputSchema.safeParse({ session_id: 's1', max_wait_ms: 100_000 });
    expect(result.success).toBe(false);
  });

  it('discriminates idle / progress / log / metadata / error / completed', () => {
    expect(WorkerStepResultSchema.parse({ kind: 'idle' }).kind).toBe('idle');
    expect(
      WorkerStepResultSchema.parse({ kind: 'progress', message: 'tick' }).kind,
    ).toBe('progress');
    expect(
      WorkerStepResultSchema.parse({
        kind: 'log',
        stream: 'stdout',
        line: 'hello',
      }).kind,
    ).toBe('log');
    expect(
      WorkerStepResultSchema.parse({ kind: 'metadata', patch: { score: 1 } }).kind,
    ).toBe('metadata');
    expect(
      WorkerStepResultSchema.parse({ kind: 'error', message: 'boom', recoverable: false }).kind,
    ).toBe('error');
    expect(WorkerStepResultSchema.parse({ kind: 'completed' }).kind).toBe('completed');
  });

  it('rejects an unknown step kind', () => {
    const result = WorkerStepResultSchema.safeParse({ kind: 'paused' });
    expect(result.success).toBe(false);
  });

  it('rejects log with an unknown stream', () => {
    const result = WorkerStepResultSchema.safeParse({
      kind: 'log',
      stream: 'stdin',
      line: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('worker_finalize + worker_inject schemas', () => {
  it('accepts every documented finalize reason', () => {
    for (const reason of ['completed', 'terminated', 'crashed', 'idle_timeout'] as const) {
      const parsed = WorkerFinalizeInputSchema.parse({ session_id: 's1', reason });
      expect(parsed.reason).toBe(reason);
    }
  });

  it('defaults force to false on finalize', () => {
    const parsed = WorkerFinalizeInputSchema.parse({ session_id: 's1', reason: 'completed' });
    expect(parsed.force).toBe(false);
  });

  it('requires a non-empty instruction for inject', () => {
    const result = WorkerInjectInputSchema.safeParse({ session_id: 's1', instruction: '' });
    expect(result.success).toBe(false);
  });
});

describe('worker MCP manifest schemas', () => {
  it('accepts a minimal manifest with one entry', () => {
    const parsed = WorkerMcpManifestSchema.parse({
      workers: [
        {
          type: 'python',
          display_name: 'Python runner',
          description: 'Run Python scripts in a sandbox.',
          command: '/usr/bin/python3',
          args: ['-m', 'stavr_python_worker'],
        },
      ],
    });
    expect(parsed.workers[0]!.tier).toBe('confirm');
    expect(parsed.workers[0]!.args).toEqual(['-m', 'stavr_python_worker']);
  });

  it('defaults the workers array to empty when omitted', () => {
    const parsed = WorkerMcpManifestSchema.parse({});
    expect(parsed.workers).toEqual([]);
  });

  it('rejects a type that is not kebab-case', () => {
    const result = WorkerMcpManifestEntrySchema.safeParse({
      type: 'CamelCase',
      display_name: 'x',
      description: 'y',
      command: '/x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest with an unknown tier', () => {
    const result = WorkerMcpManifestEntrySchema.safeParse({
      type: 'p',
      display_name: 'x',
      description: 'y',
      command: '/x',
      tier: 'maybe',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional env + cwd + params_hint fields', () => {
    const parsed = WorkerMcpManifestEntrySchema.parse({
      type: 'ollama-codegen',
      display_name: 'Ollama codegen',
      description: 'Local LLM coder',
      command: 'node',
      args: ['./ollama-worker.js'],
      cwd: '/tmp/ollama',
      env: { OLLAMA_HOST: 'http://localhost:11434' },
      params_hint: { model: 'codellama:7b' },
    });
    expect(parsed.env).toEqual({ OLLAMA_HOST: 'http://localhost:11434' });
    expect(parsed.params_hint).toEqual({ model: 'codellama:7b' });
  });
});
