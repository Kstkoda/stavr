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

  // Surface silent Pumba failures. Pumba spawns a tc-container that
  // shares the target's netns and runs `tc qdisc`; on some Docker
  // hosts (notably Docker Desktop on Windows/WSL2) the tc-container
  // can exit before Pumba's `docker exec` lands, and the netem rule
  // is never installed — sidecar exits non-zero with
  //   "failed to create tc-container exec: container ... is not running"
  // — and the rest of the slice runs against UN-impaired traffic,
  // turning the "oracles pass under heavy impairment" assertion into
  // "oracles pass against clean traffic" (false negative on clean
  // runs, false positive if the oracle is over-strict). Don't exit
  // hard — the rest of the slice still validates oracle reliability —
  // but loudly flag the substrate issue so a CI green doesn't claim
  // chaos coverage it didn't actually exercise.
  // F10: also count which sidecars successfully installed netem so we
  // can gate STAVR_BOMBARDMENT_UNDER_CHAOS=1 on actually-applied
  // impairment. Pumba runs as a `--duration=120s` one-shot — during
  // the settle window the sidecar should still be `running`; an
  // `exited` status means the netem call failed (the tc-container
  // race) and no tc qdisc was ever installed. Without this gate,
  // oracles would run in chaos-mode (with widened tolerances) against
  // UN-impaired traffic — a free pass that hides regressions on
  // clean runs.
  let sidecarSuccessCount = 0;
  for (const sidecar of ['stavr-pumba-spike-peer-a', 'stavr-pumba-loss-peer-b']) {
    const inspect = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', sidecar],
      { encoding: 'utf8' },
    );
    if (inspect.status !== 0) {
      console.warn(`[netchaos-slice] could not inspect ${sidecar}: ${inspect.stderr.trim()}`);
      continue;
    }
    const [status, exitCode] = inspect.stdout.trim().split('|');
    if (status === 'exited' && exitCode !== '0') {
      console.warn(
        `[netchaos-slice] WARN ${sidecar} exited ${exitCode} — impairment likely NOT applied. ` +
          `Last 3 lines of pumba log:`,
      );
      const logs = spawnSync('docker', ['logs', '--tail', '3', sidecar], { encoding: 'utf8' });
      console.warn((logs.stdout || logs.stderr || '').trim());
    } else {
      // Still running (--duration not yet elapsed) — netem is installed.
      sidecarSuccessCount++;
    }
  }

  const underChaos = sidecarSuccessCount > 0;
  if (!underChaos) {
    console.warn(
      '[netchaos-slice] NO sidecars applied impairment — running oracles in STRICT (non-chaos) mode',
    );
  } else {
    console.log(
      `[netchaos-slice] ${sidecarSuccessCount} sidecar(s) applied impairment — running oracles UNDER_CHAOS`,
    );
  }

  console.log('[netchaos-slice] running federation oracles');
  // Build a clean env without UNDER_CHAOS, then add it back only when
  // at least one sidecar succeeded. Stripping first guards against an
  // upstream env that already set the flag.
  const oracleEnv = { ...process.env };
  delete oracleEnv.STAVR_BOMBARDMENT_UNDER_CHAOS;
  if (underChaos) oracleEnv.STAVR_BOMBARDMENT_UNDER_CHAOS = '1';
  const oracles = spawnSync(process.execPath, [RUN_ORACLES], {
    stdio: 'inherit',
    env: oracleEnv,
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
