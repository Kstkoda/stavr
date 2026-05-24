/**
 * Bombardment Phase 1 — seeded RNG infrastructure.
 *
 * One `STAVR_HARDENING_SEED` (env, defaults to a fresh time-based seed
 * captured at module load) fans out to every workload + fault generator
 * via `createRng(label)`. Each label gets its own deterministic stream
 * derived from `seed XOR FNV1a(label)`, so two streams never collide
 * and the same label always produces the same sequence.
 *
 * Why bother (recon §7): today every soak / chaos run uses unseeded
 * Math.random() or wall-clock arrival times. When something fails, the
 * operator cannot reproduce the failure shape. Without reproducibility
 * the rig produces noise, not actionable findings.
 *
 * The RNG is mulberry32 — a small, fast, well-distributed 32-bit PRNG
 * that is more than adequate for workload jitter, mode selection, and
 * payload variance. Not cryptographic; the rig never needs that.
 *
 * Usage:
 *   import { getSeed, createRng } from '../seed.js';
 *   const rng = createRng('mcp_request:interval');
 *   const jitter = rng() * 100;  // [0, 100)
 *   const intN = Math.floor(rng() * n);
 */

/**
 * Resolved at module load. Captured once so concurrent callers see the
 * same value; mutated by tests via the `--seed` arg path.
 */
let _seed: number | null = null;

/** Read `STAVR_HARDENING_SEED` or fall back to a fresh wall-clock seed. */
function resolveSeed(): number {
  const env = process.env.STAVR_HARDENING_SEED;
  if (env !== undefined && env !== '') {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n)) return n >>> 0;
  }
  // Wall-clock seed when unspecified, but log it so a one-off failure
  // is still reproducible by re-exporting the seed.
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

export function getSeed(): number {
  if (_seed === null) {
    _seed = resolveSeed();
  }
  return _seed;
}

/** Test-only: pin the seed regardless of env. */
export function setSeedForTest(seed: number): void {
  _seed = seed >>> 0;
}

/** FNV-1a 32-bit hash of a string label — collision-resistant enough for stream derivation. */
function fnv1a(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — small fast 32-bit PRNG. Returns a function that yields
 * doubles in [0, 1). Same state → same sequence, by construction.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a deterministic RNG for `label`. The same `(seed, label)` pair
 * always produces the same sequence. Different labels share no state, so
 * a workload's jitter stream cannot drift the fault-injector's choices.
 */
export function createRng(label: string): () => number {
  const seed = getSeed();
  const streamSeed = (seed ^ fnv1a(label)) >>> 0;
  return mulberry32(streamSeed);
}

/**
 * Convenience: an integer in `[0, max)` from `rng`. The bombardment
 * workloads use this for mode selection + endpoint picking.
 */
export function rngInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}
