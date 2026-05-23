import { describe, expect, it } from 'vitest';
import { fetchPlansHistory } from '../../../../src/dashboard/data/history/plans.js';
import { makeStore } from './helpers.js';
import type { Database } from '../../../../src/db/index.js';

function seedBom(db: Database, override: Partial<{
  id: string;
  goal: string;
  status: string;
  proposed_at: string;
  requester: string;
  correlation_id: string;
}>): void {
  db.prepare(
    `INSERT INTO boms
       (id, goal, requester, correlation_id, status, active_version,
        cost_estimate, cost_max, duration_sec, cost_actual, steps_done, steps_total,
        profile_mode, scope_id, risk_envelope, proposed_at, approved_at,
        started_at, ended_at, is_draft)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 'balanced', NULL, '[]', ?, NULL, NULL, NULL, 0)`,
  ).run(
    override.id ?? 'b1',
    override.goal ?? 'Goal',
    override.requester ?? 'operator',
    override.correlation_id ?? 'cid-b1',
    override.status ?? 'proposed',
    override.proposed_at ?? '2026-05-20T10:00:00Z',
  );
}

describe('fetchPlansHistory', () => {
  it('returns rows sorted by proposed_at DESC', () => {
    const { db } = makeStore();
    seedBom(db, { id: 'b1', proposed_at: '2026-05-20T08:00:00Z' });
    seedBom(db, { id: 'b2', proposed_at: '2026-05-20T09:00:00Z' });
    seedBom(db, { id: 'b3', proposed_at: '2026-05-20T10:00:00Z' });
    const page = fetchPlansHistory({ db });
    expect(page.items.map((i) => i.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('returns empty page when table is empty', () => {
    const { db } = makeStore();
    expect(fetchPlansHistory({ db }).items).toEqual([]);
  });

  it('filters by status + paginates', () => {
    const { db } = makeStore();
    for (let i = 0; i < 5; i++) {
      seedBom(db, {
        id: `b-${i}`,
        proposed_at: `2026-05-20T0${i}:00:00Z`,
        status: i % 2 === 0 ? 'done' : 'failed',
      });
    }
    const donePage = fetchPlansHistory({ db }, { status: 'done', limit: 2 });
    expect(donePage.items.map((i) => i.id)).toEqual(['b-4', 'b-2']);
    expect(donePage.next_cursor).toBe('2');
    expect(donePage.total_estimate).toBe(3);
    expect(donePage.items[0].status).toBe('success');
    expect(donePage.items[0].correlation_id).toBe('cid-b1');
  });
});
