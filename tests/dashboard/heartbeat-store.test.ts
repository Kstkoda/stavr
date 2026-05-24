import { describe, expect, it } from 'vitest';
import {
  createHeartbeatStore,
  validateHeartbeatBody,
  DEFAULT_STALENESS_MS,
  MAX_VERSION_LEN,
  MAX_RUST_LEN,
  ALLOWED_SIGNING,
} from '../../src/governor/heartbeat-store.js';

describe('governor-polish Cluster C — heartbeat store', () => {
  it('returns null before any heartbeat has been recorded', () => {
    const s = createHeartbeatStore();
    expect(s.current()).toBeNull();
  });

  it('round-trips a heartbeat while within the staleness window', () => {
    const s = createHeartbeatStore();
    const now = 1_000_000;
    s.record({ version: '0.6.11', signing: 'dev-signed', rust_version: '1.77.2' }, now);
    const fresh = s.current(DEFAULT_STALENESS_MS, now + 10_000);
    expect(fresh).toEqual({ version: '0.6.11', signing: 'dev-signed', rust_version: '1.77.2' });
  });

  it('expires the heartbeat once the staleness window passes', () => {
    const s = createHeartbeatStore();
    const t0 = 5_000_000;
    s.record({ version: '0.6.11' }, t0);
    expect(s.current(DEFAULT_STALENESS_MS, t0 + DEFAULT_STALENESS_MS)).not.toBeNull();
    expect(s.current(DEFAULT_STALENESS_MS, t0 + DEFAULT_STALENESS_MS + 1)).toBeNull();
  });

  it('the latest heartbeat overwrites the previous one', () => {
    const s = createHeartbeatStore();
    s.record({ version: '0.6.10' }, 1000);
    s.record({ version: '0.6.11', signing: 'cosign-signed' }, 2000);
    const cur = s.current(60_000, 2500);
    expect(cur?.version).toBe('0.6.11');
    expect(cur?.signing).toBe('cosign-signed');
  });

  it('reset() clears the held heartbeat', () => {
    const s = createHeartbeatStore();
    s.record({ version: '0.6.11' }, 1000);
    s.reset();
    expect(s.current(60_000, 1100)).toBeNull();
  });
});

describe('governor-polish Cluster C — validateHeartbeatBody', () => {
  it('accepts the minimal valid payload (version only)', () => {
    const r = validateHeartbeatBody({ version: '0.6.11' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ version: '0.6.11', signing: undefined, rust_version: undefined });
  });

  it('accepts the full payload with allowed signing values', () => {
    for (const signing of ALLOWED_SIGNING) {
      const r = validateHeartbeatBody({ version: '0.6.11', signing, rust_version: '1.77.2' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.signing).toBe(signing);
    }
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, undefined, 42, 'string', []]) {
      const r = validateHeartbeatBody(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects unknown fields (defence against prototype pollution / forward-compat drift)', () => {
    const r = validateHeartbeatBody({ version: '0.6.11', evil: 'payload' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown field/);
  });

  it('rejects missing or empty version', () => {
    expect(validateHeartbeatBody({}).ok).toBe(false);
    expect(validateHeartbeatBody({ version: '' }).ok).toBe(false);
    expect(validateHeartbeatBody({ version: 42 }).ok).toBe(false);
  });

  it('rejects oversized version', () => {
    const r = validateHeartbeatBody({ version: 'v'.repeat(MAX_VERSION_LEN + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version too long/);
  });

  it('rejects signing values outside the enum', () => {
    const r = validateHeartbeatBody({ version: '0.6.11', signing: 'malicious-tier' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signing must be one of/);
  });

  it('rejects oversized rust_version', () => {
    const r = validateHeartbeatBody({ version: '0.6.11', rust_version: 'r'.repeat(MAX_RUST_LEN + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rust_version too long/);
  });

  it('rejects non-string rust_version', () => {
    const r = validateHeartbeatBody({ version: '0.6.11', rust_version: 1.77 });
    expect(r.ok).toBe(false);
  });
});
