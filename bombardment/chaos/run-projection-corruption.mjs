#!/usr/bin/env node
// Bombardment Phase 4c — projection-corruption + rebuild-from-log driver.
//
// Five-step lifecycle, each step asserted:
//
//   1. Seed N (decision row, decision_request event) fixture pairs in
//      peer-a's projection + event log.
//   2. Replay: read events, reconstruct expected state, compare to
//      live projection. ASSERT: ok=true (everything matches).
//   3. Corrupt: out of band, flip one decision's status to 'responded'
//      and delete another row entirely. NO events written — the log
//      stays clean; the projection is now lying.
//   4. Replay again. ASSERT: ok=false (the rebuild detects both
//      injected mismatches).
//   5. ASSERT the mismatch list specifically includes both the
//      flipped and the deleted correlation_ids. Anything else and the
//      rebuild oracle is finding noise.
//
// What this proves: the event log is the source of truth and the
// projection is derivable from it; corruption in the projection is
// detectable by rebuilding from the log and comparing. The rebuild
// itself runs from the rig side (in-container helper) — a
// daemon-side rebuildProjectionFromLog() function is a separate
// cycle's deliverable (recon §6).
//
// Cleanup: the seeded fixtures are left in place (rig-internal
// correlation_ids prefixed bombardment-fixture-) — a fresh `docker
// compose down -v` removes the named volume and clears them. The
// corrupted projection is also left in place so an operator triaging
// CI can inspect.
//
// Exit: 0 if all assertions hold, 1 otherwise.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPOLOGY } from '../federation/topology.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const TARGET_ID = 'peer-a';
const FIXTURE_COUNT = Number(process.env.STAVR_BOMBARDMENT_FIXTURE_COUNT ?? 5);
const target = TOPOLOGY.peers.find((p) => p.id === TARGET_ID);

