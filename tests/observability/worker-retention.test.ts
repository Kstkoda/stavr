/**
 * v0.6.12 Phase 5 — worker retention policy tests.
 *
 * Phase 3a (worker-dispatch BOM) renames the env vars
 * STAVR_WORKER_RETENTION_HOURS → STAVR_JOB_RETENTION_HOURS and
 * STAVR_WORKER_HARD_DELETE_DAYS → STAVR_JOB_HARD_DELETE_DAYS. The legacy
 * names are still read for one release with a console.warn. The
 * "env resolution — Phase 3a renamed env vars" describe block below
 * covers that backwards-compat behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveWindowMs,
  hardDeleteCutoffIso,
  resolveWorkerRetentionOpts,
} from '../../src/observability/worker-retention.js';
import { EventStore } from '../../src/persistence.js';

describe('worker-retention — env resolution', () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; });

  it('defaults to 4h archive + 30d hard-delete when no env set', () => {
    delete process.env.STAVR_WORKER_RETENTION_HOURS;
    delete process.env.STAVR_WORKER_HARD_DELETE_DAYS;
    delete process.env.STAVR_JOB_RETENTION_HOURS;
    delete process.env.STAVR_JOB_HARD_DELETE_DAYS;
    const opts = resolveWorkerRetentionOpts();
    expect(opts.retentionHours).toBe(4);
    expect(opts.hardDeleteDays).toBe(30);
  });

  it('honors legacy env overrides (with deprecation warn)', () => {
    delete process.env.STAVR_JOB_RETENTION_HOURS;
    delete process.env.STAVR_JOB_HARD_DELETE_DAYS;
    process.env.STAVR_WORKER_RETENTION_HOURS = '12';
    process.env.STAVR_WORKER_HARD_DELETE_DAYS = '7';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = resolveWorkerRetentionOpts();
    expect(opts.retentionHours).toBe(12);
    expect(opts.hardDeleteDays).toBe(7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects non-positive values (falls back to defaults)', () => {
    delete process.env.STAVR_JOB_RETENTION_HOURS;
    delete process.env.STAVR_JOB_HARD_DELETE_DAYS;
    process.env.STAVR_WORKER_RETENTION_HOURS = '0';
    process.env.STAVR_WORKER_HARD_DELETE_DAYS = '-5';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = resolveWorkerRetentionOpts();
    expect(opts.retentionHours).toBe(4);
    expect(opts.hardDeleteDays).toBe(30);
    warn.mockRestore();
  });

  describe('Phase 3a — STAVR_JOB_* env vars', () => {
    it('prefers STAVR_JOB_* over STAVR_WORKER_* with no warning when only new is set', () => {
      delete process.env.STAVR_WORKER_RETENTION_HOURS;
      delete process.env.STAVR_WORKER_HARD_DELETE_DAYS;
      process.env.STAVR_JOB_RETENTION_HOURS = '8';
      process.env.STAVR_JOB_HARD_DELETE_DAYS = '60';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const opts = resolveWorkerRetentionOpts();
      expect(opts.retentionHours).toBe(8);
      expect(opts.hardDeleteDays).toBe(60);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('JOB_* wins when both are set, with a conflict warning', () => {
      process.env.STAVR_JOB_RETENTION_HOURS = '8';
      process.env.STAVR_WORKER_RETENTION_HOURS = '24';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const opts = resolveWorkerRetentionOpts();
      expect(opts.retentionHours).toBe(8);
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toContain('STAVR_JOB_RETENTION_HOURS');
      expect(msg).toContain('STAVR_WORKER_RETENTION_HOURS');
      warn.mockRestore();
    });

    it('falls back to legacy with deprecation warn when only legacy set', () => {
      delete process.env.STAVR_JOB_RETENTION_HOURS;
      process.env.STAVR_WORKER_RETENTION_HOURS = '20';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const opts = resolveWorkerRetentionOpts();
      expect(opts.retentionHours).toBe(20);
      const msg = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toContain('deprecated');
      warn.mockRestore();
    });
  });

  it('archiveWindowMs converts hours to ms', () => {
    expect(archiveWindowMs({ retentionHours: 4, hardDeleteDays: 30 })).toBe(4 * 60 * 60 * 1000);
  });

  it('hardDeleteCutoffIso produces an ISO timestamp N days before now', () => {
    const now = Date.parse('2026-05-20T12:00:00Z');
    const cutoff = hardDeleteCutoffIso({ retentionHours: 4, hardDeleteDays: 30 }, now);
    expect(cutoff).toBe('2026-04-20T12:00:00.000Z');
  });
});

describe('EventStore.deleteWorkersOlderThan — hard-delete', () => {
  let store: EventStore;
  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
  });

  it('removes terminated workers older than the cutoff', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const young = '2026-05-20T11:00:00.000Z';
    store.upsertWorker({
      id: 'w_old', name: 'old', type: 'cc', cwd: '/tmp', status: 'terminated',
      started_at: old, ended_at: old, last_activity_at: old,
      metadata: {}, spawn_params_hash: 'h',
    });
    store.upsertWorker({
      id: 'w_young', name: 'young', type: 'cc', cwd: '/tmp', status: 'terminated',
      started_at: young, ended_at: young, last_activity_at: young,
      metadata: {}, spawn_params_hash: 'h',
    });
    const deleted = store.deleteWorkersOlderThan('2026-01-01T00:00:00.000Z');
    expect(deleted).toBe(1);
    expect(store.getWorker('w_old')).toBeUndefined();
    expect(store.getWorker('w_young')).toBeDefined();
  });

  it('does NOT delete running/idle workers (only terminated/crashed)', () => {
    const old = '2025-01-01T00:00:00.000Z';
    store.upsertWorker({
      id: 'w_run', name: 'run', type: 'cc', cwd: '/tmp', status: 'running',
      started_at: old, last_activity_at: old,
      metadata: {}, spawn_params_hash: 'h',
    });
    const deleted = store.deleteWorkersOlderThan('2026-01-01T00:00:00.000Z');
    expect(deleted).toBe(0);
    expect(store.getWorker('w_run')).toBeDefined();
  });

  it('deletes crashed workers as well as terminated', () => {
    const old = '2025-01-01T00:00:00.000Z';
    store.upsertWorker({
      id: 'w_crash', name: 'c', type: 'cc', cwd: '/tmp', status: 'crashed',
      started_at: old, ended_at: old, last_activity_at: old,
      metadata: {}, spawn_params_hash: 'h',
    });
    const deleted = store.deleteWorkersOlderThan('2026-01-01T00:00:00.000Z');
    expect(deleted).toBe(1);
  });
});
