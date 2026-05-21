/**
 * Phase 1 unit tests for src/types/host-ceiling.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_CEILING,
  HostCeilingSchema,
  validateHostCeilingCoherence,
} from '../../src/types/host-ceiling.js';

describe('HostCeilingSchema', () => {
  it('parses an empty object into the documented defaults', () => {
    const parsed = HostCeilingSchema.parse({});
    expect(parsed).toEqual(DEFAULT_HOST_CEILING);
  });

  it('rejects max_host_ram_pct > 1', () => {
    expect(() => HostCeilingSchema.parse({ max_host_ram_pct: 1.5 })).toThrow();
  });

  it('rejects negative min_free_ram_gb', () => {
    expect(() => HostCeilingSchema.parse({ min_free_ram_gb: -1 })).toThrow();
  });

  it('rejects max_concurrent_workers that is not an integer', () => {
    expect(() => HostCeilingSchema.parse({ max_concurrent_workers: 2.5 })).toThrow();
  });

  it('headroom_window_ms must be >= 1000', () => {
    expect(() => HostCeilingSchema.parse({ headroom_window_ms: 500 })).toThrow();
  });

  it('accepts a fully-specified valid block', () => {
    const parsed = HostCeilingSchema.parse({
      max_host_ram_pct: 0.6,
      min_free_ram_gb: 3,
      max_sustained_cpu_pct: 0.7,
      max_concurrent_workers: 8,
      headroom_window_ms: 30_000,
      shed_threshold_pct: 0.9,
      shed_min_free_ram_gb: 0.25,
      enabled: false,
    });
    expect(parsed.max_concurrent_workers).toBe(8);
    expect(parsed.enabled).toBe(false);
  });
});

describe('validateHostCeilingCoherence', () => {
  it('returns no errors for the defaults', () => {
    expect(validateHostCeilingCoherence(DEFAULT_HOST_CEILING)).toEqual([]);
  });

  it('flags shed_threshold_pct lower than max_host_ram_pct', () => {
    const errs = validateHostCeilingCoherence({
      ...DEFAULT_HOST_CEILING,
      max_host_ram_pct: 0.9,
      shed_threshold_pct: 0.8,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/shed_threshold_pct.*must be >=/);
  });

  it('flags shed_min_free_ram_gb higher than min_free_ram_gb', () => {
    const errs = validateHostCeilingCoherence({
      ...DEFAULT_HOST_CEILING,
      min_free_ram_gb: 1,
      shed_min_free_ram_gb: 2,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/shed_min_free_ram_gb.*must be <=/);
  });

  it('reports both errors together when both fail', () => {
    const errs = validateHostCeilingCoherence({
      ...DEFAULT_HOST_CEILING,
      max_host_ram_pct: 0.99,
      shed_threshold_pct: 0.5,
      min_free_ram_gb: 0.1,
      shed_min_free_ram_gb: 0.5,
    });
    expect(errs).toHaveLength(2);
  });
});
