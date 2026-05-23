// Persistence port — the single import path for SQLite access in stavR.
//
// All consumers MUST import from `../db/index.js` (or relative equivalent)
// instead of `better-sqlite3` directly. The port is the seam: family-mode
// Phase 2 swaps the engine to `node:sqlite` by editing this file only.
//
// Today's implementation is a thin pass-through to better-sqlite3 — this is
// pure refactor insurance. If node:sqlite proves unfit in Phase 2, we revert
// here without touching call sites.
//
// See: proposed/family-mode-phase-2-bom.md, proposed/family-mode-phase-2-recon.md,
// ADR-002 (sqlite-not-postgres), ADR-036 (audit-integrity-baseline).

import BetterSqlite3 from 'better-sqlite3';

/**
 * SQLite database handle. Today aliases `better-sqlite3`'s instance type.
 * Phase 2 either re-aliases this to node:sqlite's `DatabaseSync` (if API
 * surface permits) or to a thin shim that preserves the methods we use:
 * `prepare`, `pragma`, `exec`, `transaction`, `close`.
 */
export type Database = BetterSqlite3.Database;

/** Subset of better-sqlite3's open options we currently use. */
export interface OpenOptions {
  /** If true, throws when the file does not exist (no auto-create). */
  fileMustExist?: boolean;
  /** If true, opens in read-only mode. */
  readonly?: boolean;
}

/**
 * Open a SQLite database file (or `:memory:`). Callers own the handle and
 * must `close()` when done. Pragmas (`journal_mode = WAL`, `foreign_keys`,
 * etc.) are the caller's responsibility — the port is engine-neutral, not
 * policy-bearing.
 */
export function openDatabase(path: string, options?: OpenOptions): Database {
  return new BetterSqlite3(path, options);
}
