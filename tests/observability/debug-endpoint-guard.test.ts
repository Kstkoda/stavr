import { describe, expect, it } from 'vitest';
import {
  isDebugEnabled,
  DEBUG_TOGGLE_MASTER,
  DEBUG_TOGGLE_HEAP,
} from '../../src/observability/debug-endpoints.js';

describe('isDebugEnabled — v0.4 runtime-toggle precedence', () => {
  it('env var alone gates the endpoint when no toggle reader is wired', () => {
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '1' })).toBe(true);
    expect(isDebugEnabled({})).toBe(false);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: 'true' })).toBe(true);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '0' })).toBe(false);
  });

  it('runtime toggle = "1" opens the gate even when the env var is unset', () => {
    const reader = (key: string) => (key === DEBUG_TOGGLE_MASTER ? '1' : null);
    expect(isDebugEnabled({}, reader)).toBe(true);
  });

  it('per-endpoint runtime toggle opens just that endpoint', () => {
    const reader = (key: string) => (key === DEBUG_TOGGLE_HEAP ? '1' : null);
    // Master off → check per-endpoint key passed in
    expect(isDebugEnabled({}, reader, DEBUG_TOGGLE_HEAP)).toBe(true);
    // Without a per-endpoint key the master read returns null → falls back
    // to env (also empty) → false.
    expect(isDebugEnabled({}, reader)).toBe(false);
  });

  it('env var stays a valid fallback when the toggle reader returns null', () => {
    const reader = () => null;
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '1' }, reader)).toBe(true);
    expect(isDebugEnabled({}, reader)).toBe(false);
  });

  it('master toggle "0" does NOT short-circuit the env-var fallback', () => {
    // A 0 in the runtime toggle is treated the same as "absent" — the env
    // can still open the gate. This keeps the env-var deployment path
    // working even if a stale "off" row exists in runtime_toggles.
    const reader = (key: string) => (key === DEBUG_TOGGLE_MASTER ? '0' : null);
    expect(isDebugEnabled({ STAVR_DEBUG_ENABLED: '1' }, reader)).toBe(true);
  });
});
