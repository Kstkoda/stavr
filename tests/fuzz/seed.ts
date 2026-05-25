/**
 * Phase 5 fuzz — seed shim. Reads STAVR_HARDENING_SEED (the same env
 * var that drives the bombardment rig's RNG, see bombardment/seed.ts)
 * and returns it as a fast-check seed. When unset, generates and
 * LOGS a fresh wall-clock seed so a one-off failure is reproducible
 * by re-exporting that seed.
 */
const _logged = new Set<string>();

export function fuzzSeed(label: string): number {
  const env = process.env.STAVR_HARDENING_SEED;
  if (env !== undefined && env !== '') {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n)) return n >>> 0;
  }
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  if (!_logged.has(label)) {
    _logged.add(label);
    // eslint-disable-next-line no-console
    console.log(`[fuzz:${label}] seed=${seed} (export STAVR_HARDENING_SEED=${seed} to reproduce)`);
  }
  return seed;
}

/** Default per-property run count — large enough to cover boundaries,
 * small enough to keep the suite under vitest's 15s budget per file. */
export const RUNS = Number(process.env.STAVR_FUZZ_RUNS ?? 200);
