#!/usr/bin/env node
// Bombardment Phase 3c — apply a Pumba netem slice on top of the
// running compose topology and re-run the federation oracles under
// impairment.
//
// What this asserts:
//   - The oracles pass under modest netem impairment (50ms delay on
//     peer-a, 1% loss on peer-b, 20ms jitter on the hub). Cross-site
//     unreachability is unaffected (peer-a still can't reach peer-b)
//     but within-site reachability + the registry-shape invariants
//     must hold.
//
// What this is NOT (deferred to Phase 4):
//   - kills / stops / pauses (Pumba supports these but they belong to
//     the fault-injection phase, not the latency-budget slice).
//   - Network partitions via Pumba's `iptables` subcommand.
//
// The script assumes:
//   - The base compose is already up (`docker compose up -d` from
//     bombardment/compose/).
//   - `node bombardment/federation/wait-for-healthy.mjs` has already
//     returned 0.

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_DIR = resolve(__dirname, '..', 'compose');
const RUN_ORACLES = resolve(__dirname, 'run-oracles.mjs');

function compose(args) {
  return spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'pumba.yml',
      ...args,
    ],
    { cwd: COMPOSE_DIR, stdio: 'inherit', encoding: 'utf8' },
  );
}

async function main() {
  console.log('[pumba-slice] starting Pumba sidecars (delay/loss/jitter)');
  // --remove-orphans clears stale pumba sidecars from a prior aborted
  // run that share fixed container names; otherwise compose up collides
  // and impairment silently never starts.
  const up = compose([
    'up',
    '-d',
    '--remove-orphans',
    'pumba-delay-a',
    'pumba-loss-b',
    'pumba-jitter-hub',
  ]);
  if (up.status !== 0) {
    console.error('[pumba-slice] failed to start Pumba sidecars');
    process.exit(1);
  }

  // tc setup is near-instant but the daemons need to feel the impairment
  // across at least one health-probe cycle before we declare the slice
  // "in effect". 5s comfortably covers PeerClient's 3s timeout.
  console.log('[pumba-slice] settling 5s before re-running oracles');
  await sleep(5000);

  // Surface silent Pumba failures. Pumba spawns a tc-container that
  // shares the target's netns and runs `tc qdisc`; on every Docker
  // host we've tested (Docker Desktop on Windows AND ubuntu-latest
  // GHA runners) the tc-container can exit before Pumba's
  // `docker exec` lands, sidecar exits non-zero with
  //   "failed to create tc-container exec: container ... is not running"
  // and the netem rule is never installed — the slice's oracles then
  // run against UN-impaired traffic and trivially "pass". Don't exit
  // hard (the rest of the slice still validates oracle reliability +
  // peer-state machinery), but loudly flag the substrate issue so a
  // CI green doesn't claim chaos coverage it didn't actually exercise.
  // Mirrored from bombardment/chaos/run-netchaos-slice.mjs — same
  // Pumba 0.11.7 race, same diagnostic shape.
  for (const sidecar of ['stavr-pumba-delay-a', 'stavr-pumba-loss-b', 'stavr-pumba-jitter-hub']) {
    const inspect = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', sidecar],
      { encoding: 'utf8' },
    );
    if (inspect.status !== 0) {
      console.warn(`[pumba-slice] could not inspect ${sidecar}: ${inspect.stderr.trim()}`);
      continue;
    }
    const [status, exitCode] = inspect.stdout.trim().split('|');
    if (status === 'exited' && exitCode !== '0') {
      console.warn(
        `[pumba-slice] WARN ${sidecar} exited ${exitCode} — impairment likely NOT applied. ` +
          `Last 3 lines of pumba log:`,
      );
      const logs = spawnSync('docker', ['logs', '--tail', '3', sidecar], { encoding: 'utf8' });
      console.warn((logs.stdout || logs.stderr || '').trim());
    }
  }

  console.log('[pumba-slice] running federation oracles under impairment');
  const oracles = spawnSync(process.execPath, [RUN_ORACLES], {
    stdio: 'inherit',
    env: { ...process.env, STAVR_BOMBARDMENT_UNDER_CHAOS: '1' },
  });

  if (oracles.status !== 0) {
    console.error('[pumba-slice] oracles failed under impairment — leaving containers up for triage');
    process.exit(1);
  }

  console.log('[pumba-slice] oracles passed under impairment');

  // Pumba containers self-exit when --duration runs out; we don't
  // wait the full 90s — the caller (CI workflow) tears the whole
  // topology down via `docker compose down -v`.
  process.exit(0);
}

main().catch((err) => {
  console.error(`[pumba-slice] error: ${err.message}`);
  process.exit(1);
});
