#!/usr/bin/env node
// Bombardment Phase 4c — in-container helper: seed a small fixture of
// (decision_row, decision_request event) pairs so the corruption +
// replay oracle has something to compare against.
//
// Why both the row AND the event: the projection (decisions table) is
// derivable from the event log; the rebuild oracle reads the events
// and reconstructs what the projection SHOULD look like. For that
// reconstruction to be meaningful there must be source-of-truth events
// in the log corresponding to each projection row.
//
// Each fixture is:
//   - correlation_id: bombardment-fixture-<n>
//   - one row in `decisions` with status='open'
//   - one row in `events` with kind='decision_request' and the same
//     correlation_id, payload_json carrying question + options
//
// Usage:
//   docker exec stavr-peer-a node /app/bombardment-chaos/seed-projection-fixture.mjs <count>
//
// Output (stdout): one JSON line { ok, count, correlation_ids }.
// Idempotent — re-running with the same count is a no-op (INSERT OR IGNORE).
//
// Exit: 0 ok / 1 db err / 2 bad invocation.

import Database from 'better-sqlite3';

const count = Number(process.argv[2] ?? 0);
if (!Number.isFinite(count) || count < 1 || count > 1000) {
  console.error('usage: seed-projection-fixture.mjs <count between 1 and 1000>');
  process.exit(2);
}

const dbPath = process.env.STAVR_DB ?? '/home/stavr/.stavr/runestone.db';

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const insertDecision = db.prepare(
    `INSERT OR IGNORE INTO decisions
       (correlation_id, question, options_json, default_option_id,
        timeout_sec, status, requested_at, expires_at, source_agent, tier)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'bombardment-fixture', 'CONFIRM')`,
  );

  // We push events through a direct INSERT because broker.publish lives
  // in the daemon process and we don't share that here. The events
  // table schema (persistence.ts:168) requires: id, kind, correlation_id,
  // source_agent, tenant_id (nullable), payload_json, at, persisted_at,
  // seq, created_at.
  //
  // INSERT OR IGNORE on events too — the id is now derived
  // deterministically from correlation_id, so re-running the seeder
  // against the same named volume does not inject duplicate
  // decision_request rows per fixture (Angle B finding #2). seq is
  // read INSIDE the transaction (Angle A/C finding #4) so the
  // daemon's concurrent broker.publish cannot reuse the value between
  // our MAX(seq) read and the INSERT.
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, kind, correlation_id, source_agent, tenant_id, payload_json,
        at, persisted_at, seq, created_at)
     VALUES (?, 'decision_request', ?, 'bombardment-fixture', NULL, ?, ?, ?, ?, ?)`,
  );

  const correlationIds = [];
  const future = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // MAX(seq) inside the transaction — see comment above.
    const seqRow = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events`).get();
    let nextSeq = seqRow.m + 1;

    for (let i = 0; i < count; i++) {
      const correlationId = `bombardment-fixture-${i}`;
      correlationIds.push(correlationId);
      insertDecision.run(
        correlationId,
        `bombardment fixture question ${i}`,
        JSON.stringify([
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]),
        'a',
        600,
        now,
        future,
      );
      // Deterministic event id keyed on correlation_id — second run
      // of seed against the same named volume sees an existing event
      // and skips (INSERT OR IGNORE), so the events table doesn't
      // accumulate one duplicate decision_request per fixture per run.
      insertEvent.run(
        `bombardment-fixture-evt-${i}`,
        correlationId,
        JSON.stringify({
          question: `bombardment fixture question ${i}`,
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          default_option_id: 'a',
          deadline_seconds: 600,
        }),
        now,
        now,
        nextSeq++,
        now,
      );
    }
  });
  tx();

  db.close();
  console.log(JSON.stringify({ ok: true, count, correlation_ids: correlationIds }));
  process.exit(0);
} catch (err) {
  console.error(`[seed-fixture] ${err.message}`);
  process.exit(1);
}
