import { describe, expect, it } from 'vitest';
import { fetchDecisionsHistory } from '../../../../src/dashboard/data/history/decisions.js';
import { makeStore } from './helpers.js';
import type { Database } from '../../../../src/db/index.js';

function seed(db: Database, rows: Array<Partial<{
  correlation_id: string;
  question: string;
  options_json: string;
  status: string;
  requested_at: string;
}>>): void {
  const stmt = db.prepare(
    `INSERT INTO decisions (correlation_id, question, options_json, default_option_id,
      timeout_sec, status, requested_at, expires_at)
     VALUES (?, ?, ?, NULL, 60, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.correlation_id ?? 'cid-default',
      r.question ?? 'q',
      r.options_json ?? JSON.stringify([{ id: 'a', label: 'Approve' }, { id: 'd', label: 'Deny' }]),
      r.status ?? 'open',
      r.requested_at ?? '2026-05-20T10:00:00Z',
      '2099-01-01T00:00:00Z',
    );
  }
}

describe('fetchDecisionsHistory', () => {
  it('returns rows sorted by requested_at DESC', () => {
    const { db } = makeStore();
    seed(db, [
      { correlation_id: 'a', question: 'first',  requested_at: '2026-05-20T08:00:00Z' },
      { correlation_id: 'b', question: 'second', requested_at: '2026-05-20T09:00:00Z' },
      { correlation_id: 'c', question: 'third',  requested_at: '2026-05-20T10:00:00Z' },
    ]);
    const page = fetchDecisionsHistory({ db });
    expect(page.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(page.total_estimate).toBe(3);
    expect(page.next_cursor).toBeNull();
  });

  it('returns empty page when table is empty', () => {
    const { db } = makeStore();
    const page = fetchDecisionsHistory({ db });
    expect(page.items).toEqual([]);
    expect(page.total_estimate).toBe(0);
    expect(page.next_cursor).toBeNull();
  });

  it('honours since/until/status + emits a next_cursor at the pagination boundary', () => {
    const { db } = makeStore();
    const rows = Array.from({ length: 7 }, (_, i) => ({
      correlation_id: `cid-${i}`,
      question: `q${i}`,
      requested_at: `2026-05-20T0${i}:00:00Z`,
      status: i % 2 === 0 ? 'expired' : 'open',
    }));
    seed(db, rows);
    const inRange = fetchDecisionsHistory(
      { db },
      { since: '2026-05-20T02:00:00Z', until: '2026-05-20T05:00:00Z' },
    );
    expect(inRange.items.map((i) => i.id)).toEqual(['cid-4', 'cid-3', 'cid-2']);
    const onlyExpired = fetchDecisionsHistory({ db }, { status: 'expired', limit: 2 });
    expect(onlyExpired.items.map((i) => i.id)).toEqual(['cid-6', 'cid-4']);
    expect(onlyExpired.next_cursor).toBe('2');
    expect(onlyExpired.total_estimate).toBe(4);
  });

  it('renders the chosen option in the title when responded', () => {
    const { db } = makeStore();
    seed(db, [{ correlation_id: 'r1', question: 'Approve fix?' }]);
    db.prepare(
      `UPDATE decisions SET status='responded', responded_at=?, responded_by=?, chosen_option_id=?, response_reason=?
       WHERE correlation_id=?`,
    ).run('2026-05-20T10:01:00Z', 'operator', 'a', 'looks good', 'r1');
    const page = fetchDecisionsHistory({ db });
    expect(page.items[0].title).toBe('Approve fix? → Approve');
    expect(page.items[0].actor).toBe('operator');
    expect(page.items[0].status).toBe('success');
  });
});
