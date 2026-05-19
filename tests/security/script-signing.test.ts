import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetSigningCacheForTests,
  canonicalMessage,
  getOrCreateSigningKeys,
  sidecarPathFor,
  signingKeyPath,
  signWorkerScript,
  verifyWorkerScript,
  type ScriptSidecar,
} from '../../src/security/script-signing.js';

function writeScript(home: string, name: string, body: string): string {
  const dir = join(home, 'worker-scripts');
  if (!existsSync(dir)) {
    // ensure dir
    require('node:fs').mkdirSync(dir, { recursive: true });
  }
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('v0.6.7 P4 — script-signing', () => {
  let home: string;
  const SCRIPT_BODY = '# stavR worker script\necho hi\n';
  const WORKER_ID = 'w-test-1234';
  const CREATED_AT = '2026-05-19T05:00:00.000Z';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stavr-sig-test-'));
    _resetSigningCacheForTests();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    _resetSigningCacheForTests();
  });

  describe('getOrCreateSigningKeys', () => {
    it('generates a new key file on first use under <home>/keys/spawn-signing.key', () => {
      const path = signingKeyPath(home);
      expect(existsSync(path)).toBe(false);
      const keys = getOrCreateSigningKeys(home);
      expect(existsSync(path)).toBe(true);
      expect(keys.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
      const pem = readFileSync(path, 'utf8');
      expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
      // Unix only — Windows chmod is a no-op.
      if (process.platform !== 'win32') {
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('reuses the existing key file across calls and produces a stable fingerprint', () => {
      const a = getOrCreateSigningKeys(home);
      _resetSigningCacheForTests();
      const b = getOrCreateSigningKeys(home);
      expect(a.publicKeyFingerprint).toBe(b.publicKeyFingerprint);
    });

    it('different homes get different keys', () => {
      const a = getOrCreateSigningKeys(home);
      const home2 = mkdtempSync(join(tmpdir(), 'stavr-sig-test-'));
      try {
        _resetSigningCacheForTests();
        const b = getOrCreateSigningKeys(home2);
        expect(a.publicKeyFingerprint).not.toBe(b.publicKeyFingerprint);
      } finally {
        rmSync(home2, { recursive: true, force: true });
      }
    });
  });

  describe('canonicalMessage', () => {
    it('joins fields with pipe in fixed order', () => {
      expect(canonicalMessage('/p/s.ps1', 'abc123', 'w42', '2026-05-19T05:00:00Z')).toBe(
        '/p/s.ps1|abc123|w42|2026-05-19T05:00:00Z',
      );
    });
  });

  describe('signWorkerScript + verifyWorkerScript roundtrip', () => {
    it('signs a freshly-written script and verification succeeds', () => {
      const scriptPath = writeScript(home, 'roundtrip.ps1', SCRIPT_BODY);
      const sidecar = signWorkerScript({
        scriptPath,
        workerId: WORKER_ID,
        createdAt: CREATED_AT,
        home,
      });
      expect(sidecar.alg).toBe('ed25519');
      expect(sidecar.script_path).toBe(scriptPath);
      expect(sidecar.worker_id).toBe(WORKER_ID);
      expect(sidecar.created_at).toBe(CREATED_AT);
      expect(sidecar.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(existsSync(sidecarPathFor(scriptPath))).toBe(true);

      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(true);
    });

    it('sidecar is JSON-parseable with the documented shape', () => {
      const scriptPath = writeScript(home, 'shape.ps1', SCRIPT_BODY);
      signWorkerScript({ scriptPath, workerId: WORKER_ID, createdAt: CREATED_AT, home });
      const raw = readFileSync(sidecarPathFor(scriptPath), 'utf8');
      const parsed = JSON.parse(raw) as ScriptSidecar;
      expect(parsed.alg).toBe('ed25519');
      expect(parsed.script_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.pubkey_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('verifyWorkerScript failure modes', () => {
    function freshSigned(): string {
      const scriptPath = writeScript(home, 'fail.ps1', SCRIPT_BODY);
      signWorkerScript({ scriptPath, workerId: WORKER_ID, createdAt: CREATED_AT, home });
      return scriptPath;
    }

    it('reports sidecar_missing when the .sig file is absent', () => {
      const scriptPath = writeScript(home, 'no-sidecar.ps1', SCRIPT_BODY);
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('sidecar_missing');
    });

    it('reports sidecar_malformed when the .sig is not JSON', () => {
      const scriptPath = freshSigned();
      writeFileSync(sidecarPathFor(scriptPath), '{ not json');
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('sidecar_malformed');
    });

    it('reports script_hash_mismatch when the script body is tampered post-sign', () => {
      const scriptPath = freshSigned();
      writeFileSync(scriptPath, SCRIPT_BODY + '\nrm -rf /\n');
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('script_hash_mismatch');
    });

    it('reports worker_id_mismatch when verifier expects a different worker', () => {
      const scriptPath = freshSigned();
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: 'w-other',
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('worker_id_mismatch');
    });

    it('reports path_mismatch when the sidecar names a different script_path', () => {
      const scriptPath = freshSigned();
      const sidecar = JSON.parse(readFileSync(sidecarPathFor(scriptPath), 'utf8')) as ScriptSidecar;
      sidecar.script_path = '/tmp/somewhere-else.ps1';
      writeFileSync(sidecarPathFor(scriptPath), JSON.stringify(sidecar));
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('path_mismatch');
    });

    it('reports unsupported_alg when the sidecar names a non-ed25519 alg', () => {
      const scriptPath = freshSigned();
      const sidecar = JSON.parse(readFileSync(sidecarPathFor(scriptPath), 'utf8')) as ScriptSidecar;
      (sidecar as unknown as { alg: string }).alg = 'rsa';
      writeFileSync(sidecarPathFor(scriptPath), JSON.stringify(sidecar));
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_alg');
    });

    it('reports pubkey_mismatch when verifying with a different home (different key)', () => {
      const scriptPath = freshSigned();
      const otherHome = mkdtempSync(join(tmpdir(), 'stavr-sig-other-'));
      try {
        _resetSigningCacheForTests();
        const result = verifyWorkerScript({
          scriptPath,
          expectedWorkerId: WORKER_ID,
          home: otherHome,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('pubkey_mismatch');
      } finally {
        rmSync(otherHome, { recursive: true, force: true });
      }
    });

    it('reports signature_invalid when the signature bytes are flipped but hash/path/id/key all match', () => {
      const scriptPath = freshSigned();
      const sidecar = JSON.parse(readFileSync(sidecarPathFor(scriptPath), 'utf8')) as ScriptSidecar;
      // Flip the first byte of the signature.
      const sigBytes = Buffer.from(sidecar.signature, 'base64');
      sigBytes[0] = sigBytes[0] ^ 0xff;
      sidecar.signature = sigBytes.toString('base64');
      writeFileSync(sidecarPathFor(scriptPath), JSON.stringify(sidecar));
      const result = verifyWorkerScript({
        scriptPath,
        expectedWorkerId: WORKER_ID,
        home,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('signature_invalid');
    });
  });
});
