/**
 * Unit tests for src/pairing.ts and src/devices-storage.ts (spec 52 A2).
 *
 * The pairing primitives and the file-backed device store are pure modules;
 * we cover them independently from the HTTP transport. The end-to-end flow
 * (CLI → daemon → CLI) is exercised by tests/federation/pairing.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_CODE_LEN,
  PAIRING_CODE_TTL_MS,
  PendingPairingRegistry,
  constantTimeEqual,
  generateDeviceToken,
  generatePairingCode,
  hashToken,
} from '../src/pairing.js';
import {
  devicesFilePath,
  findPairingByDaemon,
  listPairings,
  loadDevicesFile,
  upsertPairing,
} from '../src/devices-storage.js';

describe('pairing primitives', () => {
  it('generatePairingCode returns a 6-digit zero-padded numeric string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(PAIRING_CODE_LEN);
    }
  });

  it('generateDeviceToken returns 48 hex chars (24 bytes)', () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('hashToken produces a stable 64-char SHA256 hex digest', () => {
    const a = hashToken('abc');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(a);
    expect(hashToken('abd')).not.toBe(a);
  });

  it('constantTimeEqual returns true only when both inputs equal', () => {
    expect(constantTimeEqual('123456', '123456')).toBe(true);
    expect(constantTimeEqual('123456', '123457')).toBe(false);
    // Length mismatch must not throw (timingSafeEqual is strict on length).
    expect(constantTimeEqual('123456', '1234567')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('PendingPairingRegistry', () => {
  let reg: PendingPairingRegistry;

  beforeEach(() => {
    reg = new PendingPairingRegistry();
  });

  it('open() returns a valid code and stores it as pending', () => {
    const p = reg.open(1_000);
    expect(p.code).toMatch(/^\d{6}$/);
    expect(p.expires_at).toBe(1_000 + PAIRING_CODE_TTL_MS);
    expect(reg.size(1)).toBe(1);
  });

  it('consume() with a valid code returns the pairing and removes it (single-use)', () => {
    const p = reg.open(0);
    const consumed = reg.consume(p.code, 1_000);
    expect(consumed?.code).toBe(p.code);
    expect(reg.consume(p.code, 1_000)).toBeUndefined();
    expect(reg.size(1_000)).toBe(0);
  });

  it('consume() returns undefined for unknown codes', () => {
    reg.open(0);
    expect(reg.consume('999999', 1_000)).toBeUndefined();
  });

  it('consume() returns undefined for expired codes (TTL exceeded)', () => {
    const p = reg.open(0);
    const past = PAIRING_CODE_TTL_MS + 1;
    expect(reg.consume(p.code, past)).toBeUndefined();
  });

  it('gc sweeps expired entries when size() advances past the TTL', () => {
    reg.open(0);
    reg.open(0);
    expect(reg.size(100)).toBe(2);
    // Past the TTL, both windows sweep.
    const past = PAIRING_CODE_TTL_MS + 1;
    expect(reg.size(past)).toBe(0);
  });

  it('multiple concurrent windows can be open and only the matched one is consumed', () => {
    const a = reg.open(0);
    const b = reg.open(0);
    expect(reg.size(100)).toBe(2);
    expect(reg.consume(a.code, 100)?.code).toBe(a.code);
    expect(reg.size(100)).toBe(1);
    expect(reg.consume(b.code, 100)?.code).toBe(b.code);
    expect(reg.size(100)).toBe(0);
  });
});

describe('devices-storage (file-backed pairing store)', () => {
  let tmp: string;
  let devicesPath: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cowire-devices-'));
    devicesPath = join(tmp, 'devices.json');
    savedEnv = process.env.COWIRE_HOME;
    process.env.COWIRE_HOME = tmp;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.COWIRE_HOME;
    else process.env.COWIRE_HOME = savedEnv;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns an empty schema when the file is missing', () => {
    const file = loadDevicesFile(devicesPath);
    expect(file).toEqual({ version: 1, pairings: [] });
  });

  it('devicesFilePath honours COWIRE_HOME', () => {
    expect(devicesFilePath()).toBe(join(tmp, 'devices.json'));
  });

  it('upsertPairing persists a pairing and reads it back', () => {
    const pairing = {
      daemon_url: 'http://nas.local:7777',
      device_id: 'dev-1',
      device_name: 'laptop',
      token: 'sekrit',
      paired_at: '2026-05-13T00:00:00.000Z',
    };
    upsertPairing(pairing, devicesPath);
    const list = listPairings(devicesPath);
    expect(list).toEqual([pairing]);
    const found = findPairingByDaemon('http://nas.local:7777', devicesPath);
    expect(found).toEqual(pairing);
  });

  it('upsertPairing replaces an existing (daemon_url, device_id) row', () => {
    const a = {
      daemon_url: 'http://nas.local:7777',
      device_id: 'dev-1',
      device_name: 'laptop',
      token: 'old',
      paired_at: '2026-05-13T00:00:00.000Z',
    };
    upsertPairing(a, devicesPath);
    upsertPairing({ ...a, token: 'new', paired_at: '2026-05-13T01:00:00.000Z' }, devicesPath);
    const list = listPairings(devicesPath);
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe('new');
  });

  it('two pairings to different daemons coexist', () => {
    upsertPairing(
      {
        daemon_url: 'http://nas-a:7777',
        device_id: 'dev-1',
        device_name: 'laptop',
        token: 'aa',
        paired_at: '2026-05-13T00:00:00.000Z',
      },
      devicesPath,
    );
    upsertPairing(
      {
        daemon_url: 'http://nas-b:7777',
        device_id: 'dev-2',
        device_name: 'laptop',
        token: 'bb',
        paired_at: '2026-05-13T01:00:00.000Z',
      },
      devicesPath,
    );
    expect(listPairings(devicesPath)).toHaveLength(2);
  });

  it('writes valid JSON to disk', () => {
    upsertPairing(
      {
        daemon_url: 'http://nas:7777',
        device_id: 'dev-1',
        device_name: 'laptop',
        token: 'tok',
        paired_at: '2026-05-13T00:00:00.000Z',
      },
      devicesPath,
    );
    const raw = readFileSync(devicesPath, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; pairings: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.pairings).toHaveLength(1);
  });

  it('throws a clear error on malformed file', () => {
    require('node:fs').writeFileSync(devicesPath, JSON.stringify({ version: 99 }));
    expect(() => loadDevicesFile(devicesPath)).toThrow(/malformed/);
  });
});
