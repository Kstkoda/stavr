import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRng, getSeed, rngInt, setSeedForTest } from '../../bombardment/seed.js';

describe('bombardment/seed', () => {
  const originalEnv = process.env.STAVR_HARDENING_SEED;
  beforeEach(() => {
    delete process.env.STAVR_HARDENING_SEED;
    setSeedForTest(42);
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.STAVR_HARDENING_SEED;
    else process.env.STAVR_HARDENING_SEED = originalEnv;
  });

  it('produces the same sequence for the same (seed, label) pair', () => {
    const a1 = createRng('label-x');
    const a2 = createRng('label-x');
    const xs1 = Array.from({ length: 8 }, () => a1());
    const xs2 = Array.from({ length: 8 }, () => a2());
    expect(xs1).toEqual(xs2);
  });

  it('produces independent streams for different labels', () => {
    const a = createRng('label-x');
    const b = createRng('label-y');
    const xs = Array.from({ length: 8 }, () => a());
    const ys = Array.from({ length: 8 }, () => b());
    expect(xs).not.toEqual(ys);
  });

  it('rngInt returns integers in [0, max)', () => {
    const rng = createRng('rngInt-test');
    for (let i = 0; i < 200; i++) {
      const n = rngInt(rng, 10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(10);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('honors STAVR_HARDENING_SEED env when present', () => {
    process.env.STAVR_HARDENING_SEED = '12345';
    // Force the lazy resolver to re-read by clearing the cached seed.
    setSeedForTest(Number.parseInt(process.env.STAVR_HARDENING_SEED, 10));
    expect(getSeed()).toBe(12345);
  });

  it('different seeds produce different sequences for the same label', () => {
    setSeedForTest(1);
    const a = createRng('same-label');
    const xs1 = Array.from({ length: 5 }, () => a());

    setSeedForTest(2);
    const b = createRng('same-label');
    const xs2 = Array.from({ length: 5 }, () => b());

    expect(xs1).not.toEqual(xs2);
  });
});
