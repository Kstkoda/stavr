import { describe, expect, it } from 'vitest';
import { mergeTimeline } from '../../../../src/dashboard/data/history/timeline.js';
import type { HistoryItem, HistoryPage } from '../../../../src/dashboard/data/history/types.js';

function page(items: HistoryItem[], next: string | null = null, total = items.length): HistoryPage {
  return { items, next_cursor: next, total_estimate: total };
}

function item(over: Partial<HistoryItem>): HistoryItem {
  return {
    kind: over.kind ?? 'decision',
    id: over.id ?? 'id',
    at: over.at ?? '2026-05-20T10:00:00Z',
    title: over.title ?? 'title',
    actor: over.actor ?? 'operator',
    correlation_id: over.correlation_id,
    status: over.status,
    payload: over.payload,
  };
}

describe('mergeTimeline', () => {
  it('merges rows from multiple sources sorted by `at` DESC', () => {
    const merged = mergeTimeline({
      pages: [
        page([item({ kind: 'commit', id: 'a', at: '2026-05-20T08:00:00Z' })]),
        page([item({ kind: 'decision', id: 'b', at: '2026-05-20T10:00:00Z' })]),
        page([item({ kind: 'scope', id: 'c', at: '2026-05-20T09:00:00Z' })]),
      ],
    });
    expect(merged.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['decision:b', 'scope:c', 'commit:a']);
    expect(merged.total_estimate).toBe(3);
    expect(merged.next_cursor).toBeNull();
  });

  it('dedupes exact (kind, id) pairs across sources', () => {
    const merged = mergeTimeline({
      pages: [
        page([item({ kind: 'decision', id: 'a', at: '2026-05-20T10:00:00Z' })]),
        page([item({ kind: 'decision', id: 'a', at: '2026-05-20T10:00:00Z' })]),
        page([item({ kind: 'scope', id: 'a', at: '2026-05-20T09:00:00Z' })]),
      ],
    });
    expect(merged.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['decision:a', 'scope:a']);
  });

  it('returns a next_cursor when any source has more rows OR the merged result overflows the limit', () => {
    const merged = mergeTimeline(
      { pages: [page([item({ id: 'a' })], '100', 200)] },
      { limit: 1 },
    );
    expect(merged.next_cursor).not.toBeNull();
  });

  it('returns an empty page when all sources are empty', () => {
    const merged = mergeTimeline({ pages: [page([]), page([])] });
    expect(merged.items).toEqual([]);
    expect(merged.total_estimate).toBe(0);
    expect(merged.next_cursor).toBeNull();
  });
});
