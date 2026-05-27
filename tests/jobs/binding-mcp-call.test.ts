/**
 * tests/jobs/binding-mcp-call.test.ts — mcp-call binding contract.
 *
 * Uses a fake MCP Client (just the surface area we touch: callTool + close)
 * to exercise the binding without spinning up a real MCP server child. The
 * stdio + StdioClientTransport path is exercised by the existing
 * spawner-mcp.test.ts coverage; this file focuses on the new binding shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMcpCallBinding } from '../../src/jobs/binding-mcp-call.js';
import type { BindingContext, JobExitInfo } from '../../src/jobs/types.js';

const ctx: BindingContext = {
  jobId: 'invoke-test',
  jobName: 'mcp-test',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

type FakeClient = {
  callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>;
  close: () => Promise<void>;
};

function makeFakeClient(impl?: Partial<FakeClient>): FakeClient {
  return {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'default' }] })),
    close: vi.fn(async () => {}),
    ...impl,
  };
}

describe('mcp-call binding', () => {
  it('happy path: calls the configured tool and emits progress + completed exit with result', async () => {
    const client = makeFakeClient({
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'tool returned ok' }],
      })),
    });
    const binding = createMcpCallBinding({
      target: 'fake-git',
      displayName: 'Fake Git MCP',
      description: 'test',
      tool_name: 'git_status',
      clientFactory: async () => client as never,
    });

    const handle = await binding.dispatch({ arguments: { cwd: '/tmp' } }, ctx);

    const exit = await new Promise<JobExitInfo>((resolve) => {
      handle.events.on('exit', resolve);
    });

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'git_status',
      arguments: { cwd: '/tmp' },
    });
    expect(exit.reason).toBe('completed');
    expect(exit.exitCode).toBe(0);
    expect(exit.result).toMatchObject({ content: [{ type: 'text', text: 'tool returned ok' }] });
    // safeClose runs in the .finally() microtask after exit fires; flush.
    await new Promise((r) => setImmediate(r));
    expect(client.close).toHaveBeenCalled();
  });

  it('classifies isError=true tool result as crashed with exit_code 1', async () => {
    const client = makeFakeClient({
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'tool said no' }],
        isError: true,
      })),
    });
    const binding = createMcpCallBinding({
      target: 'fake-broken',
      displayName: 'Broken',
      description: 'test',
      tool_name: 'failing_tool',
      clientFactory: async () => client as never,
    });
    const handle = await binding.dispatch({ arguments: {} }, ctx);
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(exit.reason).toBe('crashed');
    expect(exit.exitCode).toBe(1);
  });

  it('thrown error from callTool surfaces as job_error + crashed exit', async () => {
    const client = makeFakeClient({
      callTool: vi.fn(async () => {
        throw new Error('transport hosed');
      }),
    });
    const binding = createMcpCallBinding({
      target: 'fake-throws',
      displayName: 'Throws',
      description: 'test',
      tool_name: 'whatever',
      clientFactory: async () => client as never,
    });
    const handle = await binding.dispatch({ arguments: {} }, ctx);
    const errorEvents: Array<{ message: string }> = [];
    handle.events.on('error', (info) => errorEvents.push(info));
    const exit = await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].message).toContain('transport hosed');
    expect(exit.reason).toBe('crashed');
  });

  it('terminate(force=true) aborts the in-flight call and emits a terminated exit', async () => {
    let aborted = false;
    const client = makeFakeClient({
      callTool: vi.fn(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const t = setTimeout(() => resolve({ content: [] }), 10_000);
            t.unref?.();
            // The binding aborts via withTimeout's signal listener which
            // rejects; we simulate by hanging until the operator-side
            // terminate races us out.
            const _ = reject;
            aborted = false; // keep linter quiet about unused
          }),
      ),
    });
    const binding = createMcpCallBinding({
      target: 'slow',
      displayName: 'Slow',
      description: 'test',
      tool_name: 't',
      clientFactory: async () => client as never,
      callTimeoutMs: 60_000,
    });
    const handle = await binding.dispatch({ arguments: {} }, ctx);
    const exitPromise = new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    await handle.terminate(true);
    const exit = await exitPromise;
    expect(exit.reason).toBe('terminated');
    void aborted;
  });

  it('declares inject = false when no inject_tool_name is configured', () => {
    const client = makeFakeClient();
    const binding = createMcpCallBinding({
      target: 'no-inject',
      displayName: 'No Inject',
      description: 'test',
      tool_name: 't',
      clientFactory: async () => client as never,
    });
    expect(binding.capabilities.inject).toBe(false);
  });

  it('declares inject = true and routes inject() to the inject_tool_name', async () => {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const client = makeFakeClient({
      callTool: vi.fn(async (args) => {
        calls.push(args);
        // First call (the tool_name) — return a hanging promise so we can
        // exercise inject() before the call completes. We resolve below.
        if (args.name === 'long_running') {
          return new Promise<unknown>((r) => {
            setTimeout(() => r({ content: [] }), 10_000).unref?.();
          });
        }
        return { content: [] };
      }),
    });
    const binding = createMcpCallBinding({
      target: 'inject-supported',
      displayName: 'Inject',
      description: 'test',
      tool_name: 'long_running',
      inject_tool_name: 'worker_inject',
      clientFactory: async () => client as never,
      callTimeoutMs: 60_000,
    });
    expect(binding.capabilities.inject).toBe(true);
    const handle = await binding.dispatch({ arguments: {} }, ctx);
    expect(handle.inject).toBeDefined();
    await handle.inject!({ id: 'm1', body: { instruction: 'hi' } });

    expect(calls.find((c) => c.name === 'worker_inject')).toMatchObject({
      name: 'worker_inject',
      arguments: { message_id: 'm1', body: { instruction: 'hi' } },
    });
    // Tear down so the test doesn't dangle.
    await handle.terminate(true);
  });

  it('honors a custom target name and surfaces it in metadata', async () => {
    const client = makeFakeClient();
    const binding = createMcpCallBinding({
      target: 'github-mcp',
      displayName: 'GitHub MCP',
      description: 'test',
      tool_name: 'list_repos',
      clientFactory: async () => client as never,
    });
    expect(binding.target).toBe('github-mcp');
    expect(binding.kind).toBe('mcp-call');
    const handle = await binding.dispatch({ arguments: {} }, ctx);
    expect(handle.metadata.mcp_tool).toBe('list_repos');
  });

  it('factory rejects when neither mcp nor clientFactory is provided', () => {
    expect(() =>
      createMcpCallBinding({
        target: 'bad',
        displayName: 'Bad',
        description: 'test',
        tool_name: 't',
      }),
    ).toThrow(/exactly one of/);
  });

  it('factory rejects when both mcp and clientFactory are provided', () => {
    expect(() =>
      createMcpCallBinding({
        target: 'bad',
        displayName: 'Bad',
        description: 'test',
        tool_name: 't',
        mcp: { command: 'echo' },
        clientFactory: async () => ({}) as never,
      }),
    ).toThrow(/only one of/);
  });
});
