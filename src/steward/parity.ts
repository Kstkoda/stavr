// v0.5 P5 — Parity-shadow harness.
//
// Library-only: ships the measurement primitives + a writer for tmp/parity/.
// The daemon does NOT wire shadow mode in this phase — the cutover commit
// Kenneth lands separately is where the spawner's shadow path goes live in
// production. P5's job is "we can measure when it does."
//
// ADR-032 §Decision 7 + the v0.5 BOM §P5: structural parity is the gate (step
// count + kinds + risk envelope hard; cost ±15% soft, logged not gating).
// Byte-for-byte equality is not the gate (LLM determinism is hard).

import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../log.js';
import type { ValidatedBOM, PlannedStep } from '../steward-agent/runtimes/types.js';

export type ParityVerdict = 'identical' | 'parity-ok' | 'soft-warn' | 'hard-fail';

export interface ParityDiff {
  verdict: ParityVerdict;
  step_count: { in_process: number; subprocess: number; equal: boolean };
  capability_sequence: { in_process: string[]; subprocess: string[]; equal: boolean };
  risk_envelope: { in_process: string[]; subprocess: string[]; equal: boolean };
  cost_estimate: { in_process: number; subprocess: number; within_15pct: boolean };
  duration_sec_est: { in_process: number; subprocess: number; within_15pct: boolean };
  hard_fail_reasons: string[];
  soft_warn_reasons: string[];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function within15pct(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  if (base === 0) return true;
  return Math.abs(a - b) / base <= 0.15;
}

function capabilities(steps: PlannedStep[]): string[] {
  return steps.map((s) => s.capability);
}

/**
 * Compare two BOMs along the structural-parity axis. Hard-fail = different
 * step count, different capability sequence, or non-overlapping risk
 * envelope. Soft-warn = cost or duration outside ±15%. Identical = exact
 * match on all dimensions (rare; emitted as a separate verdict so callers
 * can distinguish "we drifted into agreement" from "we just got lucky").
 */
export function diffBoms(inProcess: ValidatedBOM, subprocess: ValidatedBOM): ParityDiff {
  const inSteps = inProcess.steps;
  const subSteps = subprocess.steps;
  const sameCount = inSteps.length === subSteps.length;
  const inCaps = capabilities(inSteps);
  const subCaps = capabilities(subSteps);
  const sameCaps = sameCount && inCaps.every((c, i) => c === subCaps[i]);
  const inRisk = [...inProcess.risk_envelope].sort();
  const subRisk = [...subprocess.risk_envelope].sort();
  const sameRisk = sameSet(inRisk, subRisk);
  const costClose = within15pct(inProcess.cost_estimate, subprocess.cost_estimate);
  const durClose = within15pct(inProcess.duration_sec_est, subprocess.duration_sec_est);

  const hard_fail_reasons: string[] = [];
  if (!sameCount) hard_fail_reasons.push(`step count ${inSteps.length} vs ${subSteps.length}`);
  if (!sameCaps && sameCount) hard_fail_reasons.push('capability sequence diverges');
  if (!sameRisk) hard_fail_reasons.push('risk envelope diverges');

  const soft_warn_reasons: string[] = [];
  if (!costClose) soft_warn_reasons.push(`cost estimate outside ±15%`);
  if (!durClose) soft_warn_reasons.push(`duration estimate outside ±15%`);

  let verdict: ParityVerdict;
  if (hard_fail_reasons.length > 0) verdict = 'hard-fail';
  else if (soft_warn_reasons.length > 0) verdict = 'soft-warn';
  else if (sameCaps && sameRisk && sameCount && costClose && durClose) {
    // Tighter check for byte-level identity on the comparable fields.
    const identical =
      JSON.stringify(inSteps.map(({ step_no, capability, risk_class, brick_id, model }) =>
        ({ step_no, capability, risk_class, brick_id, model }))) ===
      JSON.stringify(subSteps.map(({ step_no, capability, risk_class, brick_id, model }) =>
        ({ step_no, capability, risk_class, brick_id, model })));
    verdict = identical ? 'identical' : 'parity-ok';
  } else {
    verdict = 'parity-ok';
  }

  return {
    verdict,
    step_count: { in_process: inSteps.length, subprocess: subSteps.length, equal: sameCount },
    capability_sequence: { in_process: inCaps, subprocess: subCaps, equal: sameCaps },
    risk_envelope: { in_process: inRisk, subprocess: subRisk, equal: sameRisk },
    cost_estimate: { in_process: inProcess.cost_estimate, subprocess: subprocess.cost_estimate, within_15pct: costClose },
    duration_sec_est: { in_process: inProcess.duration_sec_est, subprocess: subprocess.duration_sec_est, within_15pct: durClose },
    hard_fail_reasons,
    soft_warn_reasons,
  };
}

export interface ParityLogEntry {
  bom_id: string;
  at: string;
  in_process_runtime: string;
  subprocess_runtime: string;
  diff: ParityDiff;
}

function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/steward/parity.ts or dist/steward/parity.js
  return resolve(here, '..', '..');
}

