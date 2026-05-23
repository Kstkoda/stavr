// Persistence port — the single import path for SQLite access in stavR.
//
// Phase 2 (family-mode-phase-2) swap: the engine is now `node:sqlite`
// (`DatabaseSync`), Node's built-in SQLite. There is no native addon to
// build, which is what unblocks the SEA-compiled standalone executable
// (Phase 3) and the Tauri-sidecar installer (Phase 4).
//
// Compatibility shim: node:sqlite's surface is intentionally smaller than
// better-sqlite3's. We expose a Database/Statement pair that preserves the
// methods our call sites actually used (`prepare/exec/pragma/transaction/
// close` on Database; `get/all/run/iterate` on Statement). Two
// better-sqlite3 conveniences node:sqlite does not provide are implemented
// here on top of `prepare/exec`:
//   - `db.pragma(name, { simple })` — better-sqlite3's pragma helper.
//   - `db.transaction(fn)` — wraps `fn` in BEGIN/COMMIT (SAVEPOINT when
//     nested), with automatic ROLLBACK on throw.
// One semantic gap is also bridged: node:sqlite returns BLOB columns as
// `Uint8Array`, better-sqlite3 returns `Buffer`. Buffer is a Uint8Array
// subclass, so consumers that only need the bytes work either way, but
// any code calling Buffer-specific methods (`.toString('utf8')`,
// `.equals(...)`, etc.) breaks under the raw Uint8Array. The shim
// rehydrates blob values to Buffer with a zero-copy view on the
// underlying ArrayBuffer.
// `close()` is made idempotent — better-sqlite3 silently ignores
// double-close, node:sqlite throws "database is not open".
//
// The port is engine-neutral and policy-free: callers own pragmas
// (`journal_mode = WAL`, `foreign_keys = ON`, etc.) the same way they did
// under better-sqlite3.
//
// If node:sqlite proves unfit, the revert is local to this file — re-
// alias to better-sqlite3 behind the same Database/Statement surface.
//
// See: proposed/family-mode-phase-2-bom.md, proposed/family-mode-phase-2-recon.md,
// ADR-002 (sqlite-not-postgres), ADR-036 (audit-integrity-baseline).

import { Buffer } from 'node:buffer';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** Result of a `run()` call. Matches the better-sqlite3 shape we relied on. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Compiled statement handle. Methods accept positional bind parameters. */
export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

/** Wrapped transaction function — invoke to run `fn` inside BEGIN/COMMIT. */
export type TransactionFn<TArgs extends unknown[], TRet> = (...args: TArgs) => TRet;

/** Database handle. The compatibility surface our call sites use. */
export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(stmt: string, options?: { simple?: boolean }): unknown;
  transaction<TArgs extends unknown[], TRet>(
    fn: (...args: TArgs) => TRet,
  ): TransactionFn<TArgs, TRet>;
  close(): void;
}

/** Subset of better-sqlite3's open options we currently use. */
export interface OpenOptions {
  /** If true, throws when the file does not exist (no auto-create). */
  fileMustExist?: boolean;
  /** If true, opens in read-only mode. */
  readonly?: boolean;
}

/**
 * Rehydrate `Uint8Array` blob values to `Buffer` in-place on a row object.
 * Zero-copy: `Buffer.from(uint8.buffer, byteOffset, byteLength)` is a view
 * over the existing ArrayBuffer, not a fresh allocation.
 *
 * Operates on null-prototype objects (node:sqlite's row shape) as well as
 * regular plain objects; `Object.keys` enumerates own enumerable props on
 * both.
 */
function rehydrateBlobs<T>(row: T): T {
  if (row === null || typeof row !== 'object') return row;
  const obj = row as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
      obj[key] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    }
  }
  return row;
}

function wrapStatement(stmt: StatementSync): Statement {
  return {
    get(...params: unknown[]): unknown {
      const row = (stmt.get as (...p: unknown[]) => unknown)(...params);
      return rehydrateBlobs(row);
    },
    all(...params: unknown[]): unknown[] {
      const rows = (stmt.all as (...p: unknown[]) => unknown[])(...params);
      for (const row of rows) rehydrateBlobs(row);
      return rows;
    },
    run(...params: unknown[]): RunResult {
      return (stmt.run as (...p: unknown[]) => RunResult)(...params);
    },
    iterate(...params: unknown[]): IterableIterator<unknown> {
      const iter = (stmt.iterate as (...p: unknown[]) => IterableIterator<unknown>)(...params);
      return (function* () {
        for (const row of iter) yield rehydrateBlobs(row);
      })();
    },
  };
}

/**
 * Wrap a node:sqlite `DatabaseSync` to add the better-sqlite3-style
 * `pragma()` + `transaction()` helpers our call sites use, and to make
 * `close()` idempotent.
 */
function wrap(inner: DatabaseSync): Database {
  let closed = false;
  return {
    prepare(sql: string): Statement {
      return wrapStatement(inner.prepare(sql));
    },
    exec(sql: string): void {
      inner.exec(sql);
    },
    pragma(stmt: string, options?: { simple?: boolean }): unknown {
      // better-sqlite3 accepts both "name" (read) and "name = value" (set)
      // forms via the same call and returns rows in both cases. node:sqlite
      // has no pragma helper, so we route both through `prepare(...).all()`,
      // which works for SET pragmas too (they return the new value).
      const rows = inner.prepare(`PRAGMA ${stmt}`).all() as Array<Record<string, unknown>>;
      if (!options?.simple) return rows;
      if (rows.length === 0) return undefined;
      const first = rows[0];
      const keys = Object.keys(first);
      return keys.length > 0 ? first[keys[0]] : undefined;
    },
    transaction<TArgs extends unknown[], TRet>(
      fn: (...args: TArgs) => TRet,
    ): TransactionFn<TArgs, TRet> {
      // Mirror better-sqlite3's nesting behaviour: if a transaction is
      // already in flight we wrap `fn` in a SAVEPOINT instead of BEGIN.
      // SQLite rejects nested BEGIN with "cannot start a transaction within
      // a transaction"; SAVEPOINT/RELEASE is the supported nesting form.
      return (...args: TArgs): TRet => {
        const nested = inner.isTransaction;
        const savepoint = nested
          ? `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
          : null;
        if (nested) {
          inner.exec(`SAVEPOINT ${savepoint}`);
        } else {
          inner.exec('BEGIN');
        }
        try {
          const result = fn(...args);
          if (nested) {
            inner.exec(`RELEASE ${savepoint}`);
          } else {
            inner.exec('COMMIT');
          }
          return result;
        } catch (err) {
          try {
            if (nested) {
              inner.exec(`ROLLBACK TO ${savepoint}`);
              inner.exec(`RELEASE ${savepoint}`);
            } else {
              inner.exec('ROLLBACK');
            }
          } catch {
            // Best-effort rollback; surface the original error regardless.
          }
          throw err;
        }
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      inner.close();
    },
  };
}

/**
 * Open a SQLite database file (or `:memory:`). Callers own the handle and
 * must `close()` when done. Pragmas (`journal_mode = WAL`, `foreign_keys`,
 * etc.) are the caller's responsibility — the port is engine-neutral, not
 * policy-bearing.
 */
export function openDatabase(path: string, options?: OpenOptions): Database {
  const inner = new DatabaseSync(path, {
    open: true,
    readOnly: options?.readonly ?? false,
  });
  return wrap(inner);
}
