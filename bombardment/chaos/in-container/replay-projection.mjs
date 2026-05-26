#!/usr/bin/env node
// Bombardment Phase 4c — in-container helper: rebuild the decisions
// projection from the event log and compare it to the live projection.
//
// What the rebuild knows:
//   - Each `decision_request` event opens a decision (status=open).
//   - A `decision_response` or `decision_late_response` event with the
//     same correlation_id closes it (status=responded or expired). For
//     the simple "open vs. terminal" check the oracle does, both
//     terminal kinds collapse to non-open.
//
// What the rebuild compares:
//   - Per correlation_id: rebuilt status vs. live status.
//   - Per correlation_id: rebuilt-presence vs. live-presence (a row
//     deleted out of band shows as live=missing).
//   - Per correlation_id only seen in the live projection but never in
//     the log — surfaced as "orphan in projection", a corruption shape
//     the daemon should never produce.
//
// Output: one JSON line:
//   {
//     ok: bool,
//     rebuilt_count, live_count,
//     mismatches: [{ correlation_id, rebuilt: {...}, live: {...} }],
//     orphans: [{ correlation_id, live: {...} }]
//   }
//
// Exit: 0 if matches==true, 3 if mismatches/orphans found, 1 on db err.
//
// The exit code is the runner's primary signal — it asserts (a) after
// seed, ok=true; (b) after corruption, ok=false; (c) the mismatch list
// includes both the flipped and the deleted correlation_ids.

import Database from 'better-sqlite3';

const dbPath = process.env.STAVR_DB ?? '/home/stavr/.stavr/runestone.db';
const correlationPrefix = process.argv[2] ?? 'bombardment-fixture-';

try {
  const db = new Database(dbPath, { readonly: true });

  // Pull every event whose correlation_id matches the fixture prefix.
  // Limiting by prefix lets the oracle ignore any unrelated decisions
  // that real daemon traffic may have generated (Phase 4a's chaos seed,
  // a startup-decision-sweep result, etc.).
  const events = db
    .prepare(
      `SELECT kind, correlation_id, source_agent, payload_json, at
         FROM events
        WHERE correlation_id LIKE ?
        ORDER BY seq ASC`,
    )
    .all(`${correlationPrefix}%`);

  // Walk the events and compute rebuilt state per correlation_id.
  const rebuilt = new Map();
  for (const ev of events) {
    let entry = rebuilt.get(ev.correlation_id);
    if (!entry) {
      entry = { status: 'unknown', source_agent: ev.source_agent };
      rebuilt.set(ev.correlation_id, entry);
    }
    if (ev.kind === 'decision_request') {
      // open is the default after we see a request; terminal kinds
      // override below.
      if (entry.status === 'unknown') entry.status = 'open';
    } else if (
      ev.kind === 'decision_response' ||
      ev.kind === 'decision_late_response'
    ) {
      entry.status = ev.kind === 'decision_response' ? 'responded' : 'expired';
    }
  }

  // Pull the live projection rows under the same prefix.
  const liveRows = db
    .prepare(
      `SELECT correlation_id, status, source_agent
         FROM decisions
        WHERE correlation_id LIKE ?`,
    )
    .all(`${correlationPrefix}%`);
  const live = new Map();
  for (const row of liveRows) {
    live.set(row.correlation_id, { status: row.status, source_agent: row.source_agent });
  }

  db.close();

  const mismatches = [];
  for (const [cid, rebuiltEntry] of rebuilt) {
    const liveEntry = live.get(cid);
    if (!liveEntry) {
      mismatches.push({
        correlation_id: cid,
        rebuilt: rebuiltEntry,
        live: { present: false },
      });
      continue;
    }
    if (liveEntry.status !== rebuiltEntry.status) {
      mismatches.push({
        correlation_id: cid,
        rebuilt: rebuiltEntry,
        live: liveEntry,
      });
    }
  }

  const orphans = [];
  for (const [cid, liveEntry] of live) {
    if (!rebuilt.has(cid)) {
      orphans.push({ correlation_id: cid, live: liveEntry });
    }
  }

  const ok = mismatches.length === 0 && orphans.length === 0;
  const summary = {
    ok,
    rebuilt_count: rebuilt.size,
    live_count: live.size,
    mismatches,
    orphans,
  };
  console.log(JSON.stringify(summary));
  process.exit(ok ? 0 : 3);
} catch (err) {
  console.error(`[replay-projection] ${err.message}`);
  process.exit(1);
}
