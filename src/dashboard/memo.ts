/**
 * bom-oom-leak-hunt C2.2 — server-side memoization for the dashboard
 * fetch storm.
 *
 * Wraps a zero-arg, side-effect-free supplier in a single-slot cache
 * that's valid for ttlMs. Cache invalidation strategy: time-based only.
 * No LRU, no per-key bucketing — the hot paths we wrap (homeData,
 * streamsData) take no inputs.
 *
 * Concurrency is single-threaded JS, so we don't need a lock. The first
 * caller after expiry recomputes; concurrent callers within the same tick
 * see the stale value, but the next tick after expiry sees the fresh one.
 * That's fine — staleness is bounded to ttlMs (default 2s, env-configurable).
 *
 * Env override: STAVR_DASHBOARD_CACHE_MS — applied at memoize() call site
 * by the dashboard mount code, not here. This module is generic.
 */

export interface MemoizedFn<T> {
  (): T;
  /** Force a re-fetch on the next call. Test seam / shutdown hook. */
  invalidate(): void;
  /** Inspect cache state. Returns false until the first call. */
  isCached(): boolean;
  /** ms-resolution timestamp the cache was last refreshed. */
  lastRefreshAt(): number | undefined;
}

export interface MemoizeOpts {
  /** Defaults to () => Date.now(); test seam for controlling expiry. */
  now?: () => number;
}

export function memoize<T>(fn: () => T, ttlMs: number, opts: MemoizeOpts = {}): MemoizedFn<T> {
  const now = opts.now ?? (() => Date.now());
  let value: T | undefined;
  let expires = 0;
  let cached = false;
  let lastRefresh: number | undefined;

  const get = (() => {
    const t = now();
    if (!cached || t >= expires) {
      value = fn();
      expires = t + ttlMs;
      cached = true;
      lastRefresh = t;
    }
    return value as T;
  }) as MemoizedFn<T>;

  get.invalidate = () => {
    cached = false;
    expires = 0;
  };
  get.isCached = () => cached;
  get.lastRefreshAt = () => lastRefresh;
  return get;
}

/**
 * Resolve the dashboard cache TTL once at boot. The daemon calls this
 * when wiring the routes; tests pass through the raw memoize() above.
 */
export function resolveDashboardCacheMs(fallback = 2000): number {
  const raw = process.env.STAVR_DASHBOARD_CACHE_MS;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveStreamsMaxEvents(fallback = 100): number {
  const raw = process.env.STAVR_STREAMS_MAX_EVENTS;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
