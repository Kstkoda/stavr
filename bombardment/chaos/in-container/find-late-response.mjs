#!/usr/bin/env node
// Bombardment Phase 4a — in-container helper: look up whether a
// `decision_late_response` event has landed for a given correlation_id.
//
// Invoked from the runner after the daemon restarts:
//   docker exec stavr-peer-a node /app/bombardment-chaos/find-late-response.mjs <correlation_id>
//
// The startupDecisionSweep publishes one decision_late_response per
// open-and-expired decision it finds at boot. We assert by reading the
// events table directly (the broker emits the event through publish,
// which writes it to events; same DB, same table, no need to subscribe
// over HTTP).
//
// Exit codes:
//   0 — late_response event was found, printed as JSON on stdout
//   1 — DB unreachable / query failed
//   2 — bad invocation
//   3 — no matching event (test FAIL — bubbled up by the oracle)

import Database from 'better-sqlite3';

const correlationId = process.argv[2];
if (!correlationId) {
  console.error('usage: find-late-response.mjs <correlation_id>');
  process.exit(2);
}

const dbPath = process.env.STAVR_DB ?? '/home/stavr/.stavr/runestone.db';

try {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT id, kind, correlation_id, source_agent, at, payload_json
         FROM events
        WHERE correlation_id = ?
          AND kind = 'decision_late_response'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(correlationId);
  db.close();

  if (!row) {
    console.log(JSON.stringify({ found: false, correlation_id: correlationId }));
    process.exit(3);
  }
  console.log(JSON.stringify({ found: true, event: row }));
  process.exit(0);
} catch (err) {
  console.error(`[find-late-response] ${err.message}`);
  process.exit(1);
}
