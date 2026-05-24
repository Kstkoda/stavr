import { describe, expect, it } from 'vitest';
import { fetchHostExecHistory } from '../../../../src/dashboard/data/history/host-exec.js';
import { makeStore } from './helpers.js';
import type { Database } from '../../../../src/db/index.js';

let seq = 1;
function seedEvent(db: Database, args: {
  kind: string;
  at: string;
  correlation_id?: string;
  source_agent?: string;
  payload: Record<string, unknown>;
}): void {
  db.prepare(
    `INSERT INTO events (id, kind, correlation_id, source_agent, tenant_id, payload_json, at, persisted_at, seq, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    `ev-${seq++}`,
    args.kind,
    args.correlation_id ?? null,
    args.source_agent ?? 'cc',
    JSON.stringify(args.payload),
    args.at,
    args.at,
    seq,
    args.at,
  );
}

describe('fetchHostExecHistory', () => {
  it('returns started events folded with their completed twin', () => {
    const { db } = makeStore();
    seedEvent(db, {
      kind: 'host_exec_started',
      at: '2026-05-20T10:00:00Z',
      correlation_id: 'cid-1',
      payload: { correlation_id: 'cid-1', scope_id: 'ts-1', command: 'git', args_hash: 'h', args_count: 2, timeout_ms: 5000 },
    });
    seedEvent(db, {
      kind: 'host_exec_completed',
      at: '2026-05-20T10:00:02Z',
      correlation_id: 'cid-1',
      payload: { correlation_id: 'cid-1', scope_id: 'ts-1', command: 'git', exit_code: 0, duration_ms: 2000, stdout_len: 10, stderr_len: 0, stdout_truncated: false, stderr_truncated: false, timed_out: false },
    });
    const page = fetchHostExecHistory({ db });
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.kind).toBe('host-exec');
    expect(item.status).toBe('success');
    const payload = item.payload as { exit_code: number; duration_ms: number };
    expect(payload.exit_code).toBe(0);
    expect(payload.duration_ms).toBe(2000);
  });

  it('returns empty page when no host_exec events exist', () => {
    const { db } = makeStore();
    expect(fetchHostExecHistory({ db }).items).toEqual([]);
  });

  it('marks denied + open execs and supports scope/command filters', () => {
    const { db } = makeStore();
    seedEvent(db, {
      kind: 'host_exec_started',
      at: '2026-05-20T09:00:00Z',
      correlation_id: 'cid-open',
      payload: { correlation_id: 'cid-open', scope_id: 'ts-a', command: 'npm', args_hash: 'h', args_count: 1, timeout_ms: 5000 },
    });
    seedEvent(db, {
      kind: 'host_exec_denied',
      at: '2026-05-20T09:30:00Z',
      correlation_id: 'cid-denied',
      payload: { correlation_id: 'cid-denied', command: 'rm', args_hash: 'h', args_count: 1, reason: 'no-go', error_code: 'SCOPE_DENIED' },
    });
    seedEvent(db, {
      kind: 'host_exec_started',
      at: '2026-05-20T10:00:00Z',
      correlation_id: 'cid-2',
      payload: { correlation_id: 'cid-2', scope_id: 'ts-b', command: 'git', args_hash: 'h', args_count: 1, timeout_ms: 5000 },
    });
    seedEvent(db, {
      kind: 'host_exec_completed',
      at: '2026-05-20T10:00:01Z',
      correlation_id: 'cid-2',
      payload: { correlation_id: 'cid-2', scope_id: 'ts-b', command: 'git', exit_code: 1, duration_ms: 500, stdout_len: 0, stderr_len: 50, stdout_truncated: false, stderr_truncated: false, timed_out: false },
    });
    const all = fetchHostExecHistory({ db });
    const byCid = new Map(all.items.map((i) => [i.correlation_id, i]));
    expect(byCid.get('cid-open')?.status).toBe('in-progress');
    expect(byCid.get('cid-denied')?.status).toBe('failure');
    expect(byCid.get('cid-2')?.status).toBe('failure');
    const onlyScopeB = fetchHostExecHistory({ db }, { scopeId: 'ts-b' });
    expect(onlyScopeB.items.map((i) => i.correlation_id)).toEqual(['cid-2']);
    const onlyNpm = fetchHostExecHistory({ db }, { command: 'npm' });
    expect(onlyNpm.items.map((i) => i.correlation_id)).toEqual(['cid-open']);
  });
});
