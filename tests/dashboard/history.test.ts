/**
 * /dashboard/history page tests — render shape + integration via the
 * shell. Mirrors tests/dashboard/decide.test.ts in structure.
 */
import { describe, expect, it } from 'vitest';
import { renderHistoryPage } from '../../src/dashboard/pages/history.js';
import { NAV_ENTRIES, renderShell } from '../../src/dashboard/shell.js';
import type { HistoryItem } from '../../src/dashboard/data/history/types.js';
import { renderHistoryRow, HISTORY_TAB_ORDER } from '../../src/dashboard/components/timeline-row.js';
import { resolveRange } from '../../src/dashboard/components/range-picker.js';

function item(over: Partial<HistoryItem>): HistoryItem {
  return {
    kind: over.kind ?? 'decision',
    id: over.id ?? 'id-1',
    at: over.at ?? '2026-05-20T10:00:00Z',
    title: over.title ?? 'A title',
    actor: over.actor ?? 'operator',
    correlation_id: over.correlation_id,
    status: over.status ?? 'success',
    source_url: over.source_url,
    payload: over.payload,
  };
}

describe('renderHistoryPage', () => {
  it('renders the shell + page-head + empty state when there are no items', () => {
    const html = renderHistoryPage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1 class="page-title">History</h1>');
    expect(html).toContain('No history in this range.');
    // Active nav highlight.
    expect(html).toMatch(/data-page="history"\s+aria-current="page"/);
  });

  it('renders one row per item with kind icons + halo for status', () => {
    const html = renderHistoryPage({
      items: [
        item({ kind: 'decision', id: 'd1', status: 'success' }),
        item({ kind: 'commit',   id: 'c1', status: 'failure', source_url: 'https://github.com/x/y/commit/abc' }),
        item({ kind: 'notification', id: 'n1', correlation_id: 'cid-1', actor: 'steward-agent' }),
      ],
      total_estimate: 3,
      has_more: false,
    });
    expect(html).toContain('data-kind="decision"');
    expect(html).toContain('data-kind="commit"');
    expect(html).toContain('data-kind="notification"');
    expect(html).toContain('data-halo="ok"');
    expect(html).toContain('data-halo="crit"');
    // External link on the commit row.
    expect(html).toContain('github.com/x/y/commit/abc');
    expect(html).toContain('rel="noopener noreferrer"');
    // Source-agent badge appears on notifications only.
    expect(html).toContain('[steward-agent]');
  });

  it('exposes a "Load more" button when has_more is true', () => {
    const html = renderHistoryPage({
      items: [item({})],
      total_estimate: 200,
      has_more: true,
    });
    expect(html).toContain('data-role="load-more"');
    expect(html).toContain('Load more');
  });

  it('renders one tab per HistoryKind in HISTORY_TAB_ORDER', () => {
    const html = renderHistoryPage();
    for (const id of HISTORY_TAB_ORDER) {
      expect(html).toContain(`data-tab="${id}"`);
    }
    expect(html).toContain('data-tab="all"');
  });

  it('renders the pruned-history hint when pruned_boundary is set', () => {
    const html = renderHistoryPage({ items: [], total_estimate: 0, has_more: false, pruned_boundary: true });
    expect(html).toContain('Earlier history pruned');
  });
});

describe('renderHistoryRow', () => {
  it('renders source-link wing only when source_url is set', () => {
    expect(renderHistoryRow(item({}))).not.toContain('Open Decision source');
    const withUrl = renderHistoryRow(item({ source_url: 'https://x.test' }));
    expect(withUrl).toContain('href="https://x.test"');
  });

  it('renders a trace-open button only when correlation_id is set', () => {
    expect(renderHistoryRow(item({ correlation_id: undefined }))).not.toContain('data-role="open-trace"');
    expect(renderHistoryRow(item({ correlation_id: 'cid-1' }))).toContain('data-role="open-trace"');
  });
});

describe('resolveRange', () => {
  it('returns last 24h for 24h preset', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    const r = resolveRange('24h', now);
    expect(r.until).toBe('2026-05-20T12:00:00.000Z');
    expect(r.since).toBe('2026-05-19T12:00:00.000Z');
  });

  it('returns last 7d for 7d preset', () => {
    const now = new Date('2026-05-20T12:00:00Z');
    const r = resolveRange('7d', now);
    expect(r.since).toBe('2026-05-13T12:00:00.000Z');
  });
});

describe('shell — history is in the nav', () => {
  it('NAV_ENTRIES includes the history entry', () => {
    const ids = NAV_ENTRIES.map((n) => n.id);
    expect(ids).toContain('history');
  });

  it('renderShell with activePage=history marks the right tab', () => {
    const html = renderShell({ title: 't', activePage: 'history', body: '<x>' });
    expect(html).toMatch(/data-page="history"\s+aria-current="page"/);
  });
});
