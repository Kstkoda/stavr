import { describe, expect, it } from 'vitest';
import { fetchScopesHistory } from '../../../../src/dashboard/data/history/scopes.js';
import { makeStore } from './helpers.js';

function seedScope(db: import('better-sqlite3').Database, override: Partial<{
  id: string;
  title: string;
  status: string;
  proposed_at: string;
  granted_at: string;
  granted_by: string;
  expires_at: string;
}>): void {
  db.prepare(
    `INSERT INTO trust_scopes
       (id, title, description, granted_by, granted_at, expires_at,
        expires_after_actions, allowed_actions_json, forbidden_actions_json,
        reporting_json, status, spec_url, proposed_at, actions_executed, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, 0, NULL)`,
  ).run(
    override.id ?? 'ts-1',
    override.title ?? 'Default scope',
    'desc',
    override.granted_by ?? 'operator',
    override.granted_at ?? '2026-05-20T10:00:00Z',
    override.expires_at ?? '2099-01-01T00:00:00Z',
    JSON.stringify([{ tool: 'github_read_pr' }]),
    JSON.stringify({ cadence: 'every-5-actions', channels: ['chat'] }),
    override.status ?? 'active',
    override.proposed_at ?? '2026-05-20T09:55:00Z',
  );
}

describe('fetchScopesHistory', () => {
  it('returns rows sorted by proposed_at DESC', () => {
    const { db } = makeStore();
    seedScope(db, { id: 'ts-a', proposed_at: '2026-05-20T08:00:00Z' });
    seedScope(db, { id: 'ts-b', proposed_at: '2026-05-20T09:00:00Z' });
    seedScope(db, { id: 'ts-c', proposed_at: '2026-05-20T10:00:00Z' });
    const page = fetchScopesHistory({ db });
    expect(page.items.map((i) => i.id)).toEqual(['ts-c', 'ts-b', 'ts-a']);
    expect(page.items[0].correlation_id).toBe('ts-c');
  });

  it('returns empty page when table is empty', () => {
    const { db } = makeStore();
    expect(fetchScopesHistory({ db }).items).toEqual([]);
  });

  it('honours status + pagination', () => {
    const { db } = makeStore();
    for (let i = 0; i < 5; i++) {
      seedScope(db, {
        id: `ts-${i}`,
        proposed_at: `2026-05-20T0${i}:00:00Z`,
        status: i % 2 === 0 ? 'expired' : 'active',
      });
    }
    const expiredPage = fetchScopesHistory({ db }, { status: 'expired', limit: 2 });
    expect(expiredPage.items.map((i) => i.id)).toEqual(['ts-4', 'ts-2']);
    expect(expiredPage.total_estimate).toBe(3);
    expect(expiredPage.next_cursor).toBe('2');
  });

  it('maps trust-scope status to the history status pill', () => {
    const { db } = makeStore();
    seedScope(db, { id: 'ts-prop',  status: 'proposed',  proposed_at: '2026-05-20T01:00:00Z' });
    seedScope(db, { id: 'ts-rev',   status: 'revoked',   proposed_at: '2026-05-20T02:00:00Z' });
    seedScope(db, { id: 'ts-exp',   status: 'expired',   proposed_at: '2026-05-20T03:00:00Z' });
    seedScope(db, { id: 'ts-comp',  status: 'completed', proposed_at: '2026-05-20T04:00:00Z' });
    const page = fetchScopesHistory({ db });
    const byId = new Map(page.items.map((i) => [i.id, i.status]));
    expect(byId.get('ts-prop')).toBe('pending');
    expect(byId.get('ts-rev')).toBe('revoked');
    expect(byId.get('ts-exp')).toBe('expired');
    expect(byId.get('ts-comp')).toBe('success');
  });
});
