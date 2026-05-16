import { describe, expect, it } from 'vitest';
import { memoize, resolveDashboardCacheMs, resolveStreamsMaxEvents } from '../../src/dashboard/memo.js';

describe('memoize', () => {
  it('returns cached value within ttl, refreshes after', () => {
    let calls = 0;
    let now = 1000;
    const fn = memoize(
      () => {
        calls++;
        return calls;
      },
      100,
      { now: () => now },
    );

    expect(fn()).toBe(1);
    expect(fn()).toBe(1);
    expect(calls).toBe(1);
    now += 50;
    expect(fn()).toBe(1);
    now += 60;
    expect(fn()).toBe(2);
    expect(calls).toBe(2);
  });

  it('invalidate() forces a refresh on the next call', () => {
    let calls = 0;
    const fn = memoize(() => ++calls, 10_000);
    expect(fn()).toBe(1);
    expect(fn()).toBe(1);
    fn.invalidate();
    expect(fn()).toBe(2);
  });

  it('exposes isCached + lastRefreshAt', () => {
    let now = 5000;
    const fn = memoize(() => 'x', 100, { now: () => now });
    expect(fn.isCached()).toBe(false);
    expect(fn.lastRefreshAt()).toBeUndefined();
    fn();
    expect(fn.isCached()).toBe(true);
    expect(fn.lastRefreshAt()).toBe(5000);
  });
});

describe('resolveDashboardCacheMs', () => {
  it('uses fallback when env unset', () => {
    delete process.env.STAVR_DASHBOARD_CACHE_MS;
    expect(resolveDashboardCacheMs(2000)).toBe(2000);
  });
  it('reads numeric env override', () => {
    process.env.STAVR_DASHBOARD_CACHE_MS = '500';
    try {
      expect(resolveDashboardCacheMs(2000)).toBe(500);
    } finally {
      delete process.env.STAVR_DASHBOARD_CACHE_MS;
    }
  });
  it('rejects non-numeric env values, falls back', () => {
    process.env.STAVR_DASHBOARD_CACHE_MS = 'not-a-number';
    try {
      expect(resolveDashboardCacheMs(2000)).toBe(2000);
    } finally {
      delete process.env.STAVR_DASHBOARD_CACHE_MS;
    }
  });
});

describe('resolveStreamsMaxEvents', () => {
  it('uses fallback when env unset', () => {
    delete process.env.STAVR_STREAMS_MAX_EVENTS;
    expect(resolveStreamsMaxEvents(100)).toBe(100);
  });
  it('reads numeric env override', () => {
    process.env.STAVR_STREAMS_MAX_EVENTS = '50';
    try {
      expect(resolveStreamsMaxEvents(100)).toBe(50);
    } finally {
      delete process.env.STAVR_STREAMS_MAX_EVENTS;
    }
  });
  it('rejects zero / negative env values, falls back', () => {
    process.env.STAVR_STREAMS_MAX_EVENTS = '0';
    try {
      expect(resolveStreamsMaxEvents(100)).toBe(100);
    } finally {
      delete process.env.STAVR_STREAMS_MAX_EVENTS;
    }
  });
});
