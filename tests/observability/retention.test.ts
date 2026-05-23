import { describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import {
  AUDIT_KINDS,
  OPERATIONAL_KINDS,
  resolveRetentionOpts,
  retentionClass,
} from '../../src/observability/retention.js';

function freshStore(): EventStore {
  const store = new EventStore();
  store.init(':memory:');
  return store;
}

describe('retentionClass', () => {
  it('classifies operational, audit, and unknown kinds', () => {
    expect(retentionClass('daemon_memory')).toBe('operational');
    expect(retentionClass('worker_progress')).toBe('operational');
    expect(retentionClass('trust_scope_granted')).toBe('audit');
    expect(retentionClass('decision_response')).toBe('audit');
    expect(retentionClass('totally_made_up_kind_xyz')).toBe('unknown');
  });

  it('partitions disjoint sets', () => {
    for (const k of OPERATIONAL_KINDS) {
      expect(AUDIT_KINDS.has(k)).toBe(false);
    }
  });
});

describe('resolveRetentionOpts', () => {
  it('honours BOM defaults when env unset', () => {
    delete process.env.STAVR_EVENTS_OP_RETENTION_DAYS;
    delete process.env.STAVR_EVENTS_OP_MAX_ROWS;
    delete process.env.STAVR_EVENTS_AUDIT_RETENTION_DAYS;
    expect(resolveRetentionOpts()).toEqual({
      operationalDays: 7,
      operationalMaxRows: 100_000,
      auditDays: 90,
    });
  });

  it('reads numeric env overrides', () => {
    process.env.STAVR_EVENTS_OP_RETENTION_DAYS = '3';
    process.env.STAVR_EVENTS_OP_MAX_ROWS = '500';
    process.env.STAVR_EVENTS_AUDIT_RETENTION_DAYS = '180';
    try {
      expect(resolveRetentionOpts()).toEqual({
        operationalDays: 3,
        operationalMaxRows: 500,
        auditDays: 180,
      });
    } finally {
      delete process.env.STAVR_EVENTS_OP_RETENTION_DAYS;
      delete process.env.STAVR_EVENTS_OP_MAX_ROWS;
      delete process.env.STAVR_EVENTS_AUDIT_RETENTION_DAYS;
    }
  });

  it('explicit overrides win over env', () => {
    process.env.STAVR_EVENTS_OP_RETENTION_DAYS = '3';
    try {
      expect(resolveRetentionOpts({ operationalDays: 1 }).operationalDays).toBe(1);
    } finally {
      delete process.env.STAVR_EVENTS_OP_RETENTION_DAYS;
    }
  });
});

describe('EventStore.pruneEvents', () => {
  it('drops operational events older than the age cap', async () => {
    const store = freshStore();
    // Insert an old + a fresh operational event by post-dating created_at.
    await store.appendEvent({
      kind: 'daemon_memory',
      at: new Date().toISOString(),
      source_agent: 'test',
      payload: { rss: 1 },
    });
    await store.appendEvent({
      kind: 'daemon_memory',
      at: new Date().toISOString(),
      source_agent: 'test',
      payload: { rss: 2 },
    });
    // Backdate the first row by 30 days.
    const oldIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const db = store.rawDb;
    const ids = db.prepare(`SELECT id FROM events ORDER BY seq ASC`).all() as { id: string }[];
    db.prepare(`UPDATE events SET created_at = ? WHERE id = ?`).run(oldIso, ids[0].id);

    const result = store.pruneEvents({ operationalDays: 7 });
    expect(result.deletedOperational).toBeGreaterThanOrEqual(1);
    expect(store.eventCount()).toBe(1);
  });

  it('caps operational rows at operationalMaxRows', async () => {
    const store = freshStore();
    for (let i = 0; i < 20; i++) {
      await store.appendEvent({
        kind: 'worker_progress',
        at: new Date(Date.now() - (20 - i) * 1000).toISOString(),
        source_agent: 'test',
        payload: { id: 'w', message: `msg-${i}` },
      });
    }
    const result = store.pruneEvents({ operationalMaxRows: 5, operationalDays: 365 });
    expect(result.deletedOperational).toBe(15);
    expect(store.eventCount()).toBe(5);
  });

  it('preserves audit events even beyond operational caps', async () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) {
      await store.appendEvent({
        kind: 'trust_scope_granted',
        at: new Date().toISOString(),
        source_agent: 'test',
        payload: { id: `s${i}` },
      });
    }
    const result = store.pruneEvents({ operationalMaxRows: 1, operationalDays: 0, auditDays: 90 });
    expect(result.deletedAudit).toBe(0);
    expect(store.eventCount()).toBe(10);
  });

  it('preserves and reports unknown kinds without deleting them', async () => {
    const store = freshStore();
    await store.appendEvent({
      kind: 'totally_unrecognised_kind' as 'progress',
      at: new Date().toISOString(),
      source_agent: 'test',
      payload: {},
    });
    const result = store.pruneEvents();
    expect(result.unknownPreserved).toBe(1);
    expect(store.eventCount()).toBe(1);
  });

  it('drops audit events older than the age cap', async () => {
    const store = freshStore();
    await store.appendEvent({
      kind: 'trust_scope_granted',
      at: new Date().toISOString(),
      source_agent: 'test',
      payload: { id: 'old' },
    });
    const db = store.rawDb;
    db.prepare(`UPDATE events SET created_at = ?`).run(new Date(Date.now() - 200 * 86_400_000).toISOString());

    const result = store.pruneEvents({ auditDays: 90 });
    expect(result.deletedAudit).toBe(1);
    expect(store.eventCount()).toBe(0);
  });
});
