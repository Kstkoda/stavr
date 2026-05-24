#!/usr/bin/env node
// Bombardment Phase 4b — heavier network-chaos slice driver.
//
// Applies the netchaos.yml overlay (500ms latency spike + 100ms
// jitter on peer-a, 10% loss on peer-b) and re-runs the Phase 3d
// federation oracle set under the heavier impairment. Pass criteria:
// every oracle that passed under Phase 3c's modest budget still
// passes under this one.
//
// Pre-conditions:
//   - `docker compose up -d` (base topology) is running.
//   - `bombardment/federation/wait-for-healthy.mjs` returned 0.
//
// Does NOT compose with run-pumba-slice.mjs — pick one impairment
// budget per run. The Phase 4b assertion is that the bigger budget
// is also safe.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_DIR = resolve(__dirname, '..', 'compose');
const RUN_ORACLES = resolve(__dirname, '..', 'federation', 'run-oracles.mjs');

function compose(args) {
  return spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'netchaos.yml',
      ...args,
    ],
    { cwd: COMPOSE_DIR, stdio: 'inherit', encoding: 'utf8' },
  );
}

async function main() {
  console.log('[netchaos-slice] starting heavier Pumba impairment (spike + 10% loss)');
  // --remove-orphans clears stale pumba sidecars from a prior aborted
  // run that share the fixed container names (stavr-pumba-spike-peer-a,
  // stavr-pumba-loss-peer-b). Without this, `compose up -d` collides
  // with the stale container and the impairment silently never starts —
  // oracles then pass against UN-impaired traffic (false negative).
  const up = compose([
    'up',
    '-d',
    '--remove-orphans',
    'pumba-spike-peer-a',
    'pumba-loss-peer-b',
  ]);
  if (up.status !== 0) {
    console.error('[netchaos-slice] failed to start netchaos sidecars');
    process.exit(1);
  }

  // tc setup is near-instant; the daemons need to feel the impairment
  // through at least one client cycle before we run the oracles. 8s
  // covers a probe round-trip even at the worst-case latency budget.
  console.log('[netchaos-slice] settling 8s before re-running oracles');
  await sleep(8000);

  console.log('[netchaos-slice] running federation oracles under heavier impairment');
  const oracles = spawnSync(process.execPath, [RUN_ORACLES], {
    stdio: 'inherit',
    env: { ...process.env, STAVR_BOMBARDMENT_UNDER_CHAOS: '1' },
  });

  if (oracles.status !== 0) {
    console.error(
      '[netchaos-slice] oracles failed under heavier impairment — leaving containers up for triage',
    );
    // Intentionally do NOT stop the pumba sidecars on failure: leave
    // the impairment running so the operator can inspect tc state /
    // peer-a's eth0 / etc. The CI workflow's teardown will clear them.
    process.exit(1);
  }

  console.log('[netchaos-slice] oracles passed — stopping Pumba sidecars');
  // Explicitly stop the sidecars so subsequent slices (e.g., the
  // projection-corruption step in the CI workflow) don't run with
  // ~30s of remaining 500ms-latency impairment overlapping on peer-a.
  // The sidecars would self-exit at --duration=120s anyway, but the
  // overlap window matters: docker exec via the docker socket isn't
  // affected by netem, but the daemon's HTTP listener IS, and a
  // busier daemon increases SQLITE_BUSY probability for the
  // projection-corruption's separate sqlite handle.
  const stop = compose(['stop', 'pumba-spike-peer-a', 'pumba-loss-peer-b']);
  if (stop.status !== 0) {
    console.warn(
      '[netchaos-slice] compose stop of pumba sidecars returned non-zero ' +
        '(impairment self-expires at --duration=120s — slice still considered passing)',
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[netchaos-slice] error: ${err.message}`);
  process.exit(1);
});
