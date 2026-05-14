/**
 * Unit tests for src/config.ts — spec 52 A1 (configurable bind + auth gate).
 *
 * Covers:
 *  - loadConfig() reads YAML, applies defaults, surfaces clear parse errors.
 *  - resolveBind() maps the symbolic specs (localhost|lan|tailscale) and
 *    explicit host[:port] into concrete listen targets.
 *  - checkBindAuthGate() centralises the refusal rule — defence-in-depth,
 *    invoked from both `stavr daemon start` and `mountTransports`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  checkBindAuthGate,
  defaultConfigPath,
  loadConfig,
  resolveBind,
} from '../src/config.js';

describe('loadConfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-config-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns DEFAULT_CONFIG when the file is missing', () => {
    const missing = join(tmp, 'nope.yaml');
    const r = loadConfig(missing);
    expect(r.source).toBe('defaults');
    expect(r.path).toBe(missing);
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });

  it('parses a complete YAML config', () => {
    const path = join(tmp, 'stavr.yaml');
    writeFileSync(
      path,
      'network:\n  bind: lan\n  require_auth_when_non_local: false\n',
      'utf8',
    );
    const r = loadConfig(path);
    expect(r.source).toBe('file');
    expect(r.config.network.bind).toBe('lan');
    expect(r.config.network.require_auth_when_non_local).toBe(false);
  });

  it('fills missing keys with defaults', () => {
    const path = join(tmp, 'stavr.yaml');
    writeFileSync(path, 'network:\n  bind: 192.168.1.10:7777\n', 'utf8');
    const r = loadConfig(path);
    expect(r.config.network.bind).toBe('192.168.1.10:7777');
    // require_auth_when_non_local should fall back to default true.
    expect(r.config.network.require_auth_when_non_local).toBe(true);
  });

  it('treats an empty file as defaults', () => {
    const path = join(tmp, 'stavr.yaml');
    writeFileSync(path, '', 'utf8');
    const r = loadConfig(path);
    expect(r.source).toBe('file');
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });

  it('surfaces a clear error on YAML parse failure', () => {
    const path = join(tmp, 'stavr.yaml');
    writeFileSync(path, 'network: { unterminated:', 'utf8');
    expect(() => loadConfig(path)).toThrow(/YAML parse error/);
  });

  it('surfaces a clear error on invalid schema (wrong type)', () => {
    const path = join(tmp, 'stavr.yaml');
    writeFileSync(
      path,
      'network:\n  bind: localhost\n  require_auth_when_non_local: "yes"\n',
      'utf8',
    );
    expect(() => loadConfig(path)).toThrow(/invalid config/);
  });

  it('defaultConfigPath honours STAVR_HOME', () => {
    const before = process.env.STAVR_HOME;
    try {
      process.env.STAVR_HOME = tmp;
      expect(defaultConfigPath()).toBe(join(tmp, 'stavr.yaml'));
    } finally {
      if (before === undefined) delete process.env.STAVR_HOME;
      else process.env.STAVR_HOME = before;
    }
  });
});

describe('resolveBind', () => {
  it("'localhost' resolves to 127.0.0.1 / loopback / mode=localhost", () => {
    const r = resolveBind('localhost');
    expect(r).toEqual({ host: '127.0.0.1', is_loopback: true, mode: 'localhost' });
  });

  it("'127.0.0.1' and '::1' both resolve as loopback", () => {
    expect(resolveBind('127.0.0.1').is_loopback).toBe(true);
    expect(resolveBind('::1').is_loopback).toBe(true);
  });

  it("'tailscale' resolves to a sentinel host (A3 placeholder)", () => {
    const r = resolveBind('tailscale');
    expect(r.mode).toBe('tailscale');
    expect(r.is_loopback).toBe(false);
  });

  it('explicit host parses host and port', () => {
    const r = resolveBind('192.168.1.10:7777');
    expect(r.host).toBe('192.168.1.10');
    expect(r.port).toBe(7777);
    expect(r.mode).toBe('explicit');
    expect(r.is_loopback).toBe(false);
  });

  it('explicit host without port works', () => {
    const r = resolveBind('192.168.1.10');
    expect(r.host).toBe('192.168.1.10');
    expect(r.port).toBeUndefined();
  });

  it('IPv6 bracketed host parses', () => {
    const r = resolveBind('[fe80::1]:7777');
    expect(r.host).toBe('fe80::1');
    expect(r.port).toBe(7777);
  });

  it("'0.0.0.0' is non-loopback explicit", () => {
    const r = resolveBind('0.0.0.0');
    expect(r.host).toBe('0.0.0.0');
    expect(r.is_loopback).toBe(false);
    expect(r.mode).toBe('explicit');
  });

  it("'lan' returns either a real IPv4 or a clear error", () => {
    // CI runners may or may not have a non-loopback IPv4. We assert one of two
    // outcomes — either we resolve to a real address, or we get the documented
    // refusal message. Both are correct behaviour per the spec.
    let hasLan = false;
    for (const list of Object.values(networkInterfaces())) {
      if (!list) continue;
      for (const i of list) {
        if (i.family === 'IPv4' && !i.internal) hasLan = true;
      }
    }
    if (hasLan) {
      const r = resolveBind('lan');
      expect(r.mode).toBe('lan');
      expect(r.is_loopback).toBe(false);
      expect(r.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    } else {
      expect(() => resolveBind('lan')).toThrow(/no non-loopback IPv4/);
    }
  });
});

describe('checkBindAuthGate', () => {
  it('allows loopback regardless of auth state', () => {
    const r = checkBindAuthGate({
      resolved: { host: '127.0.0.1', is_loopback: true, mode: 'localhost' },
      requireAuthWhenNonLocal: true,
      authConfigured: false,
    });
    expect(r).toBeNull();
  });

  it('refuses non-loopback without auth', () => {
    const r = checkBindAuthGate({
      resolved: { host: '192.168.1.10', is_loopback: false, mode: 'explicit' },
      requireAuthWhenNonLocal: true,
      authConfigured: false,
    });
    expect(r).toMatch(/refusing to bind non-local without auth/);
  });

  it('allows non-loopback when auth is configured', () => {
    expect(
      checkBindAuthGate({
        resolved: { host: '192.168.1.10', is_loopback: false, mode: 'explicit' },
        requireAuthWhenNonLocal: true,
        authConfigured: true,
      }),
    ).toBeNull();
  });

  it('allows non-loopback when require_auth_when_non_local is false (escape hatch)', () => {
    expect(
      checkBindAuthGate({
        resolved: { host: '0.0.0.0', is_loopback: false, mode: 'explicit' },
        requireAuthWhenNonLocal: false,
        authConfigured: false,
      }),
    ).toBeNull();
  });
});
