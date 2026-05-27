/**
 * tests/jobs/persistence.test.ts — JobRecord CRUD over the new `jobs` table.
 *
 * Validates schema, upsert behaviour, name-availability, lifecycle
 * transitions, and the JSON-column round-trip (result_json, budget_json,
 * metadata_json).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import type { JobRecord } from '../../src/jobs/types.js';

describe('persistence.jobs', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function mkRecord(over: Partial<JobRecord> = {}): JobRecord {
    return {
      id: 'job-1',
      name: 'sample',
      binding_kind: 'process-spawn',
      binding_target: 'generic',
      params_hash: 'deadbeef',
      lifecycle_state: 'dispatched',
      started_at: '2026-05-27T00:00:00Z',
      last_activity_at: '2026-05-27T00:00:00Z',
      metadata: { note: 'hello' },
      ...over,
    };
  }

  it('inserts and reads a job by id', () => {
    const rec = mkRecord();
    store.upsertJob(rec);
    const fetched = store.getJob('job-1');
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe('job-1');
    expect(fetched?.binding_kind).toBe('process-spawn');
    expect(fetched?.metadata).toEqual({ note: 'hello' });
    expect(fetched?.lifecycle_state).toBe('dispatched');
  });

  it('round-trips budget and result JSON columns', () => {
    const rec = mkRecord({
      budget: { max_runtime_ms: 5000, credit_pool: 'subscription-cc' },
      result: { value: 42, kind: 'ok' },
    });
    store.upsertJob(rec);
    const fetched = store.getJob('job-1');
    expect(fetched?.budget).toEqual({ max_runtime_ms: 5000, credit_pool: 'subscription-cc' });
    expect(fetched?.result).toEqual({ value: 42, kind: 'ok' });
  });

  it('looks up jobs by name with active-first ordering', () => {
    store.upsertJob(mkRecord({ id: 'job-a', name: 'shared', lifecycle_state: 'completed-clean', started_at: '2026-05-27T00:00:00Z' }));
    store.upsertJob(mkRecord({ id: 'job-b', name: 'shared', lifecycle_state: 'running', started_at: '2026-05-27T00:01:00Z' }));
    const fetched = store.getJob('shared');
    expect(fetched?.id).toBe('job-b'); // the active one wins
  });

  it('lists jobs filtered by binding_kind', () => {
    store.upsertJob(mkRecord({ id: 'a', binding_kind: 'process-spawn' }));
    store.upsertJob(mkRecord({ id: 'b', binding_kind: 'mcp-call', name: 'm' }));
    store.upsertJob(mkRecord({ id: 'c', binding_kind: 'process-spawn', name: 'c' }));
    const ps = store.listJobs({ binding_kind: 'process-spawn' });
    expect(ps).toHaveLength(2);
    expect(ps.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('marks a job terminated with the right derived lifecycle state', () => {
    store.upsertJob(mkRecord({ lifecycle_state: 'running' }));
    const updated = store.markJobTerminated('job-1', 'completed', 0, { result: 'ok' });
    expect(updated?.lifecycle_state).toBe('completed-clean');
    expect(updated?.exit_code).toBe(0);
    expect(updated?.result).toEqual({ result: 'ok' });
    expect(updated?.ended_at).toBeDefined();
  });

  it('classifies non-zero exit as completed-error', () => {
    store.upsertJob(mkRecord({ lifecycle_state: 'running' }));
    const updated = store.markJobTerminated('job-1', 'completed', 1);
    expect(updated?.lifecycle_state).toBe('completed-error');
  });

  it('classifies terminated_by_user as killed-by-operator', () => {
    store.upsertJob(mkRecord({ lifecycle_state: 'running' }));
    const updated = store.markJobTerminated('job-1', 'terminated_by_user');
    expect(updated?.lifecycle_state).toBe('killed-by-operator');
  });

  it('jobNameIsAvailable returns false while a job is active', () => {
    store.upsertJob(mkRecord({ name: 'busy', lifecycle_state: 'running' }));
    expect(store.jobNameIsAvailable('busy')).toBe(false);
    expect(store.jobNameIsAvailable('other')).toBe(true);
  });

  it('jobNameIsAvailable returns true once the job has terminated', () => {
    store.upsertJob(mkRecord({ name: 'busy', lifecycle_state: 'running' }));
    store.markJobTerminated('job-1', 'completed', 0);
    expect(store.jobNameIsAvailable('busy')).toBe(true);
  });

  it('listJobsForWatchdog returns only dispatched + running', () => {
    store.upsertJob(mkRecord({ id: 'a', lifecycle_state: 'running' }));
    store.upsertJob(mkRecord({ id: 'b', name: 'b', lifecycle_state: 'dispatched' }));
    store.upsertJob(mkRecord({ id: 'c', name: 'c', lifecycle_state: 'completed-clean' }));
    const rows = store.listJobsForWatchdog();
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
