#!/usr/bin/env node
// Bombardment Phase 4a — in-container helper: seed an open decision
// row + a matching `decision_request` event directly into the
// projection + event log, both with a past expires_at.
//
// Invoked from the runner via:
//   docker exec stavr-peer-a node /app/bombardment-chaos/seed-decision.mjs <correlation_id>
//
// The row is intentionally written through better-sqlite3 (NOT through
// the daemon's createDecision / publish path), because the test we're
// setting up is "decision opened by the daemon process, daemon killed
// before responding, daemon restarts and the startupDecisionSweep
// closes it via decision_late_response". To make that observable on a
// fresh test run without driving a real MCP `await_decision` call from
// outside, we put the row in `status='open'` with an `expires_at` in
// the past — semantically identical to a decision that opened then
// timed out while the process was down.
//
// We ALSO write a matching `decision_request` event for two reasons:
//   - It satisfies the rebuild-from-log invariant (every projected
//     decision has at least one corresponding request event in the
//     log). Without it, the chaos seed leaves an orphan row that
//     would break a stricter replay oracle.
//   - It guarantees the SSE consumer's baseline window in the
//     kill-recovery oracle sees at least one event id, so the
//     subsequent reconnect can actually exercise `?since_id=` rather
//     than silently falling back to the no-filter full-history
//     replay path.
//
// Both inserts are idempotent (deterministic event id derived from
// correlation_id + INSERT OR IGNORE on both tables) and live inside a
// single transaction. `nextSeq` is read inside the transaction so
// the daemon's concurrent writes cannot race the seq value.
//
// Exit codes:
//   0 — row + event inserted (or already existed)
//   1 — DB unreachable / insert failed
//   2 — bad invocation (no correlation_id)
//
// Output: one JSON line on stdout summarising what was written.

import Database from 'better-sqlite3';

const correlationId = process.argv[2];
if (!correlationId) {
  console.error('usage: seed-decision.mjs <correlation_id>');
  process.exit(2);
}

const dbPath = process.env.STAVR_DB ?? '/home/stavr/.stavr/runestone.db';

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // expires_at is set 5s in the past so the daemon's startup sweep
  // (which compares expires_at to Date.now() inside sweepExpiredDecisions)
  // unambiguously fires on the very next process boot. Likewise
  // requested_at — keeps the row internally consistent for any later
  // dashboard read.
  const now = Date.now();
  const past = new Date(now - 5000).toISOString();
  const nowIso = new Date(now).toISOString();

  // Deterministic event id derived from correlation_id so re-runs of
  // the seed against the same volume don't insert duplicate events.
  const eventId = `bombardment-chaos-evt-${correlationId}`;

  const result = db.transaction(() => {
    const decisionInfo = db
      .prepare(
        `INSERT OR IGNORE INTO decisions
           (correlation_id, question, options_json, default_option_id,
            timeout_sec, status, requested_at, expires_at, source_agent, tier)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'bombardment-chaos', 'CONFIRM')`,
      )
      .run(
        correlationId,
        'bombardment chaos seed — should be swept on restart',
        JSON.stringify([{ id: 'a', label: 'A' }]),
        'a',
        1,
        past,
        past,
      );

    // nextSeq inside the transaction so the daemon's concurrent
    // broker.publish cannot reuse the same seq value between our read
    // and write. events.seq has only an INDEX, not a UNIQUE constraint
    // (persistence.ts), so duplicate seq would land silently otherwise.
    const seqRow = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events`).get();
    const nextSeq = seqRow.m + 1;

    const eventInfo = db
      .prepare(
        `INSERT OR IGNORE INTO events
           (id, kind, correlation_id, source_agent, tenant_id, payload_json,
            at, persisted_at, seq, created_at)
         VALUES (?, 'decision_request', ?, 'bombardment-chaos', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        correlationId,
        JSON.stringify({
          question: 'bombardment chaos seed — should be swept on restart',
          options: [{ id: 'a', label: 'A' }],
          default_option_id: 'a',
          deadline_seconds: 1,
        }),
        past,
        nowIso,
        nextSeq,
        nowIso,
      );

    return {
      decision_inserted: decisionInfo.changes === 1,
      event_inserted: eventInfo.changes === 1,
      event_id: eventId,
      event_seq: nextSeq,
    };
  })();

  db.close();

  console.log(
    JSON.stringify({
      ok: true,
      correlation_id: correlationId,
      expires_at: past,
      ...result,
    }),
  );
  process.exit(0);
} catch (err) {
  console.error(`[seed-decision] ${err.message}`);
  process.exit(1);
}
