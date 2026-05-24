#!/usr/bin/env node
// Bombardment Phase 3b — wait for every container in the compose
// topology to report `healthy` via `docker inspect`.
//
// The Dockerfile's HEALTHCHECK polls /healthz; this script just
// aggregates the per-container state so the oracle runner (and the
// CI workflow) can block until the whole federation is up. Without
// this, the oracle runner races the daemon's HTTP listener and
// flakes — a known pattern from peer-smoke.mjs.
//
// Exit codes:
//   0 — every container healthy within the budget
//   1 — one or more containers timed out, reported unhealthy, or are missing

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CONTAINERS = ['stavr-peer-a', 'stavr-peer-b', 'stavr-hub'];
const BUDGET_SECONDS = Number(process.env.STAVR_BOMBARDMENT_WAIT_SECONDS ?? 120);
const POLL_INTERVAL_MS = 2000;

function inspectHealth(container) {
  const r = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Health.Status}}', container],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return 'missing';
  return (r.stdout ?? '').trim() || 'unknown';
}

async function main() {
  const deadline = Date.now() + BUDGET_SECONDS * 1000;
  let lastStates = {};
  while (Date.now() < deadline) {
    const states = Object.fromEntries(CONTAINERS.map((c) => [c, inspectHealth(c)]));
    if (JSON.stringify(states) !== JSON.stringify(lastStates)) {
      console.log(`[wait-for-healthy] states=${JSON.stringify(states)}`);
      lastStates = states;
    }
    if (CONTAINERS.every((c) => states[c] === 'healthy')) {
      console.log('[wait-for-healthy] all containers healthy');
      process.exit(0);
    }
    if (CONTAINERS.some((c) => states[c] === 'unhealthy')) {
      console.error(`[wait-for-healthy] unhealthy container detected: ${JSON.stringify(states)}`);
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.error(`[wait-for-healthy] timeout after ${BUDGET_SECONDS}s: ${JSON.stringify(lastStates)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[wait-for-healthy] error: ${err.message}`);
  process.exit(1);
});
