/**
 * tests/jobs/binding-cc-session-attach.test.ts — cc-session-attach binding.
 *
 * Uses an in-test FakeAdapter that satisfies the CcSessionAdapter interface
 * without any real CC session. The binding's contract under test:
 *   - connect failures bubble as dispatch errors (caught by orchestrator and
 *     marked crashed)
 *   - session events fan into the binding's event channel (log/progress/
 *     metadata)
 *   - 'closed' adapter event maps to a binding exit with the right reason
 *   - inject() sends through the adapter; rejects when detached
 *   - terminate detaches WITHOUT killing the session and emits terminated
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCcSessionAttachBinding,
  type AttachedSession,
  type CcSessionAdapter,
  type CcSessionEvent,
} from '../../src/jobs/binding-cc-session-attach.js';
import type { BindingContext, JobExitInfo, JobLogInfo } from '../../src/jobs/types.js';

const ctx: BindingContext = {
  jobId: 'invoke-test',
  jobName: 'cc-attach-test',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

class FakeAttachedSession implements AttachedSession {
  id: string;
  detached = false;
  sends: Array<{ id: string; body: unknown }> = [];
  metadata?: Record<string, unknown>;
  private listeners: Array<(ev: CcSessionEvent) => void> = [];

  constructor(id: string, metadata?: Record<string, unknown>) {
    this.id = id;
    this.metadata = metadata;
  }

  send = vi.fn(async (message: { id: string; body: unknown }) => {
    if (this.detached) throw new Error('detached');
    this.sends.push(message);
  });

  onEvent(cb: (ev: CcSessionEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((c) => c !== cb);
    };
  }

  emit(ev: CcSessionEvent): void {
    for (const l of this.listeners) l(ev);
  }

  detach = vi.fn(async () => {
    this.detached = true;
  });
}

function makeAdapter(session: FakeAttachedSession, opts: { throwOnConnect?: boolean } = {}): CcSessionAdapter {
  return {
    connect: vi.fn(async (id: string) => {
      if (opts.throwOnConnect) {
        throw new Error('session not found');
      }
      session.id = id;
      return session;
    }),
  };
}

describe('cc-session-attach binding', () => {
  it('happy path: attaches, surfaces logs + progress, exits when session closes cleanly', async () => {
    const session = new FakeAttachedSession('sess-1', { workspace: '/repo' });
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork session',
      description: 'test',
      adapter: makeAdapter(session),
    });
    const handle = await binding.dispatch({ session_id: 'sess-1' }, ctx);
    expect(handle.metadata.session_id).toBe('sess-1');
    expect(handle.metadata.workspace).toBe('/repo');

    const logs: JobLogInfo[] = [];
    handle.events.on('log', (info) => logs.push(info));
    session.emit({ kind: 'log', stream: 'stdout', line: 'hello from cc' });
    session.emit({ kind: 'progress', message: 'thinking', payload: { step: 1 } });

    const exitPromise = new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    session.emit({ kind: 'closed', reason: 'completed', exit_code: 0 });
    const exit = await exitPromise;

    expect(logs.map((l) => l.line)).toEqual(['hello from cc']);
    expect(exit.reason).toBe('completed');
    expect(exit.exitCode).toBe(0);
  });

  it('adapter.connect throwing surfaces as a dispatch failure', async () => {
    const session = new FakeAttachedSession('sess-bad');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session, { throwOnConnect: true }),
    });
    await expect(binding.dispatch({ session_id: 'sess-bad' }, ctx)).rejects.toThrow(
      /failed to connect/,
    );
  });

  it('forwards initial_message via adapter.send', async () => {
    const session = new FakeAttachedSession('sess-init');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    await binding.dispatch(
      { session_id: 'sess-init', initial_message: 'go!' },
      ctx,
    );
    // The send is fire-and-forget — yield a microtask for it to land.
    await new Promise((r) => setImmediate(r));
    expect(session.sends).toHaveLength(1);
    expect(session.sends[0].body).toBe('go!');
  });

  it("'closed' with reason=crashed surfaces as binding exit reason=crashed", async () => {
    const session = new FakeAttachedSession('sess-crash');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    const handle = await binding.dispatch({ session_id: 'sess-crash' }, ctx);
    const exitPromise = new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    session.emit({ kind: 'closed', reason: 'crashed', exit_code: 137 });
    const exit = await exitPromise;
    expect(exit.reason).toBe('crashed');
    expect(exit.exitCode).toBe(137);
  });

  it('terminate(force=true) detaches WITHOUT closing the session and emits terminated', async () => {
    const session = new FakeAttachedSession('sess-detach');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    const handle = await binding.dispatch({ session_id: 'sess-detach' }, ctx);
    const exitPromise = new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    await handle.terminate(true);
    const exit = await exitPromise;
    expect(exit.reason).toBe('terminated');
    expect(session.detach).toHaveBeenCalled();
    // The session itself MUST still be reachable — we never call close()
    // on it; only detach(). The fake records detach==true, but the session
    // is still alive from the adapter's perspective.
    expect(session.detached).toBe(true); // detached
  });

  it('inject sends via adapter.send and rejects after terminate', async () => {
    const session = new FakeAttachedSession('sess-inj');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    const handle = await binding.dispatch({ session_id: 'sess-inj' }, ctx);
    expect(handle.inject).toBeDefined();

    await handle.inject!({ id: 'm1', body: { instruction: 'check tests' } });
    expect(session.sends).toContainEqual({ id: 'm1', body: { instruction: 'check tests' } });

    await handle.terminate(true);
    await expect(
      handle.inject!({ id: 'm2', body: { instruction: 'too late' } }),
    ).rejects.toThrow(/no longer attached/);
  });

  it('declares inject = true (the model use case for attach)', () => {
    const session = new FakeAttachedSession('any');
    const binding = createCcSessionAttachBinding({
      target: 'cowork',
      displayName: 'Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    expect(binding.capabilities.inject).toBe(true);
  });

  it('honors a custom target name and reflects it on kind/target', () => {
    const session = new FakeAttachedSession('any');
    const binding = createCcSessionAttachBinding({
      target: 'mobile-cowork',
      displayName: 'Mobile Cowork',
      description: 'test',
      adapter: makeAdapter(session),
    });
    expect(binding.kind).toBe('cc-session-attach');
    expect(binding.target).toBe('mobile-cowork');
  });
});
