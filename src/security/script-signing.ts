// v0.6.7 P4 — Ed25519 spawn-script integrity guard.
//
// Every worker script written to `${STAVR_HOME}/worker-scripts/<id>.<ext>`
// gets a sidecar `<path>.sig` containing an Ed25519 signature over the
// canonical message `${script_path}|${script_sha256}|${worker_id}|${created_at}`.
// On spawn, the shell spawner re-verifies before invoking the script.
// If the script body, the sidecar, or the recorded worker_id is tampered
// with — or if the sidecar is missing — verification fails and the spawn
// is rejected via a `worker_blocked_by_signature` audit event.
//
// The signing key lives at `${STAVR_HOME}/keys/spawn-signing.key` (PKCS8
// PEM). It is stavR's own internal integrity key, NOT the operator's
// identity key — the two threat models are different. This key only
// guarantees "stavR's spawner wrote this script and it hasn't been
// modified since"; it does not bind to an operator. Generated lazily on
// first use with 0o600 permissions (NTFS user-only ACL on Windows).
//
// The signature gates spawn unconditionally — there is no opt-out env.
// Restart scenario: scripts written before this code shipped age out via
// the existing 7-day retention sweep, so a stale unsigned `.ps1` is
// either gone or refused (sidecar_missing). New spawns always sign.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { dirname, join } from 'node:path';
import { stavrHome } from '../config.js';

const KEY_DIR_NAME = 'keys';
const KEY_FILE_NAME = 'spawn-signing.key';
const SIDECAR_EXT = '.sig';
const SIG_ALG = 'ed25519' as const;

export interface SigningKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** First 16 hex chars of SHA-256(SPKI(publicKey)). Stable identity for
   *  this key without exposing the key itself; embedded in every sidecar
   *  so we can detect "verifier is on a different key than signer". */
  publicKeyFingerprint: string;
}

let cachedKeys: { home: string; keys: SigningKeyMaterial } | null = null;

/** Absolute path to the signing-key file under the given (or default)
 *  STAVR_HOME. Exposed for diagnostics + tests. */
export function signingKeyPath(home?: string): string {
  return join(home ?? stavrHome(), KEY_DIR_NAME, KEY_FILE_NAME);
}

/** Compute the sidecar `.sig` path for a given script file. */
export function sidecarPathFor(scriptPath: string): string {
  return scriptPath + SIDECAR_EXT;
}

/**
 * Load the signing key from disk, or generate + persist a new one if the
 * key file doesn't exist. The result is cached per-home so repeated
 * signs in the hot path don't re-read the PEM.
 */
export function getOrCreateSigningKeys(home?: string): SigningKeyMaterial {
  const resolvedHome = home ?? stavrHome();
  if (cachedKeys && cachedKeys.home === resolvedHome) return cachedKeys.keys;

  const path = signingKeyPath(resolvedHome);
  let pem: string;
  if (existsSync(path)) {
    pem = readFileSync(path, 'utf8');
  } else {
    ensureKeyDir(dirname(path));
    const { privateKey } = generateKeyPairSync(SIG_ALG);
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows: chmod is a no-op; NTFS user-only ACL covers us. */
    }
  }
  const privateKey = createPrivateKey({ key: pem, format: 'pem' });
  const publicKey = createPublicKey(privateKey);
  const publicKeyFingerprint = fingerprintOf(publicKey);
  const keys: SigningKeyMaterial = { privateKey, publicKey, publicKeyFingerprint };
  cachedKeys = { home: resolvedHome, keys };
  return keys;
}

/** Test helper — drops the in-process key cache so subsequent calls
 *  re-read disk. Production callers never need this. */
export function _resetSigningCacheForTests(): void {
  cachedKeys = null;
}

export interface ScriptSidecar {
  alg: 'ed25519';
  /** Absolute path the script lived at when signed. */
  script_path: string;
  /** SHA-256 of the script body at sign time (hex). */
  script_sha256: string;
  worker_id: string;
  /** ISO timestamp from the script's audit header. */
  created_at: string;
  /** Base64-encoded Ed25519 signature over the canonical message. */
  signature: string;
  /** SHA-256(SPKI(pubkey))[:16] — short fingerprint of the verifier key. */
  pubkey_fingerprint: string;
}

export interface SignInput {
  scriptPath: string;
  workerId: string;
  createdAt: string;
  /** Override STAVR_HOME (tests). */
  home?: string;
}

/**
 * Sign the script body at `input.scriptPath` and write a sidecar
 * `<path>.sig` next to it. Returns the sidecar object that was written.
 *
 * The signed message is `${script_path}|${script_sha256}|${worker_id}|${created_at}` —
 * binding the script's bytes, its location, its intended worker, and its
 * creation timestamp into a single non-malleable token.
 */