export interface ParityWriterOpts {
  /** Override the directory. Default tmp/parity/ under repo root. */
  dir?: string;
  /** Keep at most N log files; older are unlinked. Default 100. */
  keep?: number;
}

export function writeParityLog(entry: ParityLogEntry, opts: ParityWriterOpts = {}): string {
  const dir = opts.dir ?? join(findRepoRoot(), 'tmp', 'parity');
  mkdirSync(dir, { recursive: true });
  const safe = entry.bom_id.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = join(dir, `${safe}.json`);
  writeFileSync(path, JSON.stringify(entry, null, 2), 'utf8');
  rotateParityLogs({ dir, keep: opts.keep ?? 100 });
  return path;
}

export function rotateParityLogs(opts: { dir?: string; keep?: number } = {}): number {
  const dir = opts.dir ?? join(findRepoRoot(), 'tmp', 'parity');
  const keep = opts.keep ?? 100;
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length <= keep) return 0;
  const toRemove = files.slice(keep);
  let removed = 0;
  for (const f of toRemove) {
    try { unlinkSync(f.path); removed++; } catch { /* ignore */ }
  }
  return removed;
}

export interface ParityReport {
  total: number;
  identical: number;
  parity_ok: number;
  soft_warn: number;
  hard_fail: number;
  structural_parity_pct: number;
  most_recent_at?: string;
}

/**
 * Walk the parity log directory and aggregate verdicts. structural_parity_pct
 * counts identical + parity-ok + soft-warn as PASS; hard-fail is the only
 * non-pass. Cutover gate is left to the operator (Open Question §4 — lower
 * risk = manual flip).
 */
export function parityReport(opts: { dir?: string } = {}): ParityReport {
  const dir = opts.dir ?? join(findRepoRoot(), 'tmp', 'parity');
  if (!existsSync(dir)) {
    return { total: 0, identical: 0, parity_ok: 0, soft_warn: 0, hard_fail: 0, structural_parity_pct: 0 };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let identical = 0, parity_ok = 0, soft_warn = 0, hard_fail = 0;
  let mostRecent = '';
  for (const f of files) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ParityLogEntry;
      if (entry.at > mostRecent) mostRecent = entry.at;
      switch (entry.diff.verdict) {
        case 'identical': identical++; break;
        case 'parity-ok': parity_ok++; break;
        case 'soft-warn': soft_warn++; break;
        case 'hard-fail': hard_fail++; break;
      }
    } catch (err) {
      getLogger().warn('parity log unreadable, skipping', { file: f, error: (err as Error).message });
    }
  }
  const total = identical + parity_ok + soft_warn + hard_fail;
  const passing = identical + parity_ok + soft_warn;
  return {
    total,
    identical,
    parity_ok,
    soft_warn,
    hard_fail,
    structural_parity_pct: total === 0 ? 0 : (passing / total) * 100,
    most_recent_at: mostRecent || undefined,
  };
}

export interface ShadowAttachOpts {
  /** Subprocess handle to query. */
  requestPlan: (req: unknown) => Promise<unknown>;
  /** Captures the in-process BOM and the bom_id when the daemon fires. */
  onLiveBom: (bom: ValidatedBOM, bomId: string, ctx: unknown) => Promise<void>;
}

/**
 * Convenience adapter: given a live in-process BOM, request the subprocess to
 * plan the same context (shadow=true), diff the result, write the parity log.
 * Not wired into daemon.ts by P5 — the cutover commit is what enables it.
 *
 * Exported as a primitive so the cutover commit is a 1-line change.
 */
export async function compareAndLog(args: {
  bomId: string;
  inProcess: ValidatedBOM;
  subprocess: ValidatedBOM;
  inProcessRuntime: string;
  subprocessRuntime: string;
  dir?: string;
  keep?: number;
}): Promise<{ path: string; diff: ParityDiff }> {
  const diff = diffBoms(args.inProcess, args.subprocess);
  const entry: ParityLogEntry = {
    bom_id: args.bomId,
    at: new Date().toISOString(),
    in_process_runtime: args.inProcessRuntime,
    subprocess_runtime: args.subprocessRuntime,
    diff,
  };
  const path = writeParityLog(entry, { dir: args.dir, keep: args.keep });
  return { path, diff };
}
