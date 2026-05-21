import { describe, expect, it } from 'vitest';
import { fetchCiHistory, type CiRunInput } from '../../../../src/dashboard/data/history/ci.js';

function makeRun(over: Partial<CiRunInput>): CiRunInput {
  return {
    id: over.id ?? 'r1',
    name: over.name ?? 'CI',
    status: over.status ?? 'completed',
    conclusion: over.conclusion ?? 'success',
    created_at: over.created_at ?? '2026-05-20T10:00:00Z',
    html_url: over.html_url ?? 'https://github.com/x/y/actions/runs/1',
    head_sha: over.head_sha,
    actor: over.actor,
  };
}

describe('fetchCiHistory', () => {
  it('returns rows sorted by created_at DESC', () => {
    const runs = [
      makeRun({ id: 'a', created_at: '2026-05-20T08:00:00Z' }),
      makeRun({ id: 'b', created_at: '2026-05-20T10:00:00Z' }),
      makeRun({ id: 'c', created_at: '2026-05-20T09:00:00Z' }),
    ];
    const page = fetchCiHistory({ runs });
    expect(page.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns empty page when runs is empty', () => {
    expect(fetchCiHistory({ runs: [] }).items).toEqual([]);
  });

  it('maps status + conclusion to HistoryStatus and threads head_sha as correlation_id', () => {
    const runs = [
      makeRun({ id: 'ok',     conclusion: 'success', status: 'completed', head_sha: 'sha-1' }),
      makeRun({ id: 'fail',   conclusion: 'failure', status: 'completed', created_at: '2026-05-20T09:00:00Z' }),
      makeRun({ id: 'cancel', conclusion: 'cancelled', status: 'completed', created_at: '2026-05-20T08:00:00Z' }),
      makeRun({ id: 'open',   conclusion: null, status: 'in_progress',     created_at: '2026-05-20T07:00:00Z' }),
    ];
    const page = fetchCiHistory({ runs });
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get('ok')?.status).toBe('success');
    expect(byId.get('ok')?.correlation_id).toBe('sha-1');
    expect(byId.get('ok')?.source_url).toContain('actions/runs');
    expect(byId.get('fail')?.status).toBe('failure');
    expect(byId.get('cancel')?.status).toBe('cancelled');
    expect(byId.get('open')?.status).toBe('in-progress');
  });

  it('paginates + applies since/until', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun({ id: `r-${i}`, created_at: `2026-05-20T0${i}:00:00Z` }),
    );
    const page = fetchCiHistory({ runs }, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe('2');
    const ranged = fetchCiHistory(
      { runs },
      { since: '2026-05-20T02:00:00Z', until: '2026-05-20T05:00:00Z' },
    );
    expect(ranged.items.map((i) => i.id)).toEqual(['r-4', 'r-3', 'r-2']);
  });
});
