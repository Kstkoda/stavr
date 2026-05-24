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
//   docker exec stavr-peer-a node /opt/bombardment-chaos/seed-projection-fixture.mjs <count>
//
// Output (stdout): one JSON line { ok, count, correlation_ids }.
// Idempotent — re-running with the same count is a no-op (INSERT OR IGNORE).
//
// Exit: 0 ok / 1 db err / 2 bad invocation.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'bombardment-fixture', 'TIER_1')`,
  );

  // We push events through a direct INSERT because broker.publish lives
  // in the daemon process and we don't share that here. The events
  // table schema (persistence.ts:168) requires: id, kind, correlation_id,
  // source_agent, tenant_id (nullable), payload_json, at, persisted_at,
  // seq, created_at.
  const nextSeqRow = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events`).get();
  let nextSeq = nextSeqRow.m + 1;

  const insertEvent = db.prepare(
    `INSERT INTO events
       (id, kind, correlation_id, source_agent, tenant_id, payload_json,
        at, persisted_at, seq, created_at)
     VALUES (?, 'decision_request', ?, 'bombardment-fixture', NULL, ?, ?, ?, ?, ?)`,
  );

  const correlationIds = [];
  const future = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
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
      insertEvent.run(
        randomUUID(),
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
