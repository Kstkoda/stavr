#!/usr/bin/env node
// Bombardment Phase 3d — recovery-slice driver.
//
// Runs the destructive `peer_unreachable_recovery` oracle. NOT in the
// default oracle set because it mutates the topology (docker pause /
// unpause); operator must invoke it explicitly.
//
// Usage:
//   node bombardment/federation/run-recovery-slice.mjs
//
// Tunables (env):
//   STAVR_BOMBARDMENT_RECOVERY_BUDGET_MS  total budget,  default 180_000
//   STAVR_BOMBARDMENT_RECOVERY_PAUSE_MS   pause duration, default  10_000
//
// Exit codes: 0 on pass, 1 on fail.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peerUnreachableRecovery } from './oracles/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, '..', 'artifacts');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

async function main() {
  console.log('[run-recovery-slice] invoking peer_unreachable_recovery oracle');
  const result = await peerUnreachableRecovery();
  const tag = result.ok === true ? 'PASS' : 'FAIL';
  console.log(
    `[run-recovery-slice] ${tag} (${result.durationMs}ms)` +
      (result.reason ? ` — ${result.reason}` : ''),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = join(ARTIFACTS_DIR, `recovery-slice-${stamp}.json`);
  writeFileSync(artifact, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[run-recovery-slice] artifact: ${artifact}`);

  process.exit(result.ok === true ? 0 : 1);
}

main().catch((err) => {
  console.error(`[run-recovery-slice] runner error: ${err.message}`);
  process.exit(1);
});