export function signWorkerScript(input: SignInput): ScriptSidecar {
  const { privateKey, publicKeyFingerprint } = getOrCreateSigningKeys(input.home);
  const body = readFileSync(input.scriptPath);
  const scriptSha256 = createHash('sha256').update(body).digest('hex');
  const message = canonicalMessage(input.scriptPath, scriptSha256, input.workerId, input.createdAt);
  const sigBuf = cryptoSign(null, Buffer.from(message, 'utf8'), privateKey);
  const sidecar: ScriptSidecar = {
    alg: SIG_ALG,
    script_path: input.scriptPath,
    script_sha256: scriptSha256,
    worker_id: input.workerId,
    created_at: input.createdAt,
    signature: sigBuf.toString('base64'),
    pubkey_fingerprint: publicKeyFingerprint,
  };
  const sidecarPath = sidecarPathFor(input.scriptPath);
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(sidecarPath, 0o600);
  } catch {
    /* Windows: ignore */
  }
  return sidecar;
}

export type VerifyFailureReason =
  | 'sidecar_missing'
  | 'sidecar_unreadable'
  | 'sidecar_malformed'
  | 'script_unreadable'
  | 'script_hash_mismatch'
  | 'worker_id_mismatch'
  | 'path_mismatch'
  | 'unsupported_alg'
  | 'signature_invalid'
  | 'pubkey_mismatch';

export interface VerifySuccess {
  ok: true;
  sidecar: ScriptSidecar;
}
export interface VerifyFailure {
  ok: false;
  reason: VerifyFailureReason;
  detail?: string;
}
export type VerifyResult = VerifySuccess | VerifyFailure;

export interface VerifyInput {
  scriptPath: string;
  expectedWorkerId: string;
  home?: string;
}

/**
 * Verify the sidecar at `<scriptPath>.sig` against the script body and
 * the in-process signing key. Returns a discriminated union — callers
 * must check `.ok` before trusting the script.
 *
 * Failure modes are enumerated so the audit event can carry a precise
 * reason. Each branch is intentionally a separate `reason` (rather than
 * one umbrella "invalid") because operators investigating an alert need
 * to know WHY: a missing sidecar is a different incident than a
 * tampered script body.
 */
export function verifyWorkerScript(input: VerifyInput): VerifyResult {
  const sidecarPath = sidecarPathFor(input.scriptPath);
  if (!existsSync(sidecarPath)) return { ok: false, reason: 'sidecar_missing' };
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'sidecar_unreadable', detail: (err as Error).message };
  }
  let sidecar: ScriptSidecar;
  try {
    sidecar = JSON.parse(raw) as ScriptSidecar;
  } catch (err) {
    return { ok: false, reason: 'sidecar_malformed', detail: (err as Error).message };
  }
  if (sidecar.alg !== SIG_ALG) {
    return { ok: false, reason: 'unsupported_alg', detail: String(sidecar.alg) };
  }
  if (sidecar.worker_id !== input.expectedWorkerId) {
    return {
      ok: false,
      reason: 'worker_id_mismatch',
      detail: `sidecar=${sidecar.worker_id} expected=${input.expectedWorkerId}`,
    };
  }
  if (sidecar.script_path !== input.scriptPath) {
    return {
      ok: false,
      reason: 'path_mismatch',
      detail: `sidecar=${sidecar.script_path} actual=${input.scriptPath}`,
    };
  }
  let body: Buffer;
  try {
    body = readFileSync(input.scriptPath);
  } catch (err) {
    return { ok: false, reason: 'script_unreadable', detail: (err as Error).message };
  }
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== sidecar.script_sha256) {
    return {
      ok: false,
      reason: 'script_hash_mismatch',
      detail: `actual=${sha.slice(0, 12)}… signed=${sidecar.script_sha256.slice(0, 12)}…`,
    };
  }
  const { publicKey, publicKeyFingerprint } = getOrCreateSigningKeys(input.home);
  if (sidecar.pubkey_fingerprint !== publicKeyFingerprint) {
    return {
      ok: false,
      reason: 'pubkey_mismatch',
      detail: `sidecar=${sidecar.pubkey_fingerprint} verifier=${publicKeyFingerprint}`,
    };
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(sidecar.signature, 'base64');
  } catch {
    return { ok: false, reason: 'sidecar_malformed', detail: 'signature not base64' };
  }
  const message = canonicalMessage(
    sidecar.script_path,
    sidecar.script_sha256,
    sidecar.worker_id,
    sidecar.created_at,
  );
  const ok = cryptoVerify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  if (!ok) return { ok: false, reason: 'signature_invalid' };
  return { ok: true, sidecar };
}

/** Canonical message bytes the signature is computed over. Exposed for
 *  test cross-checking. Pipe is chosen as the separator because path /
 *  hash / id / timestamp never contain it in practice. */
export function canonicalMessage(
  scriptPath: string,
  scriptSha256: string,
  workerId: string,
  createdAt: string,
): string {
  return `${scriptPath}|${scriptSha256}|${workerId}|${createdAt}`;
}

function ensureKeyDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows: ignore */
  }
}

function fingerprintOf(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}
