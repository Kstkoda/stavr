/**
 * BOM-file history fetcher. Walks `proposed/*.md` on disk and surfaces
 * each markdown as a timeline row keyed by its file mtime. The dispatch
 * event (= the `boms` table row) is fetched separately via plans.ts; the
 * page's P4 walker joins the two by correlation_id when both are present.
 *
 * Robustness:
 *   - missing `proposed/` directory → empty page (no throw)
 *   - per-file stat() errors swallowed and logged via the placeholder
 *     mechanism; the row still renders so the operator sees "this BOM
 *     existed but is gone now" (BOM Footgun #4)
 *   - frontmatter parsing is best-effort; un-parseable files still show
 *     up with their filename as the title
 *
 * Optional cross-reference: when `db` is provided, we look up
 * `correlation_id` from a matching `boms.id` row by goal-text match.
 * This is heuristic — the canonical join key is the markdown filename
 * → bom.id (BOM dispatch sets bom.id from the filename slug). When no
 * match is found, the row still renders without a correlation_id.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Database } from '../../../db/index.js';
import {
  type HistoryItem,
  type HistoryPage,
  type HistoryQuery,
  nextCursor,
  normalizeQuery,
} from './types.js';

export interface BomsHistorySources {
  /** Absolute path to the BOM directory (typically `<repo>/proposed`). */
  bomsDir: string;
  /** Optional DB handle — when present, the fetcher cross-refs boms.id. */
  db?: Database;
}

export interface BomFilePayload {
  filename: string;
  abs_path: string;
  size_bytes: number;
  mtime: string;
  frontmatter: Record<string, string> | null;
  /** True if statSync threw → the row is a placeholder. */
  missing: boolean;
}

/**
 * Naive frontmatter parser — handles the YAML-ish `--- ... ---` block at
 * the top of a markdown file. Returns null when no frontmatter is present
 * or the block is malformed. We don't pull in a YAML lib because BOMs use
 * a flat `key: value` shape only.
 */
export function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---')) return null;
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l === '---');
  if (closeIdx < 1) return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function listBomFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function fileToItem(abs: string, db: Database | undefined): HistoryItem {
  const filename = basename(abs);
  // First read the file (we need frontmatter + title even when stat fails;
  // unlikely but defensive). If both fail we synthesize a missing-row.
  let content = '';
  let mtime: Date | null = null;
  let size = 0;
  let missing = false;
  try {
    const st = statSync(abs);
    mtime = st.mtime;
    size = st.size;
    content = readFileSync(abs, 'utf8');
  } catch {
    missing = true;
  }

  const frontmatter = content ? parseFrontmatter(content) : null;
  const title = frontmatter?.title
    ?? content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? filename.replace(/\.md$/, '');

  // Best-effort correlation lookup: match by bom.id == filename (the
  // dispatch path uses the slug as id). Fall back to no correlation_id.
  let correlation_id: string | undefined;
  if (db) {
    const slug = filename.replace(/\.md$/, '');
    try {
      const row = db
        .prepare(`SELECT correlation_id FROM boms WHERE id = ? LIMIT 1`)
        .get(slug) as { correlation_id: string } | undefined;
      if (row) correlation_id = row.correlation_id;
    } catch {
      // Schema mismatch or DB closed — silently drop the correlation hint.
    }
  }

  const payload: BomFilePayload = {
    filename,
    abs_path: abs,
    size_bytes: size,
    mtime: (mtime ?? new Date(0)).toISOString(),
    frontmatter,
    missing,
  };
  return {
    kind: 'bom-file',
    id: filename,
    at: payload.mtime,
    title,
    actor: frontmatter?.author ?? frontmatter?.requester ?? 'operator',
    correlation_id,
    status: missing ? 'failure' : 'success',
    payload,
  };
}

export function fetchBomsHistory(
  sources: BomsHistorySources,
  query: HistoryQuery = {},
): HistoryPage<HistoryItem> {
  const { since, until, limit, offset } = normalizeQuery(query);
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const untilMs = until ? Date.parse(until) : Infinity;

  const files = listBomFiles(sources.bomsDir);
  const items: HistoryItem[] = [];
  for (const abs of files) {
    const item = fileToItem(abs, sources.db);
    const tMs = Date.parse(item.at);
    if (Number.isFinite(tMs) && tMs >= sinceMs && tMs < untilMs) {
      items.push(item);
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    next_cursor: nextCursor(offset, limit, slice.length),
    total_estimate: total,
  };
}
