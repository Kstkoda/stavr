import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decrypt,
  encrypt,
  loadMasterKey,
  _resetKeychainAdapterForTests,
} from '../../src/credentials/vault.js';
import { EventStore } from '../../src/persistence.js';
import { CredentialStore } from '../../src/credentials/store.js';
import {
  CredentialNotGrantedError,
  CredentialRevokedError,
} from '../../src/credentials/types.js';
import { signatureMatchesService } from '../../src/credentials/tools.js';

describe('Spec 48 Layer 2 — credential vault', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stavr-vault-test-'));
    // Force the file-fallback path so tests never touch the real OS keychain.
    _resetKeychainAdapterForTests(null);
  });
  afterEach(() => {
    _resetKeychainAdapterForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AES-256-GCM round-trips plaintext, fails on tampering', () => {
    const key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) key[i] = i;
    const blob = encrypt(key, 'sk-ant-secret');
    expect(blob.length).toBeGreaterThan(12 + 16);
    expect(decrypt(key, blob)).toBe('sk-ant-secret');
    // Flip a ciphertext byte — auth tag must reject.
    const tampered = Buffer.from(blob);
    tampered[16] ^= 0xff;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it('falls back to file-key when OS keychain is unavailable, signals unsafe storage on first provision', async () => {
    const filePath = join(tmp, 'master.key');
    const first = await loadMasterKey({ filePath });
    expect(first.origin).toBe('master-key-file-created');
    expect(first.unsafeStorageReason).toBeDefined();
    expect(existsSync(filePath)).toBe(true);
    expect(first.key.length).toBe(32);

    const second = await loadMasterKey({ filePath });
    expect(second.origin).toBe('master-key-file');
    expect(second.unsafeStorageReason).toBeDefined();
    expect(second.key.equals(first.key)).toBe(true);
  });

  describe('CredentialStore — store → grant → use → revoke', () => {
    let events: EventStore;
    let store: CredentialStore;
    beforeEach(() => {
      events = new EventStore();
      events.init(':memory:');
      const key = Buffer.alloc(32, 7);
      store = new CredentialStore(events, key);
    });

    it('add encrypts plaintext; list never returns plaintext; decryptForUse round-trips', () => {
      const cred = store.add({
        user_id: 'kenneth',
        service: 'anthropic',
        kind: 'api_key',
        plaintext: 'sk-ant-secret-1234',
      });
      expect(cred.plaintext).toBeUndefined();
      const listed = store.list({ service: 'anthropic' });
      expect(listed).toHaveLength(1);
      expect(listed[0].plaintext).toBeUndefined();
      const decrypted = store.decryptForUse(cred.id);
      expect(decrypted.plaintext).toBe('sk-ant-secret-1234');
    });

    it('resolveForUse requires an active grant', () => {
      const cred = store.add({
        user_id: 'kenneth',
        service: 'github',
        kind: 'oauth',
        plaintext: 'ghs-secret',
      });
      expect(() => store.resolveForUse({ credential_id: cred.id })).toThrow(
        CredentialNotGrantedError,
      );
      const grant = store.addGrant({
        credential_id: cred.id,
        granted_by_user_id: 'kenneth',
      });
      const resolved = store.resolveForUse({ credential_id: cred.id });
      expect(resolved.plaintext).toBe('ghs-secret');
      expect(resolved.grant.id).toBe(grant.id);
    });

    it('uses_remaining decrements and exhausts', () => {
      const cred = store.add({
        user_id: 'kenneth',
        service: 'github',
        kind: 'api_key',
        plaintext: 'gh-token',
      });
      const grant = store.addGrant({
        credential_id: cred.id,
        granted_by_user_id: 'kenneth',
        uses_remaining: 2,
      });
      store.consumeGrantUse(grant.id);
      store.consumeGrantUse(grant.id);
      expect(() => store.resolveForUse({ credential_id: cred.id })).toThrow(
        CredentialNotGrantedError,
      );
    });

    it('revoke surfaces CredentialRevokedError on subsequent use and revokes grants atomically', () => {
      const cred = store.add({
        user_id: 'kenneth',
        service: 'anthropic',
        kind: 'api_key',
        plaintext: 'sk-ant-x',
      });
      store.addGrant({ credential_id: cred.id, granted_by_user_id: 'kenneth' });
      const revoked = store.revoke(cred.id, 'kenneth');
      expect(revoked.revoked_at).toBeDefined();
      expect(revoked.metadata.revoked_by).toBe('kenneth');
      expect(() => store.resolveForUse({ credential_id: cred.id })).toThrow(
        CredentialRevokedError,
      );
      // Grant must be auto-revoked, so findActiveGrant returns nothing.
      expect(store.findActiveGrant(cred.id)).toBeUndefined();
    });

    it('signatureMatchesService accepts colon / dot / slash forms, rejects wrong service', () => {
      expect(signatureMatchesService('github:GET /repos', 'github')).toBe(true);
      expect(signatureMatchesService('github_api_call', 'github')).toBe(true);
      expect(signatureMatchesService('anthropic_api_call', 'github')).toBe(false);
      expect(signatureMatchesService('github.create_pr', 'github')).toBe(true);
    });
  });
});
