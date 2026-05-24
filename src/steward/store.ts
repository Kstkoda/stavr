import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { EventStore } from '../persistence.js';
import {
  NoActiveStewardError,
  StewardAlreadyClaimedError,
  StewardTokenInvalidError,
  type StewardClaimInput,
  type StewardClaimToken,
  type StewardRecord,
} from './types.js';

const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;

interface StewardRow {
  id: string;
  client_id: string;
  user_id: string;
  display_name: string | null;
  model: string | null;
  provider: string | null;
  claimed_at: string;
  released_at: string | null;
  last_pulse_at: string | null;
  memory_path: string | null;
  metadata_json: string | null;
}

interface TokenRow {
  token: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
}

function rowToRecord(row: StewardRow): StewardRecord {
  return {
    id: row.id,
    client_id: row.client_id,
    user_id: row.user_id,
    display_name: row.display_name ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    claimed_at: row.claimed_at,
    released_at: row.released_at ?? undefined,
    last_pulse_at: row.last_pulse_at ?? undefined,
    memory_path: row.memory_path ?? undefined,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {},
  };
}

export class StewardStore {
  private readonly db: Database;

  constructor(eventStore: EventStore) {
    this.db = eventStore.rawDb;
  }

  mintClaimToken(opts: { ttlMs?: number } = {}): StewardClaimToken {
    const ttl = opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
    const now = new Date();
    const token = `sct-${randomBytes(24).toString('hex')}`;
    const created_at = now.toISOString();
    const expires_at = new Date(now.getTime() + ttl).toISOString();
    this.db
      .prepare(
        `INSERT INTO steward_claim_tokens (token, created_at, expires_at) VALUES (?, ?, ?)`,
      )
      .run(token, created_at, expires_at);
    return { token, created_at, expires_at };
  }

  getActiveSteward(): StewardRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM stewards WHERE released_at IS NULL ORDER BY claimed_at DESC LIMIT 1`,
      )
      .get() as StewardRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getSteward(id: string): StewardRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM stewards WHERE id = ?`).get(id) as
      | StewardRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Claim the Steward role for a chat-surface client. Validates the one-shot
   * token, enforces the single-Steward invariant, and records the new session.
   *
   * Throws StewardAlreadyClaimedError if another Steward is active, or
   * StewardTokenInvalidError if the token is unknown/expired/already redeemed.
   */
  claim(token: string, input: StewardClaimInput): StewardRecord {
    const tokenRow = this.db
      .prepare(`SELECT * FROM steward_claim_tokens WHERE token = ?`)
      .get(token) as TokenRow | undefined;
    if (!tokenRow) throw new StewardTokenInvalidError('unknown');
    if (tokenRow.redeemed_at) throw new StewardTokenInvalidError('already_redeemed');
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw new StewardTokenInvalidError('expired');
    }

    const active = this.getActiveSteward();
    if (active) throw new StewardAlreadyClaimedError(active);

    const id = `stw-${randomUUID()}`;
    const now = new Date().toISOString();
    const memoryPath = input.metadata?.memory_path
      ? String(input.metadata.memory_path)
      : undefined;

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO stewards
             (id, client_id, user_id, display_name, model, provider,
              claimed_at, released_at, last_pulse_at, memory_path, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          input.client_id,
          input.user_id,
          input.display_name ?? null,
          input.model ?? null,
          input.provider ?? null,
          now,
          now,
          memoryPath ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );
      this.db
        .prepare(
          `UPDATE steward_claim_tokens SET redeemed_at = ?, redeemed_by = ? WHERE token = ?`,
        )
        .run(now, id, token);
    });
    insert();

    const rec = this.getSteward(id);
    if (!rec) throw new Error('steward record vanished after insert');
    return rec;
  }

  release(reason?: string): StewardRecord {
    const active = this.getActiveSteward();
    if (!active) throw new NoActiveStewardError();
    const released_at = new Date().toISOString();
    this.db
      .prepare(`UPDATE stewards SET released_at = ? WHERE id = ?`)
      .run(released_at, active.id);
    const updated = this.getSteward(active.id);
    if (!updated) throw new Error('steward record vanished after release');
    if (reason !== undefined) {
      const meta = { ...updated.metadata, release_reason: reason };
      this.db
        .prepare(`UPDATE stewards SET metadata_json = ? WHERE id = ?`)
        .run(JSON.stringify(meta), updated.id);
      updated.metadata = meta;
    }
    return updated;
  }

  /**
   * Hand off the role from the current active Steward to a new claimant. The
   * new claimant must present a valid token. Unlike claim(), the single-Steward
   * invariant is satisfied by releasing the old Steward in the same transaction.
   */
  transfer(token: string, input: StewardClaimInput): { from: StewardRecord; to: StewardRecord } {
    const active = this.getActiveSteward();
    if (!active) throw new NoActiveStewardError();

    const tokenRow = this.db
      .prepare(`SELECT * FROM steward_claim_tokens WHERE token = ?`)
      .get(token) as TokenRow | undefined;
    if (!tokenRow) throw new StewardTokenInvalidError('unknown');
    if (tokenRow.redeemed_at) throw new StewardTokenInvalidError('already_redeemed');
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw new StewardTokenInvalidError('expired');
    }

    const newId = `stw-${randomUUID()}`;
    const now = new Date().toISOString();
    const memoryPath = input.metadata?.memory_path
      ? String(input.metadata.memory_path)
      : undefined;

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE stewards SET released_at = ? WHERE id = ?`).run(now, active.id);
      this.db
        .prepare(
          `INSERT INTO stewards
             (id, client_id, user_id, display_name, model, provider,
              claimed_at, released_at, last_pulse_at, memory_path, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          newId,
          input.client_id,
          input.user_id,
          input.display_name ?? null,
          input.model ?? null,
          input.provider ?? null,
          now,
          now,
          memoryPath ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );
      this.db
        .prepare(
          `UPDATE steward_claim_tokens SET redeemed_at = ?, redeemed_by = ? WHERE token = ?`,
        )
        .run(now, newId, token);
    });
    tx();

    const from = this.getSteward(active.id);
    const to = this.getSteward(newId);
    if (!from || !to) throw new Error('steward records vanished after transfer');
    return { from, to };
  }

  recordPulse(stewardId?: string): StewardRecord | undefined {
    const target = stewardId ? this.getSteward(stewardId) : this.getActiveSteward();
    if (!target || target.released_at) return undefined;
    const at = new Date().toISOString();
    this.db.prepare(`UPDATE stewards SET last_pulse_at = ? WHERE id = ?`).run(at, target.id);
    return this.getSteward(target.id);
  }

  listStewards(filter?: { activeOnly?: boolean; limit?: number }): StewardRecord[] {
    const where = filter?.activeOnly ? 'WHERE released_at IS NULL' : '';
    const limit = filter?.limit ?? 50;
    const rows = this.db
      .prepare(`SELECT * FROM stewards ${where} ORDER BY claimed_at DESC LIMIT ?`)
      .all(limit) as StewardRow[];
    return rows.map(rowToRecord);
  }
}
