import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffBoms,
  writeParityLog,
  rotateParityLogs,
  parityReport,
  compareAndLog,
} from '../../src/steward/parity.js';
import type { ValidatedBOM } from '../../src/steward-agent/runtimes/types.js';

function bom(steps: Array<{ capability: string; risk: string; cost?: number }>, opts: { riskEnv?: string[]; cost?: number; dur?: number } = {}): ValidatedBOM {
  return {
    goal: 'g',
    steps: steps.map((s, i) => ({
      step_no: i + 1,
      title: `s${i}`,
      capability: s.capability as never,
      risk_class: s.risk as never,
      brick_id: 'b',
      model: 'm',
      cost_estimate: s.cost ?? 0.01,
      duration_sec_est: 1,
      depends_on: [],
    })),
    cost_estimate: opts.cost ?? 0.05,
    cost_max: 1,
    duration_sec_est: opts.dur ?? 30,
    risk_envelope: (opts.riskEnv ?? ['read-only']) as never,
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
  };
}

describe('v0.5 P5 — diffBoms structural parity', () => {
  it('verdict=identical when BOMs match on all comparable fields', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }, { capability: 'simple-summary', risk: 'read-only' }]);
    const b = bom([{ capability: 'reading', risk: 'read-only' }, { capability: 'simple-summary', risk: 'read-only' }]);
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('identical');
    expect(d.hard_fail_reasons).toEqual([]);
    expect(d.soft_warn_reasons).toEqual([]);
  });

  it('verdict=hard-fail when step count differs', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }]);
    const b = bom([{ capability: 'reading', risk: 'read-only' }, { capability: 'reading', risk: 'read-only' }]);
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('hard-fail');
    expect(d.hard_fail_reasons.some((r) => r.includes('step count'))).toBe(true);
  });

  it('verdict=hard-fail when capability sequence diverges (same count)', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }, { capability: 'simple-summary', risk: 'read-only' }]);
    const b = bom([{ capability: 'simple-summary', risk: 'read-only' }, { capability: 'reading', risk: 'read-only' }]);
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('hard-fail');
    expect(d.hard_fail_reasons.some((r) => r.includes('capability'))).toBe(true);
  });

  it('verdict=hard-fail when risk envelope diverges', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }], { riskEnv: ['read-only'] });
    const b = bom([{ capability: 'reading', risk: 'read-only' }], { riskEnv: ['write-local'] });
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('hard-fail');
    expect(d.hard_fail_reasons.some((r) => r.includes('risk envelope'))).toBe(true);
  });

  it('verdict=soft-warn when cost outside ±15% but structure matches', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }], { cost: 1.0 });
    const b = bom([{ capability: 'reading', risk: 'read-only' }], { cost: 2.0 }); // 100% off
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('soft-warn');
    expect(d.soft_warn_reasons.some((r) => r.includes('cost'))).toBe(true);
    expect(d.hard_fail_reasons).toEqual([]);
  });

  it('cost within ±15% does not warn', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }], { cost: 1.0 });
    const b = bom([{ capability: 'reading', risk: 'read-only' }], { cost: 1.10 });
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('identical');
    expect(d.soft_warn_reasons).toEqual([]);
  });

  it('parity-ok when fields equal but step bricks differ', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }]);
    const b: ValidatedBOM = {
      ...bom([{ capability: 'reading', risk: 'read-only' }]),
      steps: [{
        step_no: 1, title: 's0', capability: 'reading' as never, risk_class: 'read-only' as never,
        brick_id: 'OTHER-BRICK', model: 'm', cost_estimate: 0.01, duration_sec_est: 1, depends_on: [],
      }],
    };
    const d = diffBoms(a, b);
    expect(d.verdict).toBe('parity-ok'); // not identical (brick differs) but no fails
  });
});

