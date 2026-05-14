/**
 * Spec 52 A2 — device-side token storage.
 *
 * Stores `{ daemon_url, device_id, token }` records on the remote device after
 * a successful `stavr pair --remote-host` exchange. The keychain integration
 * (keytar) is deferred to a follow-up; this file-backed fallback is the path
 * that always works, on every platform, with no native-module compile.
 *
 * File: `$STAVR_HOME/devices.json`, mode 0o600. Best-effort chmod on POSIX;
 * Windows ignores POSIX permission bits and relies on the per-user directory
 * (under `%USERPROFILE%\.stavr`) for confidentiality.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function stavrHomeDir(): string {
  return process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr');
}

export function devicesFilePath(): string {
  return join(stavrHomeDir(), 'devices.json');
}

export interface StoredDevicePairing {
  daemon_url: string;
  device_id: string;
  device_name: string;
  token: string;
  paired_at: string;
  fingerprint?: string;
}

interface DevicesFileSchema {
  version: 1;
  pairings: StoredDevicePairing[];
}

export function loadDevicesFile(path: string = devicesFilePath()): DevicesFileSchema {
  if (!existsSync(path)) return { version: 1, pairings: [] };
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return { version: 1, pairings: [] };
  const parsed = JSON.parse(raw) as DevicesFileSchema;
  if (parsed.version !== 1 || !Array.isArray(parsed.pairings)) {
    throw new Error(`devices file at ${path} is malformed (version=${parsed?.version})`);
  }
  return parsed;
}

export function saveDevicesFile(file: DevicesFileSchema, path: string = devicesFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  // Atomic rename — important when the daemon and a CLI are reading at once.
  renameSync(tmp, path);
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function upsertPairing(p: StoredDevicePairing, path?: string): DevicesFileSchema {
  const file = loadDevicesFile(path);
  const idx = file.pairings.findIndex(
    (x) => x.daemon_url === p.daemon_url && x.device_id === p.device_id,
  );
  if (idx >= 0) file.pairings[idx] = p;
  else file.pairings.push(p);
  saveDevicesFile(file, path);
  return file;
}

export function listPairings(path?: string): StoredDevicePairing[] {
  return loadDevicesFile(path).pairings;
}

export function findPairingByDaemon(daemonUrl: string, path?: string): StoredDevicePairing | undefined {
  return loadDevicesFile(path).pairings.find((p) => p.daemon_url === daemonUrl);
}
