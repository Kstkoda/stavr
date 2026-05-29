/**
 * tests/jobs/watchdog.test.ts — Phase 3a job watchdog with worker_stuck
 * dual-emit. Mirrors tests/workers/watchdog.test.ts's structure so the
 * two stuck-detectors stay in lockstep until 3c removes the worker one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { start as startJobWatchdog } from '../../src/jobs/watchdog.js';
import type { JobRecord } from '../../src/jobs/types.js';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'j1',
    name: 'job-one',
    binding_kind: 'process-spawn',
    binding_target: 'mock',
    params_hash: 'h',
    lifecycle_state: 'running',
    started_at: '2026-01-01T10:00:00.000Z',
    last_activity_at: '2026-01-01T10:00:00.000Z',
    metadata: { pid: 12345 },
    ...overrides,
  };
}

describe('job-watchdog — Phase 3a', () => {
  let store: EventStore;
  let broker: Broker;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
  });

  afterEach(() => {
    store.close();
  });

  it('emits BOTH job_stuck and worker_stuck (dual-emit) past the threshold', async () => {
    store.upsertJob(makeJob());
    const events: Array<{ kind: string; payload: unknown }> = [];
    broker.onEvent((ev) => events.push({ kind: ev.kind, payload: ev.payload }));

    // Threshold 0s + interval long enough we tick manually.
    const wd = startJobWatchdog(broker, store, {
      intervalMs: 24 * 60 * 60 * 1000,
      stuckThresholdSec: 0,
      reEmitIntervalMs: 0,
    });
    try {
      // Trigger a tick by waiting for the immediate-fire (start() above does
      // not fire eagerly — it relies on the interval). We need to drive the
      // private tick. Easiest path: re-instantiate at a tiny interval.
      wd.stop();
      const wd2 = startJobWatchdog(broker, store, {
        intervalMs: 5,
        stuckThresholdSec: 0,
        reEmitIntervalMs: 0,
      });
      try {
        await new Promise((r) => setTimeout(r, 25));
      } finally {
        wd2.stop();
      }
    } finally {
      // already stopped
    }

    const jobStuck = events.find((e) => e.kind === 'job_stuck');
    const workerStuck = events.find((e) => e.kind === 'worker_stuck');
    expect(jobStuck).toBeDefined();
    expect(workerStuck).toBeDefined();
    expect((jobStuck?.payload as { job_id: string }).job_id).toBe('j1');
    expect((workerStuck?.payload as { worker_id: string }).worker_id).toBe('j1');
    expect((workerStuck?.payload as { worker_type: string }).worker_type).toBe(
      'process-spawn:mock',
    );
  });

  it('respects per-job metadata.stuck_threshold_sec override', async () => {
    // Anchor near now so the override (1 hour) outlasts the test idle gap.
    const recent = new Date(Date.now() - 1_000).toISOString();
    store.upsertJob(
      makeJob({
        started_at: recent,
        last_activity_at: recent,
        metadata: { pid: 1, stuck_threshold_sec: 3600 },
      }),
    );
    const events: Array<{ kind: string }> = [];
    broker.onEvent((ev) => events.push({ kind: ev.kind }));
    const wd = startJobWatchdog(broker, store, {
      intervalMs: 5,
      stuckThresholdSec: 0,
      reEmitIntervalMs: 0,
    });
    try {
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      wd.stop();
    }
    expect(events.find((e) => e.kind === 'job_stuck')).toBeUndefined();
  });

  it('does not re-emit within the re-emit window for the same last_activity_at', async () => {
    store.upsertJob(makeJob());
    const events: Array<{ kind: string }> = [];
    broker.onEvent((ev) => events.push({ kind: ev.kind }));
    const wd = startJobWatchdog(broker, store, {
      intervalMs: 5,
      stuckThresholdSec: 0,
      reEmitIntervalMs: 10 * 60 * 1000, // 10 minutes — never re-emits in this test
    });
    try {
      await new Promise((r) => setTimeout(r, 35));
    } finally {
      wd.stop();
    }
    const stuckCount = events.filter((e) => e.kind === 'job_stuck').length;
    expect(stuckCount).toBe(1);
  });
});
