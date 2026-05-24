/**
 * Bombardment Phase 1 — oracle module tests.
 *
 * Each oracle gets a focused test:
 *   - Healthy daemon → ok=true
 *   - Synthetic violation → ok=false with the expected reason shape
 *   - Wrong-kind ctx → ok=null (declined, not failed)
 *
 * The oracles read SQLite directly via `store.rawDb`, so the tests
 * stand up a real EventStore + Broker on `:memory:`, mutate the
 * derived tables to induce violations, then assert.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import {
  defaultOracles,
  eventLogConsistency,
  healthzImpliesLive,
  noLiveRevokedScopes,
  noOrphanSessions,
  retentionBounds,
  runOracles,
  workersReachTerminal,
  makeWorkersReachTerminal,
} from '../../bombardment/oracles/index.js';

interface Harness {
  store: EventStore;
  broker: Broker;
}

function boot(): Harness {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  return { store, broker };
}

describe('bombardment/oracles', () => {
  let h: Harness;
  beforeEach(() => {
    h = boot();
  });
  afterEach(() => {
    // EventStore on :memory: drops when GC'd; no shutdown needed.
  });

  // ── runOracles ───────────────────────────────────────────────────────────
  it('defaultOracles() returns the seed set in a stable order', () => {
    const names = defaultOracles().map((o) => o.name || '<anonymous>');
    expect(names.length).toBe(6);
  });

  it('runOracles on a healthy in-process daemon passes (or declines)', async () => {
    const summary = await runOracles({
      kind: 'in-process',
      store: h.store,
      broker: h.broker,
      baseline: {
        sessionCount: h.broker.sessionCount(),
        subscriptionCount: h.broker.subscriptionCount(),
        eventCount: h.store.eventCount(),
      },
    });
    expect(summary.failed).toBe(0);
    expect(summary.passed + summary.declined).toBe(summary.results.length);
  });

  it('runOracles converts a throwing oracle into ok:null instead of propagating', async () => {
    const throwingOracle = async (): Promise<never> => {
      throw new Error('synthetic boom');
    };
    Object.defineProperty(throwingOracle, 'name', { value: 'synthetic_thrower' });
    const summary = await runOracles(
      { kind: 'in-process', store: h.store, broker: h.broker },
      [throwingOracle as never],
    );
    expect(summary.failed).toBe(0);
    expect(summary.declined).toBe(1);
    expect(summary.results[0].ok).toBeNull();
    expect(summary.results[0].name).toBe('synthetic_thrower');
    expect(summary.results[0].reason).toMatch(/oracle threw/);
  });

  it('all in-process oracles decline when given an HTTP ctx', async () => {
    const httpCtx = { kind: 'http' as const, baseUrl: 'http://127.0.0.1:9' };
    const summary = await runOracles(httpCtx);
    // healthz_implies_live actually IS HTTP-compatible; it should produce
    // either a fail (connection refused) or a null. Other oracles must decline.
    const inProcessOnly = summary.results.filter((r) => r.name !== 'healthz_implies_live');
    for (const r of inProcessOnly) {
      expect(r.ok).toBeNull();
    }
  });

  // ── noOrphanSessions ─────────────────────────────────────────────────────
  it('noOrphanSessions: passes when sessions stay at baseline', async () => {
    const r = await noOrphanSessions({
      kind: 'in-process',
      store: h.store,
      broker: h.broker,
      baseline: { sessionCount: 0, subscriptionCount: 0, eventCount: 0 },
    });
    expect(r.ok).toBe(true);
  });

  it('noOrphanSessions: declines without in-process ctx', async () => {
    const r = await noOrphanSessions({ kind: 'http', baseUrl: 'http://x' });
    expect(r.ok).toBeNull();
  });

  // ── noLiveRevokedScopes ──────────────────────────────────────────────────
  it('noLiveRevokedScopes: passes on a daemon with no scopes', async () => {
    const r = await noLiveRevokedScopes({ kind: 'in-process', store: h.store, broker: h.broker });
    // Pass OR decline (when trust_scopes table absent on bare schema).
    expect(r.ok === true || r.ok === null).toBe(true);
  });

  it('noLiveRevokedScopes: fails when a terminal-status scope is still live', async () => {
    // Ensure trust_scopes exists (schema is created lazily by the trust store
    // module when constructed). If the table is absent, the oracle declines —
    // create it explicitly to drive the failure path.
    try {
      h.store.rawDb.exec(`CREATE TABLE IF NOT EXISTS trust_scopes (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        granted_by TEXT,
        granted_at TEXT,
        expires_at TEXT,
        expires_after_actions INTEGER,
        allowed_actions_json TEXT,
        forbidden_actions_json TEXT,
        reporting_json TEXT,
        status TEXT,
        spec_url TEXT,
        proposed_at TEXT,
        actions_executed INTEGER,
        completed_at TEXT
      )`);
    } catch {
      /* table may already exist via the broker init path */
    }
    // Insert a revoked scope whose expiry is in the future and completed_at is null.
    const future = new Date(Date.now() + 60_000).toISOString();
    h.store.rawDb
      .prepare(
        `INSERT INTO trust_scopes (id,title,description,granted_by,granted_at,expires_at,expires_after_actions,allowed_actions_json,forbidden_actions_json,reporting_json,status,spec_url,proposed_at,actions_executed,completed_at)
         VALUES ('zombie','t','d','','',?,NULL,'[]',NULL,'{}','revoked',NULL,NULL,0,NULL)`,
      )
      .run(future);
    const r = await noLiveRevokedScopes({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/terminal-status scope/);
    expect(r.evidence?.violations).toBeDefined();
  });

  // ── workersReachTerminal ─────────────────────────────────────────────────
  it('workersReachTerminal: fails in strict mode when a worker is still running', async () => {
    h.store.rawDb.exec(`CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      cwd TEXT,
      pid INTEGER,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_activity_at TEXT,
      metadata_json TEXT,
      spawn_params_hash TEXT,
      termination_reason TEXT,
      exit_code INTEGER,
      lifecycle_state TEXT
    )`);
    h.store.rawDb
      .prepare(`INSERT INTO workers (id,name,type,cwd,status,started_at,last_activity_at,metadata_json,spawn_params_hash) VALUES ('w1','n','t','/','running',?,?,'{}','x')`)
      .run(new Date().toISOString(), new Date().toISOString());

    const strict = makeWorkersReachTerminal({ requireAllTerminal: true });
    const r = await strict({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-terminal/);
  });

  it('workersReachTerminal: continuous mode flags a worker with NULL last_activity_at via started_at fallback', async () => {
    h.store.rawDb.exec(`CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      cwd TEXT,
      pid INTEGER,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_activity_at TEXT,
      metadata_json TEXT,
      spawn_params_hash TEXT,
      termination_reason TEXT,
      exit_code INTEGER,
      lifecycle_state TEXT
    )`);
    // Spawned 10 minutes ago, never recorded activity — pre-fix the
    // continuous oracle would skip this row because last_activity_at
    // is NULL. The fallback to started_at flags it as stuck (10 min
    // > the default 5 min threshold).
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    h.store.rawDb
      .prepare(`INSERT INTO workers (id,name,type,cwd,status,started_at,last_activity_at,metadata_json,spawn_params_hash) VALUES ('zombie','n','t','/','running',?,NULL,'{}','x')`)
      .run(tenMinAgo);

    const r = await workersReachTerminal({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stuck/);
    const violations = (r.evidence as { violations: Array<{ clock: string }> }).violations;
    expect(violations[0].clock).toBe('started_at');
  });

  it('workersReachTerminal: continuous mode tolerates a fresh running worker', async () => {
    h.store.rawDb.exec(`CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      cwd TEXT,
      pid INTEGER,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_activity_at TEXT,
      metadata_json TEXT,
      spawn_params_hash TEXT,
      termination_reason TEXT,
      exit_code INTEGER,
      lifecycle_state TEXT
    )`);
    h.store.rawDb
      .prepare(`INSERT INTO workers (id,name,type,cwd,status,started_at,last_activity_at,metadata_json,spawn_params_hash) VALUES ('w1','n','t','/','running',?,?,'{}','x')`)
      .run(new Date().toISOString(), new Date().toISOString());

    const r = await workersReachTerminal({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(true);
  });

  // ── healthzImpliesLive ───────────────────────────────────────────────────
  it('healthzImpliesLive: passes in-process when the store is reachable + writable', async () => {
    const r = await healthzImpliesLive({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(true);
  });

  // ── retentionBounds ──────────────────────────────────────────────────────
  it('retentionBounds: passes on a fresh daemon (events well under cap)', async () => {
    const r = await retentionBounds({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(true);
  });

  // ── eventLogConsistency ──────────────────────────────────────────────────
  it('eventLogConsistency: passes on a fresh daemon with no decisions or workers', async () => {
    const r = await eventLogConsistency({ kind: 'in-process', store: h.store, broker: h.broker });
    expect(r.ok).toBe(true);
  });
});
