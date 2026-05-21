/**
 * P5 — search helper + page-side UI assertion (reset button + actor
 * filter present + localStorage key names baked into the JS).
 */
import { describe, expect, it } from 'vitest';
import { applyHistorySearch } from '../../src/dashboard/data/history/search.js';
import { renderHistoryPage } from '../../src/dashboard/pages/history.js';
import type { HistoryItem } from '../../src/dashboard/data/history/types.js';

function item(over: Partial<HistoryItem>): HistoryItem {
  return {
    kind: over.kind ?? 'decision',
    id: over.id ?? 'id-1',
    at: over.at ?? '2026-05-20T10:00:00Z',
    title: over.title ?? 'A title',
    actor: over.actor ?? 'operator',
    correlation_id: over.correlation_id,
    status: over.status,
  };
}

describe('applyHistorySearch', () => {
  it('returns input unchanged with empty query + all-tab', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })];
    expect(applyHistorySearch(items, {})).toEqual(items);
  });

  it('substring matches case-insensitively across title/actor/id/cid', () => {
    const items = [
      item({ id: 'a', title: 'Approve fix for VPN' }),
      item({ id: 'b', title: 'Deny scope grant', actor: 'cc' }),
      item({ id: 'c', correlation_id: 'cid-VpN-7' }),
    ];
    expect(applyHistorySearch(items, { query: 'vpn' }).map((i) => i.id)).toEqual(['a', 'c']);
    expect(applyHistorySearch(items, { query: 'cc' }).map((i) => i.id)).toEqual(['b']);
  });

  it('restricts to tab when set', () => {
    const items = [
      item({ kind: 'decision', id: 'a' }),
      item({ kind: 'commit',   id: 'b' }),
      item({ kind: 'decision', id: 'c' }),
    ];
    const r = applyHistorySearch(items, { tab: 'decision' });
    expect(r.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('combines tab + query (AND)', () => {
    const items = [
      item({ kind: 'decision', id: 'a', title: 'fix vpn' }),
      item({ kind: 'commit',   id: 'b', title: 'fix vpn' }),
      item({ kind: 'decision', id: 'c', title: 'unrelated' }),
    ];
    const r = applyHistorySearch(items, { tab: 'decision', query: 'vpn' });
    expect(r.map((i) => i.id)).toEqual(['a']);
  });
});

describe('renderHistoryPage — P5 controls', () => {
  it('exposes the search input, actor filter dropdown, and reset button', () => {
    const html = renderHistoryPage();
    expect(html).toContain('data-role="history-search"');
    expect(html).toContain('data-role="history-actor-filter"');
    expect(html).toContain('data-role="history-reset"');
  });

  it('bakes the canonical localStorage keys into the page JS', () => {
    const html = renderHistoryPage();
    expect(html).toContain('stavr.history.range');
    expect(html).toContain('stavr.history.tab');
    expect(html).toContain('stavr.history.search');
    expect(html).toContain('stavr.history.actor_filter');
  });

  it('search input is debounced (200ms timer reference in JS)', () => {
    const html = renderHistoryPage();
    expect(html).toContain('setTimeout(applyClientFilter, 200)');
  });
});
