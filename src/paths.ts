import { homedir } from 'node:os';
import { join } from 'node:path';

// Bombardment Phase 0 follow-up — peer-smoke CI failure root cause
// (recon item 3 follow-up): defaultDbPath() previously hardcoded
// join(homedir(), '.stavr', 'runestone.db') and ignored STAVR_HOME.
// config.ts, daemon.ts, devices-storage.ts and federation/peers.ts
// all honor STAVR_HOME; paths.ts forgot. Result: a smoke that
// spawned two daemons with isolated STAVR_HOME each still pointed
// both at the shared default runestone.db and raced schema init —
// observed locally during peer-smoke verification and confirmed on
// CI.
//
// MINIMAL fix: a single stavrHome() resolver using the canonical
// `process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr')`
// shape the other modules use. The 4 duplicate resolvers across
// config.ts / daemon.ts / devices-storage.ts / federation/peers.ts
// are NOT consolidated here — that's a separate cleanup. Operator-
// authorized scope exception, same kind as the /status fix: a one-
// spot correctness fix to a known defect.

export function stavrHome(): string {
  return process.env.STAVR_HOME?.trim() || join(homedir(), '.stavr');
}

export function defaultDbPath(): string {
  return join(stavrHome(), 'runestone.db');
}
