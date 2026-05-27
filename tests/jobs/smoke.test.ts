/**
 * tests/jobs/smoke.test.ts — Phase 1 end-to-end empirical proof.
 *
 * Wires the REAL JobOrchestrator + REAL Broker + REAL EventStore (sqlite
 * in-memory) + the REAL process-spawn binding, dispatches a real Node child
 * process, and asserts the full lifecycle is observable through the broker:
 *
 *   dispatched → running → log fan-out → completed-clean
 *
 * If this test passes, the Phase 1 substrate is exercised whole. Operator
 * reads the captured event stream at the halt to verify the contract shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { JobOrchestrator } from '../../src/jobs/orchestrator.js';
import { createProcessSpawnBinding } from '../../src/jobs/binding-process-spawn.js';
import { invoke } from '../../src/jobs/invoke.js';

interface CapturedEvent {
  kind: string;
  payload: unknown;
}

describe('worker-dispatch Phase 1 — end-to-end smoke', () => {
  let store: EventStore;
  let broker: Broker;
  let orch: JobOrchestrator;
  let captured: CapturedEvent[];

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    orch = new JobOrchestrator({ broker, store, idleAfterMs: null });
    captured = [];
    broker.onEvent((ev) => {
      if (ev.kind.startsWith('job_')) {
        captured.push({ kind: ev.kind, payload: ev.payload });
      }
    });
    orch.register(createProcessSpawnBinding({ target: 'generic' }));
  });

  afterEach(() => {
    store.close();
  });

  it('dispatch → running → log → completed-clean (real node child)', async () => {
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'generic',
      name: 'phase1-smoke-success',
      params: {
        command: 'console.log("alpha"); console.log("beta"); process.exit(0);',
        args: [],
        via_node: true,
      },
    });

    // Wait until the row reaches a terminal state.
    await waitForTerminal(store, job.id, 5000);

    const final = store.getJob(job.id);
    expect(final?.lifecycle_state).toBe('completed-clean');
    expect(final?.exit_code).toBe(0);

    const kinds = captured.map((e) => e.kind);
    expect(kinds[0]).toBe('job_dispatched');
    expect(kinds).toContain('job_started');
    expect(kinds.filter((k) => k === 'job_log').length).toBeGreaterThanOrEqual(2);
    expect(kinds[kinds.length - 1]).toBe('job_terminated');

    // The stdout lines must have surfaced as job_log payloads.
    const stdoutLines = captured
      .filter((e) => e.kind === 'job_log')
      .map((e) => (e.payload as { line?: string; stream: string }))
      .filter((p) => p.stream === 'stdout')
      .map((p) => p.line);
    expect(stdoutLines).toContain('alpha');
    expect(stdoutLines).toContain('beta');

    // job_terminated must include exit_code 0 and reason 'completed'.
    const terminated = captured.find((e) => e.kind === 'job_terminated')!;
    expect((terminated.payload as { reason: string }).reason).toBe('completed');
    expect((terminated.payload as { exit_code: number }).exit_code).toBe(0);
  });

  it('non-zero exit classifies as crashed', async () => {
    const { job } = await orch.dispatch({
      binding_kind: 'process-spawn',
      binding_target: 'generic',
      name: 'phase1-smoke-crash',
      params: {
        command: 'process.exit(13);',
        args: [],
        via_node: true,
      },
    });
    await waitForTerminal(store, job.id, 5000);
    const final = store.getJob(job.id);
    expect(final?.lifecycle_state).toBe('crashed');
    expect(final?.exit_code).toBe(13);
    const terminated = captured.find((e) => e.kind === 'job_terminated')!;
    expect((terminated.payload as { reason: string }).reason).toBe('crashed');
  });

  it('invoke primitive runs synchronously to completion', async () => {
    const binding = createProcessSpawnBinding({ target: 'generic' });
    const result = await invoke(
      binding,
      {
        command: 'console.log("hi-from-invoke"); process.exit(0);',
        args: [],
        via_node: true,
      },
      { timeoutMs: 5000 },
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain('hi-from-invoke');
  });

  it('invoke honors timeoutMs and kills runaway processes', async () => {
    const binding = createProcessSpawnBinding({ target: 'generic' });
    const result = await invoke(
      binding,
      {
        command: 'setInterval(() => {}, 1000);',
        args: [],
        via_node: true,
      },
      { timeoutMs: 250 },
    );
    expect(result.timed_out).toBe(true);
    expect(result.reason).toBe('timed_out');
    expect(result.ok).toBe(false);
  });
});

async function waitForTerminal(
  store: EventStore,
  id: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = store.getJob(id);
    if (rec && rec.ended_at) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not reach a terminal state within ${timeoutMs}ms`);
}
