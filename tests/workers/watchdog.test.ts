import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { start } from '../../src/workers/watchdog.js';

function makeStore(): EventStore {
  const s = new EventStore();
  s.init(':memory:');
  return s;
}

function insertWorker(
  store: EventStore,
  opts: {
    id: string;
    name: string;
    type: string;
    status: string;
    started_at: string;
    last_activity_at: string | null;
  },
): void {
  // Insert a synthetic row directly via the event-store's DB handle.
  store.rawDb.prepare(
    `INSERT INTO workers
       (id, name, type, cwd, pid, status, started_at, ended_at, last_activity_at,
        metadata_json, spawn_params_hash, termination_reason, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id, opts.name, opts.type, '/tmp', null,
    opts.status, opts.started_at, null, opts.last_activity_at,
    '{}', 'hash', null, null,
  );
}

describe('stuck-worker watchdog', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = makeStore();
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('emits one worker_stuck per stuck worker on each tick', async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    insertWorker(store, {
      id: 'w1',
      name: 'stuck-worker',
      type: 'cc',
      status: 'running',
      started_at: oldTime,
      last_activity_at: oldTime,
    });

    const emitted: unknown[] = [];
    broker.onRawEvent((ev) => {
      if (ev.kind === 'worker_stuck') emitted.push(ev.payload);
    });

    const handle = start(broker, store, {
      intervalMs: 50,
      stuckThresholdSec: 60, // 60s threshold — worker is 10min idle, so stuck
      reEmitIntervalMs: 60 * 60_000,
    });

    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const first = emitted[0] as Record<string, unknown>;
    expect(first.worker_id).toBe('w1');
    expect(first.worker_name).toBe('stuck-worker');
    expect(first.idle_seconds).toBeGreaterThan(60);
    expect(typeof first.hint).toBe('string');
  });

  it('does not emit for non-stuck workers', async () => {
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    insertWorker(store, {
      id: 'w2',
      name: 'active-worker',
      type: 'cc',
      status: 'running',
      started_at: recentTime,
      last_activity_at: recentTime,
    });

    const emitted: unknown[] = [];
    broker.onRawEvent((ev) => {
      if (ev.kind === 'worker_stuck') emitted.push(ev);
    });

    const handle = start(broker, store, {
      intervalMs: 50,
      stuckThresholdSec: 300,
      reEmitIntervalMs: 60 * 60_000,
    });

    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(emitted).toHaveLength(0);
  });

  it('emits at most once per (worker_id, last_activity_at) within reEmitIntervalMs', async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertWorker(store, {
      id: 'w3',
      name: 'dup-worker',
      type: 'cc',
      status: 'running',
      started_at: oldTime,
      last_activity_at: oldTime,
    });

    const emitted: unknown[] = [];
    broker.onRawEvent((ev) => {
      if (ev.kind === 'worker_stuck') emitted.push(ev);
    });

    const handle = start(broker, store, {
      intervalMs: 30,
      stuckThresholdSec: 60,
      reEmitIntervalMs: 60 * 60_000, // never re-emit within test window
    });

    // Run multiple ticks
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    // Should emit exactly once for this worker (idempotency)
    expect(emitted).toHaveLength(1);
  });

  it('re-emits after last_activity_at advances', async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertWorker(store, {
      id: 'w4',
      name: 'advancing-worker',
      type: 'cc',
      status: 'running',
      started_at: oldTime,
      last_activity_at: oldTime,
    });

    const emitted: unknown[] = [];
    broker.onRawEvent((ev) => {
      if (ev.kind === 'worker_stuck') emitted.push(ev.payload);
    });

    const handle = start(broker, store, {
      intervalMs: 30,
      stuckThresholdSec: 60,
      reEmitIntervalMs: 60 * 60_000,
    });

    // Wait for first emit
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBe(1);

    // Advance last_activity_at so it's still stuck but with a new timestamp
    const newOldTime = new Date(Date.now() - 8 * 60 * 1000).toISOString();
    store.rawDb
      .prepare(`UPDATE workers SET last_activity_at = ? WHERE id = 'w4'`)
      .run(newOldTime);

    // Wait for another tick
    await new Promise((r) => setTimeout(r, 80));
    handle.stop();

    // Should have emitted a second time after last_activity_at changed
    expect(emitted.length).toBe(2);
  });

  it('stop() prevents further ticks', async () => {
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertWorker(store, {
      id: 'w5',
      name: 'stop-test',
      type: 'cc',
      status: 'running',
      started_at: oldTime,
      last_activity_at: oldTime,
    });

    const emitted: unknown[] = [];
    broker.onRawEvent((ev) => {
      if (ev.kind === 'worker_stuck') emitted.push(ev);
    });

    const handle = start(broker, store, {
      intervalMs: 30,
      stuckThresholdSec: 60,
      reEmitIntervalMs: 60 * 60_000,
    });

    // Stop immediately
    handle.stop();

    // Wait longer than one interval
    await new Promise((r) => setTimeout(r, 100));
    // Should have emitted 0 or 1 (first tick may have already fired)
    const countAfterStop = emitted.length;

    await new Promise((r) => setTimeout(r, 100));
    // Count must not grow after stop
    expect(emitted.length).toBe(countAfterStop);
  });
});