describe('v0.5 P5 — parity log writer + rotation + report', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stavr-p5-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('writeParityLog writes a JSON entry under dir', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }]);
    const b = bom([{ capability: 'reading', risk: 'read-only' }]);
    const d = diffBoms(a, b);
    const path = writeParityLog({
      bom_id: 'bom-123',
      at: '2026-05-17T13:00:00.000Z',
      in_process_runtime: 'anthropic',
      subprocess_runtime: 'anthropic',
      diff: d,
    }, { dir });
    expect(path).toContain('bom-123.json');
    const files = readdirSync(dir);
    expect(files).toContain('bom-123.json');
  });

  it('rotation trims oldest files past `keep` threshold', () => {
    // Write 5 entries with manipulated mtimes
    const baseAt = Date.now();
    for (let i = 0; i < 5; i++) {
      writeParityLog({
        bom_id: `bom-${i}`,
        at: new Date(baseAt + i).toISOString(),
        in_process_runtime: 'a',
        subprocess_runtime: 'b',
        diff: diffBoms(bom([{ capability: 'reading', risk: 'read-only' }]), bom([{ capability: 'reading', risk: 'read-only' }])),
      }, { dir, keep: 1000 });
      // Backdate so order is deterministic
      const t = (baseAt + i * 1000) / 1000;
      utimesSync(join(dir, `bom-${i}.json`), t, t);
    }
    expect(readdirSync(dir)).toHaveLength(5);
    const removed = rotateParityLogs({ dir, keep: 2 });
    expect(removed).toBe(3);
    const remaining = readdirSync(dir);
    expect(remaining).toHaveLength(2);
    // Newest two preserved.
    expect(remaining.sort()).toEqual(['bom-3.json', 'bom-4.json']);
  });

  it('parityReport aggregates verdicts and computes structural_parity_pct', () => {
    // 3 identical, 1 soft-warn, 1 hard-fail → 4/5 passing = 80%
    const okBom = bom([{ capability: 'reading', risk: 'read-only' }]);
    for (let i = 0; i < 3; i++) {
      writeParityLog({
        bom_id: `id-${i}`,
        at: new Date().toISOString(),
        in_process_runtime: 'a', subprocess_runtime: 'b',
        diff: diffBoms(okBom, okBom),
      }, { dir });
    }
    writeParityLog({
      bom_id: 'soft', at: new Date().toISOString(),
      in_process_runtime: 'a', subprocess_runtime: 'b',
      diff: diffBoms(bom([{ capability: 'reading', risk: 'read-only' }], { cost: 1 }), bom([{ capability: 'reading', risk: 'read-only' }], { cost: 5 })),
    }, { dir });
    writeParityLog({
      bom_id: 'hard', at: new Date().toISOString(),
      in_process_runtime: 'a', subprocess_runtime: 'b',
      diff: diffBoms(okBom, bom([{ capability: 'reading', risk: 'read-only' }, { capability: 'reading', risk: 'read-only' }])),
    }, { dir });
    const r = parityReport({ dir });
    expect(r.total).toBe(5);
    expect(r.identical).toBe(3);
    expect(r.soft_warn).toBe(1);
    expect(r.hard_fail).toBe(1);
    expect(r.structural_parity_pct).toBe(80);
  });

  it('compareAndLog returns path + diff and persists the file', async () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }]);
    const b = bom([{ capability: 'reading', risk: 'read-only' }]);
    const result = await compareAndLog({
      bomId: 'integration-1',
      inProcess: a,
      subprocess: b,
      inProcessRuntime: 'anthropic',
      subprocessRuntime: 'anthropic',
      dir,
    });
    expect(result.diff.verdict).toBe('identical');
    expect(readdirSync(dir)).toContain('integration-1.json');
  });

  it('parityReport on empty dir returns zero totals', () => {
    const r = parityReport({ dir });
    expect(r.total).toBe(0);
    expect(r.structural_parity_pct).toBe(0);
  });

  it('bom_id with unsafe chars gets sanitized in the filename', () => {
    const a = bom([{ capability: 'reading', risk: 'read-only' }]);
    const path = writeParityLog({
      bom_id: 'bom/../escape?weird',
      at: new Date().toISOString(),
      in_process_runtime: 'a', subprocess_runtime: 'b',
      diff: diffBoms(a, a),
    }, { dir });
    expect(path).not.toContain('/..');
    expect(path).not.toContain('?');
    expect(readdirSync(dir).some((f) => f.includes('escape_weird'))).toBe(true);
  });
});
