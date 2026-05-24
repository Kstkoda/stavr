#!/usr/bin/env node
// Bombardment Phase 4c — in-container helper: corrupt the projection
// out of band so the rebuild oracle has something to detect.
//
// The corruption is intentionally surgical and pure-projection: we
// flip the `status` column on a specific decision row to 'responded'
// WITHOUT writing a corresponding `decision_response` event. That is
// exactly the shape of drift the rebuild-from-log oracle is built to
// catch: the projection says "responded", the log says "no response
// ever happened", and the truth lives in the log.
//
// We also delete a second row entirely — same shape, more aggressive.
// A full-row delete is the worst-case projection corruption (e.g., a
// botched migration that dropped rows): the rebuild must reproduce the
// row from the log.
//
// Usage:
//   docker exec stavr-peer-a node /opt/bombardment-chaos/corrupt-projection.mjs <flip_id> <delete_id>
//
// Output: one JSON line summarising what changed.
// Exit: 0 ok / 1 db err / 2 bad invocation.

import Database from 'better-sqlite3';

const flipId = process.argv[2];
const deleteId = process.argv[3];
if (!flipId || !deleteId) {
  console.error('usage: corrupt-projection.mjs <flip_correlation_id> <delete_correlation_id>');
  process.exit(2);
}

const dbPath = process.env.STAVR_DB ?? '/home/stavr/.stavr/runestone.db';

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const flip = db
    .prepare(
      `UPDATE decisions
          SET status='responded',
              responded_at=?,
              responded_by='out-of-band-corruption',
              chosen_option_id='a',
              response_reason='injected by bombardment Phase 4c'
        WHERE correlation_id=?`,
    )
    .run(new Date().toISOString(), flipId);

  const dropped = db.prepare(`DELETE FROM decisions WHERE correlation_id=?`).run(deleteId);

  db.close();
  console.log(
    JSON.stringify({
      ok: true,
      flipped: { correlation_id: flipId, rows: flip.changes },
      deleted: { correlation_id: deleteId, rows: dropped.changes },
    }),
  );
  process.exit(0);
} catch (err) {
  console.error(`[corrupt-projection] ${err.message}`);
  process.exit(1);
}
