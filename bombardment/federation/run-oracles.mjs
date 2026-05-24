#!/usr/bin/env node
// Bombardment Phase 3d — federation oracle runner.
//
// Invoked by the bombardment-docker CI workflow after
// wait-for-healthy.mjs returns. Runs the default (read-only)
// federation oracle set against the live compose topology and
// exits non-zero if any oracle fails.
//
// First it waits one peer-client ping cycle (default 65s) so the
// peer-state-convergence oracle has fresh data to assert against.
// The wait is skippable for fast iteration via
// STAVR_BOMBARDMENT_SKIP_CONVERGENCE_WAIT=1.
//
// Output:
//   bombardment/artifacts/federation-oracles-<ts>.json
//
// Exit codes:
//   0 — every oracle passed
//   1 — one or more oracles failed (evidence in the JSON artifact)

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultFederationOracles } from './oracles/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const CONVERGENCE_WAIT_SECONDS = Number(
  process.env.STAVR_BOMBARDMENT_CONVERGENCE_WAIT_SECONDS ?? 65,
);
const SKIP_WAIT = process.env.STAVR_BOMBARDMENT_SKIP_CONVERGENCE_WAIT === '1';

async function main() {
  if (!SKIP_WAIT) {
    console.log(
      `[run-oracles] waiting ${CONVERGENCE_WAIT_SECONDS}s for peer-client convergence ` +
        `(set STAVR_BOMBARDMENT_SKIP_CONVERGENCE_WAIT=1 to skip)`,
    );
    await sleep(CONVERGENCE_WAIT_SECONDS * 1000);
  }

  const oracles = defaultFederationOracles();
  const results = [];
  const start = Date.now();

  for (const oracle of oracles) {
    const name = oracle.name || '<anonymous>';
    process.stdout.write(`[run-oracles] running ${name}... `);
    try {
      const result = await oracle();
      results.push(result);
      const tag = result.ok === true ? 'PASS' : result.ok === false ? 'FAIL' : 'SKIP';
      console.log(`${tag} (${result.durationMs}ms)${result.reason ? ' — ' + result.reason : ''}`);
    } catch (err) {
      results.push({
        name,
        ok: false,
        reason: `oracle threw: ${err.message}`,
        durationMs: 0,
      });
      console.log(`FAIL — threw: ${err.message}`);
    }
  }

  const summary = {
    started_at: new Date(start).toISOString(),
    duration_ms: Date.now() - start,
    under_chaos: process.env.STAVR_BOMBARDMENT_UNDER_CHAOS === '1',
    passed: results.filter((r) => r.ok === true).length,
    failed: results.filter((r) => r.ok === false).length,
    declined: results.filter((r) => r.ok === null).length,
    results,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = join(ARTIFACTS_DIR, `federation-oracles-${stamp}.json`);
  writeFileSync(artifact, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[run-oracles] summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.declined} declined`);
  console.log(`[run-oracles] artifact: ${artifact}`);

  process.exit(summary.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[run-oracles] runner error: ${err.message}`);
  process.exit(1);
});
