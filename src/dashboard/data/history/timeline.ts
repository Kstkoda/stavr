/**
 * Timeline merger. Fans out the same `HistoryQuery` to every source,
 * merges results, dedupes by `kind:id`, and sorts by `at` DESC.
 *
 * Dedupe semantics: when the same `correlation_id` appears across more
 * than one source (e.g., a BOM file + its boms-table row), both rows
 * stay. They're distinct artifacts even if they share a thread — the
 * P4 walker is what stitches them, not the merger. We only dedupe
 * exact (kind, id) pairs to defend against accidental double-emission.
 *
 * The merger does NOT call any fetcher itself — it accepts already-
 * paginated pages. This means the page controls which sources to fan
 * out for which tab (e.g., the "Notifications" tab skips the other 7
 * sources entirely) and the merger is just a kind-agnostic sort+dedupe.
 */
import { type HistoryItem, type HistoryPage, type HistoryQuery, nextCursor, normalizeQuery } from './types.js';

export interface TimelineInput {
  /** One paginated page from each source the caller wants represented. */
  pages: HistoryPage<HistoryItem>[];
}

/**
 * Merge multiple HistoryPages into one. The output `next_cursor` is the
 * max next-cursor across inputs (the caller will re-fan-out with that
 * offset to any source still producing rows). `total_estimate` is the
 * sum across sources — it's approximate, like every individual source's
 * estimate.
 */
export function mergeTimeline(input: TimelineInput, query: HistoryQuery = {}): HistoryPage<HistoryItem> {
  const { limit, offset } = normalizeQuery(query);
  const seen = new Set<string>();
  const all: HistoryItem[] = [];
  let totalEst = 0;
  let anySourceHasMore = false;

  for (const page of input.pages) {
    totalEst += page.total_estimate;
    if (page.next_cursor !== null) anySourceHasMore = true;
    for (const item of page.items) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(item);
    }
  }

  // Sort by ISO time DESC. ISO strings sort lex-equivalently to
  // chronologically, which is why fetchers normalize their times to ISO.
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const slice = all.slice(0, limit);
  const cursor = anySourceHasMore || all.length > limit
    ? nextCursor(offset, limit, limit)
    : null;
  return {
    items: slice,
    next_cursor: cursor,
    total_estimate: totalEst,
  };
}
