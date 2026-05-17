import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnStewardAgent } from '../../../src/steward/spawner.js';

/** A fake ChildProcess that lets tests inject 'message' / 'exit' events. */
function makeFakeChild(): ChildProcess & {
  emitMessage: (m: unknown) => void;
  emitExit: () => void;
} {
  const ee = new EventEmitter();
  const sentMessages: unknown[] = [];
  const child = ee as unknown as ChildProcess & {
    emitMessage: (m: unknown) => void;
    emitExit: () => void;
    sent: unknown[];
  };
  Object.assign(child, {
    pid: 9999,
    connected: true,
    stdout: null,
    stderr: null,
    send: (msg: unknown) => { sentMessages.push(msg); return true; },
    kill: () => true,
    sent: sentMessages,
    emitMessage: (m: unknown) => ee.emit('message', m),
    emitExit: () => ee.emit('exit'),
  });
  return child;
}

describe('v0.5 P3 — spawner', () => {
  it('publishes ready event → status flips to up; pid exposed', async () => {
    const fake = makeFakeChild();
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
    });
    expect(handle.status()).toBe('starting');
    expect(handle.pid).toBe(9999);
    fake.emitMessage({ type: 'ready' });
    expect(handle.status()).toBe('up');
    expect(handle.lastHeartbeatAt()).not.toBeNull();
    await handle.shutdown();
  });

  it('child exit flips status to down', async () => {
    const fake = makeFakeChild();
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
    });
    fake.emitExit();
    expect(handle.status()).toBe('down');
    await handle.shutdown();
  });

  it('requestPlan resolves when the agent emits an event with matching request_id', async () => {
    const fake = makeFakeChild();
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
    });
    fake.emitMessage({ type: 'ready' });
    const promise = handle.requestPlan({
      ctx: { goal: 'g', profile_mode: 'balanced' },
      tools: [],
    });
    // Inspect the envelope the spawner sent to extract the request_id.
    const sent = (fake as unknown as { sent: Array<{ type?: string; payload?: { request_id?: string } }> }).sent;
    const reqEnv = sent.find((m) => m.type === 'event');
    expect(reqEnv).toBeDefined();
    const reqId = reqEnv!.payload!.request_id!;
    // Simulate the agent replying.
    fake.emitMessage({
      type: 'emit_event',
      kind: 'bom_proposed',
      payload: { request_id: reqId, ok: true, result: { goal: 'g' } },
    });
    const payload = (await promise) as { request_id: string; ok: boolean };
    expect(payload.request_id).toBe(reqId);
    expect(payload.ok).toBe(true);
    await handle.shutdown();
  });

  it('requestPlan rejects with link-closed error when send returns false', async () => {
    const fake = makeFakeChild();
    Object.assign(fake, {
      connected: false,
      send: () => false,
    });
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
    });
    await expect(
      handle.requestPlan({ ctx: { goal: 'g', profile_mode: 'balanced' }, tools: [] }),
    ).rejects.toThrow(/IPC link closed/);
    await handle.shutdown();
  });

  it('onEvent fires for every emit_event from the agent', async () => {
    const fake = makeFakeChild();
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
    });
    const seen: Array<{ kind: string; payload: unknown }> = [];
    handle.onEvent((kind, payload) => seen.push({ kind, payload }));
    fake.emitMessage({ type: 'emit_event', kind: 'foo', payload: { a: 1 } });
    fake.emitMessage({ type: 'emit_event', kind: 'bar', payload: { b: 2 } });
    expect(seen).toEqual([
      { kind: 'foo', payload: { a: 1 } },
      { kind: 'bar', payload: { b: 2 } },
    ]);
    await handle.shutdown();
  });

  it('marks unhealthy after heartbeat stale beyond missedPongThreshold * interval', async () => {
    vi.useFakeTimers();
    const fake = makeFakeChild();
    const handle = spawnStewardAgent({
      scriptPath: 'fake-script.js',
      forker: () => fake as unknown as ChildProcess,
      heartbeatIntervalMs: 100,
      missedPongThreshold: 2,
    });
    fake.emitMessage({ type: 'ready' });
    expect(handle.status()).toBe('up');
    // Advance well past 2 * 100ms = 200ms — heartbeat timer fires, no pong.
    vi.advanceTimersByTime(600);
    expect(handle.status()).toBe('unhealthy');
    // Restore real timers BEFORE awaiting shutdown — link.shutdown() uses a
    // 2s setTimeout that won't resolve under fake timers and would hang.
    vi.useRealTimers();
    await handle.shutdown();
  });
});