function exec(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function execInContainer(scriptPath, ...args) {
  return exec(['exec', target.container, 'node', scriptPath, ...args]);
}

// Return-style parse: callers route parse failures through fail()
// so the artifact is still written with full diagnostic context
// (transcript + exec stdout/stderr/status). Throwing here would crash
// past `pass()` / `fail()` into main().catch with a generic message
// and no artifact — exactly what review finding #6 flagged.
function tryParseJson(execResult, ctx) {
  try {
    return { ok: true, value: JSON.parse(execResult.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason:
        `${ctx}: failed to parse exec stdout as JSON ` +
        `(exit=${execResult.status}, parse_err=${err.message})`,
      diagnostic: {
        exit: execResult.status,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
      },
    };
  }
}

function fail(transcript, reason, start, diagnostic) {
  const result = {
    name: 'chaos_projection_corruption_rebuild',
    ok: false,
    reason,
    transcript,
    ...(diagnostic ? { diagnostic } : {}),
    durationMs: Date.now() - start,
  };
  emit(result);
  process.exit(1);
}

function pass(transcript, start) {
  const result = {
    name: 'chaos_projection_corruption_rebuild',
    ok: true,
    transcript,
    durationMs: Date.now() - start,
  };
  emit(result);
  process.exit(0);
}

function emit(result) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = join(ARTIFACTS_DIR, `projection-corruption-${stamp}.json`);
  writeFileSync(artifact, JSON.stringify(result, null, 2), 'utf8');
  const tag = result.ok ? 'PASS' : 'FAIL';
  console.log(
    `[run-projection-corruption] ${tag} (${result.durationMs}ms)` +
      (result.reason ? ` — ${result.reason}` : ''),
  );
  console.log(`[run-projection-corruption] artifact: ${artifact}`);
}

async function main() {
  const start = Date.now();
  const transcript = [];

  // 1) Seed fixture.
  console.log(`[run-projection-corruption] seeding ${FIXTURE_COUNT} fixture pairs in ${target.container}`);
  const seed = execInContainer('/opt/bombardment-chaos/seed-projection-fixture.mjs', String(FIXTURE_COUNT));
  if (seed.status !== 0) {
    fail(transcript, `seed failed: ${seed.stderr || seed.stdout}`, start);
  }
  const seedParse = tryParseJson(seed, 'seed');
  if (!seedParse.ok) {
    fail(transcript, seedParse.reason, start, seedParse.diagnostic);
  }
  const seedSummary = seedParse.value;
  transcript.push({ phase: 'seed', summary: seedSummary });
  if (seedSummary.correlation_ids.length < 2) {
    fail(transcript, 'seed produced fewer than 2 fixtures — need at least 2 for flip + delete', start);
  }

  // 2) Pre-corruption replay. Must match.
  console.log('[run-projection-corruption] replay before corruption — expecting clean');
  const preReplay = execInContainer('/opt/bombardment-chaos/replay-projection.mjs');
  // replay-projection exits 1 (DB unreachable) to stderr only — parse
  // failure on empty stdout would otherwise crash past fail() into
  // main().catch with no artifact (review finding #6).
  const preParse = tryParseJson(preReplay, 'pre-replay');
  if (!preParse.ok) {
    fail(transcript, preParse.reason, start, preParse.diagnostic);
  }
  const preSummary = preParse.value;
  transcript.push({ phase: 'pre_corruption_replay', summary: preSummary, exit: preReplay.status });
  if (preReplay.status !== 0 || preSummary.ok !== true) {
    fail(
      transcript,
      `pre-corruption replay was not clean (exit=${preReplay.status}, mismatches=${preSummary.mismatches.length}, orphans=${preSummary.orphans.length}) — fixture is inconsistent`,
      start,
    );
  }

  // 3) Corrupt.
  const flipId = seedSummary.correlation_ids[0];
  const deleteId = seedSummary.correlation_ids[1];
  console.log(`[run-projection-corruption] corrupting projection — flip=${flipId} delete=${deleteId}`);
  const corrupt = execInContainer('/opt/bombardment-chaos/corrupt-projection.mjs', flipId, deleteId);
  if (corrupt.status !== 0) {
    fail(transcript, `corrupt failed: ${corrupt.stderr || corrupt.stdout}`, start);
  }
  const corruptParse = tryParseJson(corrupt, 'corrupt');
  if (!corruptParse.ok) {
    fail(transcript, corruptParse.reason, start, corruptParse.diagnostic);
  }
  const corruptSummary = corruptParse.value;
  transcript.push({ phase: 'corrupt', summary: corruptSummary });
  if (corruptSummary.flipped.rows !== 1 || corruptSummary.deleted.rows !== 1) {
    fail(
      transcript,
      `corrupt did not touch exactly one row each (flipped=${corruptSummary.flipped.rows}, deleted=${corruptSummary.deleted.rows})`,
      start,
    );
  }

  // 4) Post-corruption replay. Must mismatch.
  console.log('[run-projection-corruption] replay after corruption — expecting mismatches');
  const postReplay = execInContainer('/opt/bombardment-chaos/replay-projection.mjs');
  const postParse = tryParseJson(postReplay, 'post-replay');
  if (!postParse.ok) {
    fail(transcript, postParse.reason, start, postParse.diagnostic);
  }
  const postSummary = postParse.value;
  transcript.push({ phase: 'post_corruption_replay', summary: postSummary, exit: postReplay.status });
  if (postReplay.status === 0 || postSummary.ok === true) {
    fail(
      transcript,
      'replay after corruption returned clean — rebuild-from-log oracle FAILED to detect the injected drift',
      start,
    );
  }

  // 5) Mismatch shape sanity — both injected correlation_ids must appear.
  const mismatchIds = new Set(postSummary.mismatches.map((m) => m.correlation_id));
  if (!mismatchIds.has(flipId)) {
    fail(transcript, `flipped correlation_id ${flipId} not in mismatches`, start);
  }
  if (!mismatchIds.has(deleteId)) {
    fail(transcript, `deleted correlation_id ${deleteId} not in mismatches`, start);
  }

  pass(transcript, start);
}

main().catch((err) => {
  console.error(`[run-projection-corruption] runner error: ${err.message}`);
  process.exit(1);
});
