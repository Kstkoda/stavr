import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Spec 48 Layer 2 — credential vault encryption layer.
 *
 * AES-256-GCM. The 32-byte master key is sourced from the OS keychain when
 * possible (Windows Credential Manager via the optional `wincred` package);
 * otherwise we fall back to a 0600-mode file at ~/.stavr/master.key and emit
 * `credential_unsafe_storage` so the User sees the regression in their event
 * stream. The key never lives in the SQLite DB.
 */
export const MASTER_KEY_FILE = join(homedir(), '.stavr', 'master.key');
const KEYCHAIN_SERVICE = 'stavr';
const KEYCHAIN_ACCOUNT = 'master-key';

export type KeyOrigin = 'os-keychain' | 'master-key-file' | 'master-key-file-created';

export interface KeyLoadResult {
  key: Buffer;
  origin: KeyOrigin;
  /**
   * Non-null when the key was loaded from the file fallback. Subscribers fire
   * a `credential_unsafe_storage` event so the User notices the regression.
   */
  unsafeStorageReason?: string;
}

export interface VaultEncrypted {
  /** base64(iv ‖ ciphertext ‖ authTag) — single blob, easy to round-trip via sqlite BLOB. */
  blob: Buffer;
}

interface KeychainAdapter {
  read(): Promise<Buffer | undefined>;
  write(key: Buffer): Promise<void>;
}

let cachedAdapter: KeychainAdapter | undefined | null = undefined;

/** Reset the lazily-imported keychain adapter — tests inject their own. */
export function _resetKeychainAdapterForTests(adapter?: KeychainAdapter | null): void {
  cachedAdapter = adapter as KeychainAdapter | undefined | null;
}

async function loadKeychainAdapter(): Promise<KeychainAdapter | null> {
  if (cachedAdapter !== undefined) return cachedAdapter ?? null;
  if (platform() !== 'win32') {
    cachedAdapter = null;
    return null;
  }
  try {
    // wincred is declared as an optionalDependency so cross-platform installs
    // don't fail. If it isn't on disk we just take the file-fallback path. The
    // dynamic import target is computed at runtime so the TS compiler doesn't
    // try to resolve the (intentionally missing) types.
    const wincredId = 'wincred';
    const mod = (await import(/* @vite-ignore */ wincredId)) as unknown as {
      set?: (account: string, secret: string, target?: string) => void;
      get?: (account: string, target?: string) => string;
      list?: (target?: string) => Array<{ TargetName: string }>;
    };
    if (!mod.get || !mod.set) {
      cachedAdapter = null;
      return null;
    }
    cachedAdapter = {
      async read() {
        try {
          const raw = mod.get!(KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE);
          if (!raw) return undefined;
          return Buffer.from(raw, 'base64');
        } catch {
          return undefined;
        }
      },
      async write(key: Buffer) {
        mod.set!(KEYCHAIN_ACCOUNT, key.toString('base64'), KEYCHAIN_SERVICE);
      },
    };
    return cachedAdapter;
  } catch {
    cachedAdapter = null;
    return null;
  }
}

/**
 * Load (or first-time provision) the master key. Tries the OS keychain first,
 * then the ~/.stavr/master.key file. Caller decides whether to emit a
 * `credential_unsafe_storage` event based on the returned `origin`.
 */
export async function loadMasterKey(opts: { filePath?: string } = {}): Promise<KeyLoadResult> {
  const filePath = opts.filePath ?? MASTER_KEY_FILE;
  const keychain = await loadKeychainAdapter();

  if (keychain) {
    const existing = await keychain.read();
    if (existing && existing.length === 32) {
      return { key: existing, origin: 'os-keychain' };
    }
    const fresh = randomBytes(32);
    await keychain.write(fresh);
    return { key: fresh, origin: 'os-keychain' };
  }

  // File fallback. We never read the file at module load time — the daemon's
  // first call to loadMasterKey is what creates/reads it, so test isolation
  // is straightforward.
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath);
    if (raw.length === 32) {
      return {
        key: raw,
        origin: 'master-key-file',
        unsafeStorageReason:
          'OS keychain unavailable; master key loaded from ~/.stavr/master.key',
      };
    }
    // Wrong length — treat as garbage and rotate.
  }
  const fresh = randomBytes(32);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, fresh);
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // chmod has no effect on Windows NTFS; the file inherits user-only ACLs
    // because it lives under %USERPROFILE%/.stavr. Best-effort.
  }
  renameSync(tmp, filePath);
  return {
    key: fresh,
    origin: 'master-key-file-created',
    unsafeStorageReason:
      'OS keychain unavailable; provisioned a 32-byte master key at ~/.stavr/master.key',
  };
}

/** AES-256-GCM encrypt plaintext under the master key. Returns iv ‖ ct ‖ tag as one buffer. */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  if (key.length !== 32) throw new Error('master key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/** Inverse of encrypt(). Throws on auth-tag mismatch. */
export function decrypt(key: Buffer, blob: Buffer): string {
  if (key.length !== 32) throw new Error('master key must be 32 bytes');
  if (blob.length < 12 + 16) throw new Error('encrypted blob too short');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
