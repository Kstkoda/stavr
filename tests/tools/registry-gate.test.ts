import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  wrapServerForRegistry,
  wrapHandlerWithGate,
  type RuntimeToolGate,
} from '../../src/tools/registry.js';

describe('wrapHandlerWithGate', () => {
  it('delegates to the inner handler when the gate allows', async () => {
    const gate: RuntimeToolGate = { check: async () => ({ allowed: true }) };
    const handler = async (args: unknown) => ({ content: [{ type: 'text', text: 'ran' }], echo: args });
    const wrapped = wrapHandlerWithGate('emit_event', handler, gate) as (
      args: unknown,
    ) => Promise<unknown>;
    const result = (await wrapped({ a: 1 })) as { echo: { a: number } };
    expect(result.echo).toEqual({ a: 1 });
  });

  it('short-circuits with toolError when the gate denies', async () => {
    const gate: RuntimeToolGate = {
      check: async () => ({ allowed: false, reason: 'disabled by operator' }),
    };
    let inner_called = false;
    const handler = async () => {
      inner_called = true;
      return { content: [{ type: 'text', text: 'unreachable' }] };
    };
    const wrapped = wrapHandlerWithGate('worker_spawn', handler, gate) as (
      args: unknown,
    ) => Promise<unknown>;
    const result = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disabled by operator');
    expect(inner_called).toBe(false);
  });

  it('returns toolError when the gate itself throws', async () => {
    const gate: RuntimeToolGate = {
      check: async () => {
        throw new Error('boom');
      },
    };
    const handler = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    const wrapped = wrapHandlerWithGate('emit_event', handler, gate) as (
      args: unknown,
    ) => Promise<unknown>;
    const result = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });

  it('awaits a slow async gate without invoking the handler early', async () => {
    let gateResolved = false;
    const gate: RuntimeToolGate = {
      check: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            gateResolved = true;
            resolve({ allowed: false, reason: 'slow deny' });
          }, 10);
        }),
    };
    let inner_called = false;
    const handler = async () => {
      inner_called = true;
      return { content: [{ type: 'text', text: 'unreachable' }] };
    };
    const wrapped = wrapHandlerWithGate('worker_spawn', handler, gate) as (
      args: unknown,
    ) => Promise<unknown>;
    const result = (await wrapped({})) as { isError: boolean; content: Array<{ text: string }> };
    expect(gateResolved).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('slow deny');
    expect(inner_called).toBe(false);
  });
});

describe('wrapServerForRegistry with gate', () => {
  function makeFakeServer() {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    return {
      handlers,
      registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    };
  }

  it('records registration AND wraps the handler with the gate', async () => {
    const registry = new ToolRegistry();
    const gate: RuntimeToolGate = {
      check: async (toolId) =>
        toolId === 'host_exec'
          ? { allowed: false, reason: 'host_exec is disabled' }
          : { allowed: true },
    };
    const fake = makeFakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapServerForRegistry(fake as any, registry, 'fake', gate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).registerTool('host_exec', { description: 'shell' }, async () => ({
      content: [{ type: 'text', text: 'unreachable' }],
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).registerTool('emit_event', { description: 'publish' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    // Registered in catalog
    expect(registry.size()).toBe(2);
    // host_exec call short-circuits via the gate
    const hostExec = fake.handlers.get('host_exec');
    expect(hostExec).toBeDefined();
    const hostResult = (await hostExec!({})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(hostResult.isError).toBe(true);
    expect(hostResult.content[0].text).toContain('host_exec is disabled');
    // emit_event passes through
    const emit = fake.handlers.get('emit_event');
    const emitResult = (await emit!({})) as { content: Array<{ text: string }> };
    expect(emitResult.content[0].text).toBe('ok');
  });
});
