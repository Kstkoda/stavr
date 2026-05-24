#!/usr/bin/env node
// Bombardment Phase 4a — in-container helper: seed an open decision
// row directly into the projection with a past expires_at.
//
// Invoked from the runner via:
//   docker exec stavr-peer-a node /opt/bombardment-chaos/seed-decision.mjs <correlation_id>
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
// Exit codes:
//   0 — row inserted (or already existed)
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

  // INSERT OR IGNORE so re-running the seed in a re-driven oracle is
  // idempotent — second invocation is a no-op if the row already exists.
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO decisions
         (correlation_id, question, options_json, default_option_id,
          timeout_sec, status, requested_at, expires_at, source_agent, tier)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'bombardment-chaos', 'TIER_1')`,
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

  db.close();

  console.log(
    JSON.stringify({
      ok: true,
      correlation_id: correlationId,
      inserted: info.changes === 1,
      expires_at: past,
    }),
  );
  process.exit(0);
} catch (err) {
  console.error(`[seed-decision] ${err.message}`);
  process.exit(1);
}
