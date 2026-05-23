import { randomUUID } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { EventStore } from '../persistence.js';
import { decrypt, encrypt } from './vault.js';
import {
  CredentialNotFoundError,
  CredentialNotGrantedError,
  CredentialRevokedError,
  type AddCredentialInput,
  type CredentialGrantRecord,
  type CredentialRecord,
} from './types.js';

interface CredentialRow {
  id: string;
  user_id: string;
  service: string;
  kind: string;
  encrypted_blob: Buffer | null;
  oauth_scopes: string | null;
  oauth_refresh_token_encrypted: Buffer | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  metadata_json: string | null;
}

interface GrantRow {
  id: string;
  credential_id: string;
  steward_session_id: string | null;
  granted_at: string;
  revoked_at: string | null;
  granted_by_user_id: string;
  uses_remaining: number | null;
  expires_at: string | null;
}

export class CredentialStore {
  private readonly db: Database;

  constructor(eventStore: EventStore, private readonly masterKey: Buffer) {
    this.db = eventStore.rawDb;
  }

  add(input: AddCredentialInput): CredentialRecord {
    if ((input.kind === 'api_key' || input.kind === 'oauth') && !input.plaintext) {
      throw new Error('plaintext is required for kind=api_key|oauth');
    }
    const id = `cred-${randomUUID()}`;
    const created_at = new Date().toISOString();
    const encryptedBlob = input.plaintext ? encrypt(this.masterKey, input.plaintext) : null;
    const encryptedRefresh = input.oauth_refresh_token
      ? encrypt(this.masterKey, input.oauth_refresh_token)
      : null;
    this.db
      .prepare(
        `INSERT INTO credentials
           (id, user_id, service, kind, encrypted_blob, oauth_scopes,
            oauth_refresh_token_encrypted, expires_at, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.user_id,
        input.service,
        input.kind,
        encryptedBlob,
        input.oauth_scopes ? input.oauth_scopes.join(',') : null,
        encryptedRefresh,
        input.expires_at ?? null,
        created_at,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
    const rec = this.get(id, { includePlaintext: false });
    if (!rec) throw new Error('credential vanished after insert');
    return rec;
  }

  get(id: string, opts: { includePlaintext?: boolean } = {}): CredentialRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(id) as
      | CredentialRow
      | undefined;
    if (!row) return undefined;
    return this.rowToRecord(row, opts.includePlaintext === true);
  }

  list(filter?: { service?: string; includeRevoked?: boolean }): CredentialRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.service) {
      where.push('service = ?');
      params.push(filter.service);
    }
    if (!filter?.includeRevoked) {
      where.push('revoked_at IS NULL');
    }
    const sql = `SELECT * FROM credentials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as CredentialRow[];
    return rows.map((r) => this.rowToRecord(r, false));
  }

  revoke(id: string, revokedBy: string): CredentialRecord {
    const existing = this.get(id);
    if (!existing) throw new CredentialNotFoundError(id);
    if (existing.revoked_at) return existing;
    const revoked_at = new Date().toISOString();
    this.db
      .prepare(`UPDATE credentials SET revoked_at = ? WHERE id = ?`)
      .run(revoked_at, id);
    this.db
      .prepare(`UPDATE credential_grants SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL`)
      .run(revoked_at, id);
    const updated = this.get(id);
    if (!updated) throw new Error('credential vanished after revoke');
    const meta = { ...updated.metadata, revoked_by: revokedBy };
    this.db
      .prepare(`UPDATE credentials SET metadata_json = ? WHERE id = ?`)
      .run(JSON.stringify(meta), id);
    return { ...updated, metadata: meta };
  }

  recordUse(id: string): void {
    this.db
      .prepare(`UPDATE credentials SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** Internal accessor — returns the decrypted access token + refresh token (if any). */
  decryptForUse(id: string): { plaintext: string; refresh?: string } {
    const row = this.db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(id) as
      | CredentialRow
      | undefined;
    if (!row) throw new CredentialNotFoundError(id);
    if (row.revoked_at) throw new CredentialRevokedError(id);
    if (!row.encrypted_blob) throw new Error(`credential ${id} has no encrypted_blob to decrypt`);
    const plaintext = decrypt(this.masterKey, row.encrypted_blob);
    const refresh = row.oauth_refresh_token_encrypted
      ? decrypt(this.masterKey, row.oauth_refresh_token_encrypted)
      : undefined;
    return { plaintext, refresh };
  }

  // ---- grants ----

  addGrant(input: {
    credential_id: string;
    steward_session_id?: string;
    granted_by_user_id: string;
    uses_remaining?: number;
    expires_at?: string;
  }): CredentialGrantRecord {
    const cred = this.get(input.credential_id);
    if (!cred) throw new CredentialNotFoundError(input.credential_id);
    if (cred.revoked_at) throw new CredentialRevokedError(input.credential_id);
    const id = `cgr-${randomUUID()}`;
    const granted_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO credential_grants
          (id, credential_id, steward_session_id, granted_at,
           granted_by_user_id, uses_remaining, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.credential_id,
        input.steward_session_id ?? null,
        granted_at,
        input.granted_by_user_id,
        input.uses_remaining ?? null,
        input.expires_at ?? null,
      );
    return {
      id,
      credential_id: input.credential_id,
      steward_session_id: input.steward_session_id,
      granted_at,
      granted_by_user_id: input.granted_by_user_id,
      uses_remaining: input.uses_remaining,
      expires_at: input.expires_at,
    };
  }

  revokeGrant(grantId: string): CredentialGrantRecord {
    const row = this.db.prepare(`SELECT * FROM credential_grants WHERE id = ?`).get(grantId) as
      | GrantRow
      | undefined;
    if (!row) throw new Error(`grant ${grantId} not found`);
    if (row.revoked_at) return grantRowToRecord(row);
    const revoked_at = new Date().toISOString();
    this.db
      .prepare(`UPDATE credential_grants SET revoked_at = ? WHERE id = ?`)
      .run(revoked_at, grantId);
    const updated = this.db.prepare(`SELECT * FROM credential_grants WHERE id = ?`).get(grantId) as GrantRow;
    return grantRowToRecord(updated);
  }

  /** Returns the active grant covering this credential for the given steward (or any if not supplied). */
  findActiveGrant(credentialId: string, stewardSessionId?: string): CredentialGrantRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM credential_grants
         WHERE credential_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY granted_at DESC`,
      )
      .all(credentialId, new Date().toISOString()) as GrantRow[];
    for (const row of rows) {
      if (!stewardSessionId || !row.steward_session_id || row.steward_session_id === stewardSessionId) {
        if (row.uses_remaining !== null && row.uses_remaining <= 0) continue;
        return grantRowToRecord(row);
      }
    }
    return undefined;
  }

  /** Mark one grant-use as consumed (decrements uses_remaining when set, no-op when null). */
  consumeGrantUse(grantId: string): void {
    this.db
      .prepare(
        `UPDATE credential_grants
         SET uses_remaining = CASE WHEN uses_remaining IS NULL THEN NULL ELSE uses_remaining - 1 END
         WHERE id = ?`,
      )
      .run(grantId);
  }

  /**
   * Resolve a usable credential for a Steward call: validates the grant chain
   * and returns the decrypted access token. Throws CredentialNotGrantedError
   * if no grant covers the call.
   */
  resolveForUse(opts: { credential_id: string; steward_session_id?: string }): {
    credential: CredentialRecord;
    grant: CredentialGrantRecord;
    plaintext: string;
    refresh?: string;
  } {
    const cred = this.get(opts.credential_id);
    if (!cred) throw new CredentialNotFoundError(opts.credential_id);
    if (cred.revoked_at) throw new CredentialRevokedError(opts.credential_id);
    const grant = this.findActiveGrant(opts.credential_id, opts.steward_session_id);
    if (!grant) throw new CredentialNotGrantedError(opts.credential_id);
    const { plaintext, refresh } = this.decryptForUse(opts.credential_id);
    return { credential: cred, grant, plaintext, refresh };
  }

  // ---- helpers ----

  private rowToRecord(row: CredentialRow, includePlaintext: boolean): CredentialRecord {
    const rec: CredentialRecord = {
      id: row.id,
      user_id: row.user_id,
      service: row.service,
      kind: row.kind as CredentialRecord['kind'],
      oauth_scopes: row.oauth_scopes ? row.oauth_scopes.split(',') : undefined,
      expires_at: row.expires_at ?? undefined,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
      revoked_at: row.revoked_at ?? undefined,
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {},
    };
    if (includePlaintext && row.encrypted_blob) {
      rec.plaintext = decrypt(this.masterKey, row.encrypted_blob);
      if (row.oauth_refresh_token_encrypted) {
        rec.oauth_refresh_token = decrypt(this.masterKey, row.oauth_refresh_token_encrypted);
      }
    }
    return rec;
  }
}

function grantRowToRecord(row: GrantRow): CredentialGrantRecord {
  return {
    id: row.id,
    credential_id: row.credential_id,
    steward_session_id: row.steward_session_id ?? undefined,
    granted_at: row.granted_at,
    revoked_at: row.revoked_at ?? undefined,
    granted_by_user_id: row.granted_by_user_id,
    uses_remaining: row.uses_remaining ?? undefined,
    expires_at: row.expires_at ?? undefined,
  };
}
