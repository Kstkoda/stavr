/**
 * Spec 52 A2 — unit tests for the bearer-token auth gate (`checkBearerAuth`).
 *
 * This is the pure function the HTTP middleware delegates to. Testing it
 * directly avoids the integration headache of having to bind 0.0.0.0 from a
 * non-loopback IPv4 just to exercise the non-loopback branch.
 */
import { describe, expect, it } from 'vitest';
import { checkBearerAuth } from '../src/transports.js';
import { hashToken } from '../src/pairing.js';

const RAW_TOKEN = 'cafebabe'.repeat(6); // 48 hex chars, like generateDeviceToken()
const VALID_HASH = hashToken(RAW_TOKEN);
const DEVICE = { id: 'dev-1', name: 'laptop' };

function lookup(hash: string) {
  return hash === VALID_HASH ? DEVICE : undefined;
}

describe('checkBearerAuth', () => {
  it('allows public paths regardless of auth state', () => {
    for (const path of ['/healthz', '/pair/initiate', '/pair/complete']) {
      const v = checkBearerAuth({
        path,
        isLoopbackReq: false,
        authHeader: undefined,
        findActiveDevice: () => undefined,
      });
      expect(v.ok).toBe(true);
    }
  });

  it('allows loopback callers without a token', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: true,
      authHeader: undefined,
      findActiveDevice: () => undefined,
    });
    expect(v.ok).toBe(true);
  });

  it('refuses non-loopback with no Authorization header (401 missing_or_invalid_authorization)', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: undefined,
      findActiveDevice: lookup,
    });
    expect(v).toEqual({ ok: false, status: 401, error: 'missing_or_invalid_authorization' });
  });

  it('refuses non-loopback with a non-Bearer Authorization header', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: 'Basic abc:def',
      findActiveDevice: lookup,
    });
    expect(v).toEqual({ ok: false, status: 401, error: 'missing_or_invalid_authorization' });
  });

  it('refuses non-loopback with a Bearer token unknown to the device store (401 invalid_token)', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: 'Bearer wrongtoken',
      findActiveDevice: lookup,
    });
    expect(v).toEqual({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('allows non-loopback with a valid Bearer token + returns the device record', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: `Bearer ${RAW_TOKEN}`,
      findActiveDevice: lookup,
    });
    expect(v.ok).toBe(true);
    expect(v.ok && v.device).toEqual(DEVICE);
  });

  it('header parsing is case-insensitive on the Bearer keyword', () => {
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: `bearer ${RAW_TOKEN}`,
      findActiveDevice: lookup,
    });
    expect(v.ok).toBe(true);
  });

  it('a revoked-then-now-stale token presents as invalid_token (findActiveDevice returns undefined)', () => {
    // Simulating: device was paired, token is real, but the row's revoked_at
    // is set → findActiveDevice excludes it via its WHERE revoked_at IS NULL.
    const findActiveSkipsRevoked = (hash: string) =>
      hash === VALID_HASH ? undefined : undefined;
    const v = checkBearerAuth({
      path: '/status',
      isLoopbackReq: false,
      authHeader: `Bearer ${RAW_TOKEN}`,
      findActiveDevice: findActiveSkipsRevoked,
    });
    expect(v).toEqual({ ok: false, status: 401, error: 'invalid_token' });
  });
});
