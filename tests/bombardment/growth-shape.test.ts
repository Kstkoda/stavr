/**
 * Bombardment Phase 2 — growth-shape helper tests.
 *
 * Focus on the math (slope, baselineReturn, diffClassCounts). The
 * heap-snapshot summarizer is exercised end-to-end by the soak harness;
 * keep this file fast (no v8 calls).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineReturn, diffClassCounts, rssSlope, summarizeHeapSnapshot, HeapSnapshotTooLargeError } from '../../bombardment/observability/growth-shape.js';

describe('bombardment/observability/growth-shape', () => {
  describe('rssSlope', () => {
    it('returns zero slope for fewer than 3 samples', () => {
      const r = rssSlope([
        { tMs: 0, rssBytes: 100 },
        { tMs: 1000, rssBytes: 200 },
      ]);
      expect(r.bytesPerSec).toBe(0);
      expect(r.n).toBe(2);
    });

    it('recovers a positive slope from a clean linear series', () => {
      // 1 MB per 10 sec = 100,000 bytes/sec.
      const samples = [];
      for (let i = 0; i < 10; i++) {
        samples.push({ tMs: i * 1000, rssBytes: 1_000_000 + i * 100_000 });
      }
      const r = rssSlope(samples);
      expect(r.bytesPerSec).toBeCloseTo(100_000, 0);
      expect(r.n).toBe(10);
      expect(r.elapsedSec).toBe(9);
      expect(r.totalGrowthBytes).toBe(900_000);
    });

    it('returns near-zero slope for stable RSS', () => {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        // Stable with small noise.
        samples.push({ tMs: i * 1000, rssBytes: 1_000_000 + ((i % 3) - 1) * 1000 });
      }
      const r = rssSlope(samples);
      expect(Math.abs(r.bytesPerSec)).toBeLessThan(1000);
    });
  });

  describe('baselineReturn', () => {
    it('passes when current <= baseline + slack', () => {
      expect(baselineReturn('m', 5, 5, 2).ok).toBe(true);
      expect(baselineReturn('m', 5, 7, 2).ok).toBe(true);
      expect(baselineReturn('m', 5, 8, 2).ok).toBe(false);
    });
  });

  describe('diffClassCounts', () => {
    it('reports top growers sorted by absolute delta', () => {
      const before = { A: 10, B: 100, C: 5 };
      const after = { A: 50, B: 90, C: 5, D: 200 };
      const out = diffClassCounts(before, after, 10);
      expect(out[0].className).toBe('D');
      expect(out[0].delta).toBe(200);
      expect(out[1].className).toBe('A');
      expect(out[1].delta).toBe(40);
      expect(out[2].className).toBe('B');
      expect(out[2].delta).toBe(-10);
      // C unchanged — excluded.
      expect(out.some((r) => r.className === 'C')).toBe(false);
    });

    it('handles classes only in after (before=0) without div-by-zero', () => {
      const out = diffClassCounts({}, { Newcomer: 7 }, 5);
      expect(out[0].className).toBe('Newcomer');
      expect(out[0].before).toBe(0);
      expect(out[0].delta).toBe(7);
      expect(out[0].deltaPct).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('summarizeHeapSnapshot size guard', () => {
    it('throws HeapSnapshotTooLargeError without reading the file when it exceeds the ceiling', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bombardment-heap-guard-'));
      const path = join(dir, 'big.heapsnapshot');
      try {
        // Allocate a sparse-ish file slightly above the 150 MB ceiling.
        // Writing 200 MB of placeholder bytes is fast on tmpfs / NTFS and
        // exercises the statSync → ceiling path without forcing a 200 MB
        // string allocation (the guard short-circuits before readFileSync).
        const big = Buffer.alloc(200 * 1024 * 1024);
        writeFileSync(path, big);
        expect(() => summarizeHeapSnapshot(path)).toThrow(HeapSnapshotTooLargeError);
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* WAL/locks */ }
      }
    });
  });
});
