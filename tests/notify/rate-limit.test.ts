import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/notify/rate-limit.js';

describe('v0.6 RateLimiter', () => {
  it('allows up to max in a window then blocks', () => {
    const r = new RateLimiter({ max: 3, windowMs: 60_000, now: () => 1_000 });
    expect(r.check('1.2.3.4')).toBe(true);
    expect(r.check('1.2.3.4')).toBe(true);
    expect(r.check('1.2.3.4')).toBe(true);
    expect(r.check('1.2.3.4')).toBe(false);
    expect(r.check('1.2.3.4')).toBe(false);
  });

  it('resets after the window expires', () => {
    let t = 0;
    const r = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect(r.check('a')).toBe(true);
    expect(r.check('a')).toBe(true);
    expect(r.check('a')).toBe(false);
    t = 1500;
    expect(r.check('a')).toBe(true);
  });

  it('isolates per-IP buckets', () => {
    const r = new RateLimiter({ max: 1, windowMs: 60_000, now: () => 1 });
    expect(r.check('a')).toBe(true);
    expect(r.check('a')).toBe(false);
    expect(r.check('b')).toBe(true);
    expect(r.check('b')).toBe(false);
  });

  it('default 30/min behaviour', () => {
    let t = 1000;
    const r = new RateLimiter({ now: () => t });
    for (let i = 0; i < 30; i++) {
      expect(r.check('x')).toBe(true);
    }
    expect(r.check('x')).toBe(false);
    t = 70_000;
    expect(r.check('x')).toBe(true);
  });

  it('sweeps stale buckets to bound memory', () => {
    let t = 0;
    const r = new RateLimiter({ max: 10, windowMs: 1000, now: () => t });
    r.check('a');
    r.check('b');
    expect(r.countFor('a')).toBe(1);
    t = 5000;
    // Touching any key triggers a sweep when the previous sweep is stale.
    r.check('c');
    expect(r.countFor('a')).toBe(0);
    expect(r.countFor('b')).toBe(0);
  });
});
