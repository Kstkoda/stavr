/**
 * Search helper for the History page. Pure function — case-insensitive
 * substring match over the rendered HistoryItem fields.
 *
 * v0.8 ships client-side search; the page already has the rows in
 * memory. Footgun #6 names a server-side LIKE path as a v0.8.1
 * candidate when result sets get slow.
 *
 * The fields searched mirror the BOM spec: decision titles, scope
 * titles, BOM filenames, commit subjects, host_exec command names —
 * which all land in HistoryItem.title.
 */
import type { HistoryItem } from './types.js';

export interface SearchOpts {
  /** Restricts to a specific kind. 'all' = no kind restriction. */
  tab?: string;
  /** Free-text query — case-insensitive substring match. */
  query?: string;
}

export function applyHistorySearch(
  items: HistoryItem[],
  opts: SearchOpts,
): HistoryItem[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const tab = opts.tab ?? 'all';
  if (q === '' && (tab === 'all' || !tab)) return items;
  return items.filter((it) => {
    if (tab !== 'all' && it.kind !== tab) return false;
    if (q === '') return true;
    if (it.title.toLowerCase().includes(q)) return true;
    if (it.actor.toLowerCase().includes(q)) return true;
    if (it.id.toLowerCase().includes(q)) return true;
    if (it.correlation_id && it.correlation_id.toLowerCase().includes(q)) return true;
    // The drawer's full record isn't searched here — v0.8 is title +
    // actor + ids. Operators who want richer search use the SQL CLI.
    return false;
  });
}
