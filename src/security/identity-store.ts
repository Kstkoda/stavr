/**
 * Operator identity store — backs the `operator_credentials` and
 * `tier3_assertions` tables added in v0.7 Phase 1.
 *
 * Stores WebAuthn passkey credentials per operator + the most-recent
 * successful assertions used to gate Tier 3 EXPLICIT actions.
 *
 * Schema lives in `src/persistence.ts`; this class is a thin wrapper that
 * exposes the read / write surface other modules (`security/webauthn.ts`,
 * the HTTP endpoints in `transports.ts`) consume.
 */
import type { Database } from '../db/index.js';

export interface RegisteredCredential {
  credential_id: string;
  operator_id: string;
  public_key: Buffer;
  counter: number;
  transports: string[];
  device_label: string | null;
  registered_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface Tier3Assertion {
  id: string;
  operator_id: string;
  credential_id: string;
  correlation_id: string | null;
  scope_label: string | null;
  created_at: number;
  expires_at: number;
}

export interface RegisterInput {
  credentialId: string;
  operatorId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  deviceLabel?: string;
}

export interface RecordAssertionInput {
  id: string;
  operatorId: string;
  credentialId: string;
  correlationId?: string;
  scopeLabel?: string;
  createdAt: number;
  expiresAt: number;
}

interface CredentialRow {
  credential_id: string;
  operator_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  device_label: string | null;
  registered_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface AssertionRow {
  id: string;
  operator_id: string;
  credential_id: string;
  correlation_id: string | null;
  scope_label: string | null;
  created_at: number;
  expires_at: number;
}

export class IdentityStore {
  constructor(private readonly db: Database) {}

  /** Insert a new credential. Throws on duplicate credential_id (operator
   *  re-registers the same authenticator). */
  register(input: RegisterInput): RegisteredCredential {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO operator_credentials
           (credential_id, operator_id, public_key, counter, transports,
            device_label, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.credentialId,
        input.operatorId,
        input.publicKey,
        input.counter,
        JSON.stringify(input.transports),
        input.deviceLabel ?? null,
        now,
      );
    const row = this.getById(input.credentialId);
    if (!row) {
      throw new Error('identity-store: failed to read back just-registered credential');
    }
    return row;
  }

  /** Return one credential by its credential_id, or undefined if absent. */
  getById(credentialId: string): RegisteredCredential | undefined {
    const row = this.db
      .prepare(
        `SELECT credential_id, operator_id, public_key, counter, transports,
                device_label, registered_at, last_used_at, revoked_at
         FROM operator_credentials WHERE credential_id = ?`,
      )
      .get(credentialId) as CredentialRow | undefined;
    if (!row) return undefined;
    return this.rowToCredential(row);
  }

  /** Return every credential for an operator. By default omits revoked. */
  listForOperator(
    operatorId: string,
    opts: { includeRevoked?: boolean } = {},
  ): RegisteredCredential[] {
    const sql = opts.includeRevoked
      ? `SELECT credential_id, operator_id, public_key, counter, transports,
                device_label, registered_at, last_used_at, revoked_at
         FROM operator_credentials
         WHERE operator_id = ?
         ORDER BY registered_at DESC`
      : `SELECT credential_id, operator_id, public_key, counter, transports,
                device_label, registered_at, last_used_at, revoked_at
         FROM operator_credentials
         WHERE operator_id = ? AND revoked_at IS NULL
         ORDER BY registered_at DESC`;
    const rows = this.db.prepare(sql).all(operatorId) as CredentialRow[];
    return rows.map((r) => this.rowToCredential(r));
  }

  /** Bump the signature counter after a successful assertion. WebAuthn
   *  spec requires monotonic counter (resists cloned authenticators). */
  updateCounter(credentialId: string, newCounter: number): void {
    this.db
      .prepare(
        `UPDATE operator_credentials
         SET counter = ?, last_used_at = ?
         WHERE credential_id = ?`,
      )
      .run(newCounter, Date.now(), credentialId);
  }

  /** Mark a credential revoked. Soft-delete — kept for audit, hidden from
   *  registration `excludeCredentials` and authentication `allowCredentials`
   *  lookups. */
  revoke(credentialId: string): void {
    this.db
      .prepare(`UPDATE operator_credentials SET revoked_at = ? WHERE credential_id = ?`)
      .run(Date.now(), credentialId);
  }

  /** Record a successful Tier 3 assertion. Subsequent freshness checks
   *  read this table. */
  recordAssertion(input: RecordAssertionInput): void {
    this.db
      .prepare(
        `INSERT INTO tier3_assertions
           (id, operator_id, credential_id, correlation_id, scope_label,
            created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.operatorId,
        input.credentialId,
        input.correlationId ?? null,
        input.scopeLabel ?? null,
        input.createdAt,
        input.expiresAt,
      );
  }

  /** Has the operator successfully asserted within the freshness window?
   *  When correlationId is set, requires a matching assertion (per-action
   *  re-auth); otherwise any recent assertion suffices. */
  hasRecentAssertion(opts: {
    operatorId: string;
    correlationId?: string;
    now?: number;
  }): Tier3Assertion | undefined {
    const now = opts.now ?? Date.now();
    if (opts.correlationId !== undefined) {
      const row = this.db
        .prepare(
          `SELECT id, operator_id, credential_id, correlation_id, scope_label,
                  created_at, expires_at
           FROM tier3_assertions
           WHERE operator_id = ?
             AND correlation_id = ?
             AND expires_at > ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(opts.operatorId, opts.correlationId, now) as AssertionRow | undefined;
      return row ? this.rowToAssertion(row) : undefined;
    }
    const row = this.db
      .prepare(
        `SELECT id, operator_id, credential_id, correlation_id, scope_label,
                created_at, expires_at
         FROM tier3_assertions
         WHERE operator_id = ?
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(opts.operatorId, now) as AssertionRow | undefined;
    return row ? this.rowToAssertion(row) : undefined;
  }

  /** Drop expired assertion rows. Called by a periodic sweeper; safe to
   *  call any time. Returns the row count actually dropped. */
  sweepExpiredAssertions(now: number = Date.now()): number {
    const result = this.db
      .prepare(`DELETE FROM tier3_assertions WHERE expires_at < ?`)
      .run(now);
    return result.changes;
  }

  /** Distinct operator ids present in operator_credentials. */
  knownOperators(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT operator_id FROM operator_credentials WHERE revoked_at IS NULL`)
      .all() as Array<{ operator_id: string }>;
    return rows.map((r) => r.operator_id);
  }

  private rowToCredential(row: CredentialRow): RegisteredCredential {
    return {
      credential_id: row.credential_id,
      operator_id: row.operator_id,
      public_key: row.public_key,
      counter: row.counter,
      transports: safeJsonArray(row.transports),
      device_label: row.device_label,
      registered_at: row.registered_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    };
  }

  private rowToAssertion(row: AssertionRow): Tier3Assertion {
    return {
      id: row.id,
      operator_id: row.operator_id,
      credential_id: row.credential_id,
      correlation_id: row.correlation_id,
      scope_label: row.scope_label,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
  } catch {
    /* fall through */
  }
  return [];
}
