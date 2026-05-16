import { describe, expect, it, beforeEach } from 'vitest';
import { EventStore } from '../../src/persistence.js';

describe('runtime_toggles — store layer', () => {
  let store: EventStore;
  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
  });

  it('round-trips a toggle without TTL', () => {
    const expires = store.setRuntimeToggle('STAVR_DEBUG_ENABLED', '1', 'dashboard');
    expect(expires).toBeNull();
    expect(store.getRuntimeToggle('STAVR_DEBUG_ENABLED')).toBe('1');
  });

  it('round-trips a toggle with a TTL and respects expiration on read', () => {
    const now = 1_000_000_000_000;
    const expires = store.setRuntimeToggle('STAVR_DEBUG_HEAP', '1', 'dashboard', 60, now);
    expect(expires).toBe(now + 60 * 60_000);
    expect(store.getRuntimeToggle('STAVR_DEBUG_HEAP', now)).toBe('1');
    expect(store.getRuntimeToggle('STAVR_DEBUG_HEAP', now + 60 * 60_000)).toBeNull();
    expect(store.getRuntimeToggle('STAVR_DEBUG_HEAP', now + 60 * 60_000 + 1)).toBeNull();
  });

  it('pruneExpiredRuntimeToggles returns + deletes only expired rows', () => {
    const now = 1_000_000_000_000;
    store.setRuntimeToggle('A', '1', 'dashboard', 1, now);            // expires at now + 60s
    store.setRuntimeToggle('B', '1', 'dashboard', 1000, now);         // expires far in the future
    store.setRuntimeToggle('C', '1', 'dashboard', undefined, now);    // never expires
    const evicted = store.pruneExpiredRuntimeToggles(now + 70_000);
    expect(evicted.sort()).toEqual(['A']);
    const remaining = store.listRuntimeToggles().map((t) => t.key).sort();
    expect(remaining).toEqual(['B', 'C']);
  });

  it('deleteRuntimeToggle returns true when a row was deleted', () => {
    store.setRuntimeToggle('X', '1', 'dashboard');
    expect(store.deleteRuntimeToggle('X')).toBe(true);
    expect(store.deleteRuntimeToggle('X')).toBe(false);
    expect(store.getRuntimeToggle('X')).toBeNull();
  });

  it('upserts: setting the same key twice overwrites + refreshes set_at', () => {
    store.setRuntimeToggle('K', '1', 'cli');
    store.setRuntimeToggle('K', '0', 'dashboard');
    const rows = store.listRuntimeToggles().filter((r) => r.key === 'K');
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('0');
    expect(rows[0].set_by).toBe('dashboard');
  });
});
