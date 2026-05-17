// v0.5 P3 — Steward-agent subprocess health fetcher for /diagnostics.
//
// Additive ONLY per the dashboard visual-freeze rule. Wired in P6 as a new
// panel after "Workers + scopes" on the diagnostics page. Reads:
//   - process id + lifecycle status from the spawner handle (in-memory)
//   - autonomy mode + lessons count + working-memory key count from the
//     three Steward-agent state stores (P1)

import type { SpawnedStewardHandle, StewardAgentStatus } from '../../steward/spawner.js';
import type { StewardDbBundle } from '../../steward-agent/db/types.js';
import { PREF_KEYS } from '../../steward-agent/db/types.js';

export interface StewardHealthSnapshot {
  pid: number | null;
  status: StewardAgentStatus | 'unwired';
  last_heartbeat_at: string | null;
  autonomy_mode: string;
  lessons_count: number;
  memory_working_keys: number;
}

/**
 * Snapshot the live state of the Steward-agent subprocess + its stores. Safe
 * to call from any dashboard data path; returns a deterministic shape so the
 * diagnostics panel renders consistently.
 *
 * When `spawned` is undefined (in-process Steward still active, no subprocess
 * spawned yet) the status is 'unwired'.
 */
export function snapshotStewardHealth(args: {
  spawned?: SpawnedStewardHandle;
  bundle?: StewardDbBundle;
}): StewardHealthSnapshot {
  const { spawned, bundle } = args;
  return {
    pid: spawned?.pid ?? null,
    status: spawned ? spawned.status() : 'unwired',
    last_heartbeat_at: spawned ? spawned.lastHeartbeatAt() : null,
    autonomy_mode: bundle ? bundle.prefs.getOrDefault<string>(PREF_KEYS.AUTONOMY_MODE) : 'reactive',
    lessons_count: bundle ? bundle.lessons.count() : 0,
    memory_working_keys: bundle ? bundle.memory.listWorkingKeys().length : 0,
  };
}
