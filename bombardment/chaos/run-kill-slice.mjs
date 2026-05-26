#!/usr/bin/env node
// Bombardment Phase 4a — kill-slice driver.
//
// Runs the kill-recovery oracle against the live compose topology.
// Destructive (SIGKILLs peer-a, relies on the docker restart-policy
// to bring it back), so NOT in any default oracle set — operator-
// invoked, or invoked from the bombardment-docker CI workflow's
// dedicated "chaos: kill" step.
//
// Pre-conditions:
//   - `docker compose up -d` (base compose) has been run.
//   - `bombardment/federation/wait-for-healthy.mjs` returned 0.
//
// Tunables (env):
//   STAVR_BOMBARDMENT_RESTART_BUDGET_MS  /healthz recovery budget (default 90_000)
//   STAVR_BOMBARDMENT_SWEEP_BUDGET_MS    decision_late_response budget (default 30_000)
//
// Exit codes: 0 = pass, 1 = fail. Artifact at
// bombardment/artifacts/kill-slice-<ts>.json carries the transcript.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killRecovery } from './oracles/kill-recovery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

async function main() {
  console.log('[run-kill-slice] invoking chaos_kill_recovery oracle');
  const result = await killRecovery();
  const tag = result.ok === true ? 'PASS' : 'FAIL';
  console.log(
    `[run-kill-slice] ${tag} (${result.durationMs}ms)` +
      (result.reason ? ` — ${result.reason}` : ''),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = join(ARTIFACTS_DIR, `kill-slice-${stamp}.json`);
  writeFileSync(artifact, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[run-kill-slice] artifact: ${artifact}`);

  process.exit(result.ok === true ? 0 : 1);
}

main().catch((err) => {
  console.error(`[run-kill-slice] runner error: ${err.message}`);
  process.exit(1);
});
