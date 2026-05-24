/**
 * Bombardment Phase 2 — growth-shape assertions.
 *
 * Recon §5d gap: the current soak checks only the RSS ceiling. A genuine
 * leak that grows slowly enough to stay under the ceiling for the soak
 * window evades the assertion. The fix is to check the *shape* of the
 * growth, not just the peak:
 *
 *   - RSS slope (linear regression over samples): a healthy daemon under
 *     steady-state load has a near-zero slope after warmup. A persistent
 *     positive slope is a leak signature even when the ceiling holds.
 *
 *   - Baseline-return: at end of run, broker.sessionCount() and the
 *     SSE-tap gauge must return to where they started. (The
 *     no_orphan_sessions oracle covers the steady-state form; this
 *     helper computes the at-end form.)
 *
 *   - Per-class heap diff: take two heap snapshots, summarize the per-
 *     class object count delta. Wired up as a helper here; the soak
 *     consumes the snapshot pair and emits the top growers.
 *
 * No third-party deps — pure stdlib.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { writeHeapSnapshot } from 'node:v8';

export interface RssSample {
  /** Wall-clock millis since epoch. */
  tMs: number;
  /** Resident set size, bytes. */
  rssBytes: number;
}

export interface SlopeResult {
  /** Bytes-per-second over the samples. Positive = growth. */
  bytesPerSec: number;
  /** Number of samples used. */
  n: number;
  /** Total elapsed seconds covered. */
  elapsedSec: number;
  /** Total growth from first→last sample, bytes. */
  totalGrowthBytes: number;
}

/**
 * Linear-regression slope of `rssBytes` over `tMs`. Returns bytes-per-second.
 * Returns 0 for fewer than 3 samples (any single-pair slope is dominated
 * by GC noise; we need at least three points to be remotely meaningful).
 */
export function rssSlope(samples: RssSample[]): SlopeResult {
  if (samples.length < 3) {
    return { bytesPerSec: 0, n: samples.length, elapsedSec: 0, totalGrowthBytes: 0 };
  }
  const t0 = samples[0].tMs;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  const n = samples.length;
  for (const s of samples) {
    const x = (s.tMs - t0) / 1000; // seconds
    const y = s.rssBytes;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const elapsedSec = (samples[n - 1].tMs - t0) / 1000;
  const totalGrowthBytes = samples[n - 1].rssBytes - samples[0].rssBytes;
  return { bytesPerSec: slope, n, elapsedSec, totalGrowthBytes };
}

export interface BaselineReturnCheck {
  metric: string;
  baseline: number;
  current: number;
  slack: number;
  ok: boolean;
}

/**
 * Asserts a metric returned to its baseline value within `slack`. Slack
 * is additive, not multiplicative — for session counts we want strict
 * "≤ baseline + 2", not "≤ baseline × 1.5".
 */
export function baselineReturn(
  metric: string,
  baseline: number,
  current: number,
  slack: number,
): BaselineReturnCheck {
  return {
    metric,
    baseline,
    current,
    slack,
    ok: current <= baseline + slack,
  };
}

/**
 * Take a heap snapshot, parse it, and return per-constructor-name counts.
 * The .heapsnapshot file is a large JSON; we stream-parse the `nodes` +
 * `strings` arrays to compute counts without holding the whole graph.
 *
 * This is a coarse summary — full retention path analysis is out of
 * scope for the rig (operators load the snapshot in Chrome DevTools
 * for that). The goal here is to spot a class that grew 10× between
 * start and end, the leak-class signature.
 */
export interface PerClassCounts {
  [className: string]: number;
}

export function summarizeHeapSnapshot(path: string): PerClassCounts {
  const raw = readFileSync(path, 'utf8');
  const snap = JSON.parse(raw) as {
    snapshot: { meta: { node_fields: string[]; node_types: string[][] } };
    nodes: number[];
    strings: string[];
  };
  const fieldCount = snap.snapshot.meta.node_fields.length;
  const typeIdx = snap.snapshot.meta.node_fields.indexOf('type');
  const nameIdx = snap.snapshot.meta.node_fields.indexOf('name');
  const nodeTypes = snap.snapshot.meta.node_types[typeIdx];
  const counts: PerClassCounts = {};
  for (let i = 0; i < snap.nodes.length; i += fieldCount) {
    const t = snap.nodes[i + typeIdx];
    const nameStrIdx = snap.nodes[i + nameIdx];
    const typeName = nodeTypes[t] ?? `type${t}`;
    if (typeName !== 'object') continue; // class-name only meaningful for objects
    const cls = snap.strings[nameStrIdx] ?? '(unknown)';
    counts[cls] = (counts[cls] ?? 0) + 1;
  }
  return counts;
}

export interface ClassGrowth {
  className: string;
  before: number;
  after: number;
  delta: number;
  deltaPct: number;
}

/**
 * Diff two per-class snapshots. Returns top `topN` growers sorted by
 * absolute delta. A class missing from `before` counts as before=0.
 */
export function diffClassCounts(
  before: PerClassCounts,
  after: PerClassCounts,
  topN = 20,
): ClassGrowth[] {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rows: ClassGrowth[] = [];
  for (const className of all) {
    const b = before[className] ?? 0;
    const a = after[className] ?? 0;
    const delta = a - b;
    if (delta === 0) continue;
    const deltaPct = b === 0 ? Number.POSITIVE_INFINITY : (delta / b) * 100;
    rows.push({ className, before: b, after: a, delta, deltaPct });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return rows.slice(0, topN);
}

/**
 * Write a heap snapshot to disk and return the path. Convenience wrapper
 * — node:v8 already does the work, but the soak harness uses this to
 * keep the call-sites short.
 */
export function captureHeapSnapshot(path: string): string {
  writeHeapSnapshot(path);
  return path;
}

/** Persist a JSON summary of a per-class diff for CI artifact upload. */
export function writeHeapDiffSummary(path: string, growth: ClassGrowth[], extra: Record<string, unknown> = {}): void {
  writeFileSync(path, JSON.stringify({ ...extra, growth }, null, 2), 'utf8');
}
