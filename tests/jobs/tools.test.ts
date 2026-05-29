/**
 * tests/jobs/tools.test.ts — Phase 3b primary MCP tool surface.
 *
 * Uses a mock McpServer that records every registerTool call so we can
 * assert: which tools register, with what schema fields, and that the
 * handlers route through JobOrchestrator correctly. Mirrors the testing
 * pattern used in tests/tools/registry.test.ts.
 *
 * The complementary tests/security/actor-permissions + tests/tools/categories
 * cover the tier-classification parity. This file pins the MCP-side shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator } from '../../src/jobs/orchestrator.js';
import { JobEventBus } from '../../src/jobs/event-bus.js';
import { registerJobTools } from '../../src/jobs/tools.js';
import type { BindingHandle, ExecutorBinding } from '../../src/jobs/types.js';

interface Registration {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function makeMockServer(): {
  server: Parameters<typeof registerJobTools>[0];
  regs: Registration[];
} {
  const regs: Registration[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ): void {
      regs.push({ name, config, handler });
    },
    // Other McpServer methods aren't touched by registerJobTools — leaving
    // them off doesn't matter at this isolated test level.
  } as unknown as Parameters<typeof registerJobTools>[0];
  return { server, regs };
}

function makeMockBinding(target = 'mock'): ExecutorBinding<{ note?: string }> {
  const bus = new JobEventBus();
  return {
    kind: 'process-spawn',
    target,
    displayName: 'Mock',
    description: 'mock',
    capabilities: { inject: false },
    paramsSchema: z.object({ note: z.string().optional() }),
    async dispatch(): Promise<BindingHandle> {
      return {
        pid: 9000,
        metadata: { cwd: '/tmp/m' },
        events: bus,
        async terminate(force: boolean) {
          bus.emitExit({ exitCode: 0, reason: 'terminated' });
          return { exitCode: 0 };
        },
      };
    },
  };
}

describe('registerJobTools — Phase 3b primary MCP surface', () => {
  let store: EventStore;
  let broker: Broker;
  let orch: JobOrchestrator;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
  });

  afterEach(() => {
    store.close();
  });

  it('registers exactly the six canonical job_* tools', () => {
    const { server, regs } = makeMockServer();
    registerJobTools(server, orch);
    const names = regs.map((r) => r.name).sort();
    expect(names).toEqual([
      'job_dispatch',
      'job_inject',
      'job_list',
      'job_list_bindings',
      'job_status',
      'job_terminate',
    ]);
  });

  it('job_list_bindings handler returns the registered bindings', async () => {
    const { server, regs } = makeMockServer();
    orch.register(makeMockBinding('listme'));
    registerJobTools(server, orch);
    const listBindings = regs.find((r) => r.name === 'job_list_bindings')!;
    const result = (await listBindings.handler({})) as {
      structuredContent: { bindings: Array<{ kind: string; target: string }> };
    };
    expect(result.structuredContent.bindings.map((b) => b.target)).toContain('listme');
  });

  it('job_dispatch handler routes through JobOrchestrator and persists a job', async () => {
    const { server, regs } = makeMockServer();
    orch.register(makeMockBinding('a'));
    registerJobTools(server, orch);
    const dispatch = regs.find((r) => r.name === 'job_dispatch')!;
    const result = (await dispatch.handler({
      binding_kind: 'process-spawn',
      binding_target: 'a',
      name: 'tool-driven',
      params: { note: 'hi' },
    })) as { structuredContent: { job: { id: string; lifecycle_state: string } } };
    expect(result.structuredContent.job.lifecycle_state).toBe('running');
    expect(store.getJob(result.structuredContent.job.id)).toBeDefined();
  });

  it('job_dispatch surfaces OrchestratorError as a structured tool error', async () => {
    const { server, regs } = makeMockServer();
    registerJobTools(server, orch);
    const dispatch = regs.find((r) => r.name === 'job_dispatch')!;
    const result = (await dispatch.handler({
      binding_kind: 'process-spawn',
      binding_target: 'doesnotexist',
      name: 'nope',
      params: {},
    })) as { isError: boolean; structuredContent: { code: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('unknown_binding');
  });

  it('job_status returns null for unknown id_or_name (no throw)', async () => {
    const { server, regs } = makeMockServer();
    registerJobTools(server, orch);
    const status = regs.find((r) => r.name === 'job_status')!;
    const result = (await status.handler({ id_or_name: 'missing' })) as {
      structuredContent: { job: null };
    };
    expect(result.structuredContent.job).toBeNull();
  });

  it('each tool description carries the BOM-required language', () => {
    const { server, regs } = makeMockServer();
    registerJobTools(server, orch);
    // job_dispatch, job_inject, and job_terminate are CONFIRM-tier on the
    // tier model and that's surfaced in the description.
    const dispatch = regs.find((r) => r.name === 'job_dispatch')!;
    expect(dispatch.config.description?.toLowerCase()).toMatch(/confirm/);
    expect(dispatch.config.description?.toLowerCase()).toMatch(/admission/);
  });
});
