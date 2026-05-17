// v0.5 P4 — Probation harness scaffolding.
//
// ADR-032 §Decision 8: a new runtime (e.g., Grok3Runtime in v0.6) runs in
// shadow against live events for N (default 50) BOMs, comparing planned BOMs
// to the active runtime's output. Promotion requires correlation > 0.8.
//
// P4 ships the wiring. The actual correlation metric + the comparator are
// pluggable; the brief notes v0.6 is when this gets exercised.

import type { ValidatedBOM } from '../runtimes/types.js';

export interface ProbationRecord {
  bom_id: string;
  active_runtime: string;
  candidate_runtime: string;
  active_bom: ValidatedBOM;
  candidate_bom: ValidatedBOM | { __error: string };
  at: string;
}

export interface ProbationHandle {
  record(rec: Omit<ProbationRecord, 'at'>): void;
  /** Returns the last N records, newest first. */
  recent(n?: number): ProbationRecord[];
  /** Coarse correlation across structural fields. */
  correlation(): number;
  count(): number;
  stop(): void;
}

export interface ProbationOpts {
  candidateRuntimeName: string;
  /** Default 50 — promotion gate threshold. */
  windowSize?: number;
}

export function startProbation(opts: ProbationOpts): ProbationHandle {
  const window = opts.windowSize ?? 50;
  const records: ProbationRecord[] = [];

  return {
    record(rec) {
      records.push({ ...rec, at: new Date().toISOString() });
      if (records.length > window * 4) records.splice(0, records.length - window * 4);
    },
    recent(n = window) {
      return records.slice(-n).reverse();
    },
    correlation() {
      const recent = records.slice(-window);
      if (recent.length === 0) return 0;
      let agree = 0;
      for (const r of recent) {
        const cand = r.candidate_bom as ValidatedBOM | { __error?: string };
        if ('__error' in cand && cand.__error) continue;
        const a = r.active_bom;
        const b = cand as ValidatedBOM;
        const sameStepCount = a.steps.length === b.steps.length ? 1 : 0;
        const sameRisk = sameSet(
          a.risk_envelope.map(String),
          b.risk_envelope.map(String),
        )
          ? 1
          : 0;
        const sameKinds =
          a.steps.length === b.steps.length &&
          a.steps.every((s, i) => s.capability === b.steps[i]?.capability)
            ? 1
            : 0;
        agree += (sameStepCount + sameRisk + sameKinds) / 3;
      }
      return agree / recent.length;
    },
    count() { return records.length; },
    stop() { records.length = 0; },
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}
