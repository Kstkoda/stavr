import ccSpawner from './cc.js';
import shellSpawner from './shell.js';
import unitySpawner from './unity.js';
import { loadMcpWorkerSpawners, type LoadOptions } from './mcp-workers-config.js';
import type { WorkerSpawner } from './types.js';

/**
 * Static registry of built-in spawners. Adding a new IN-PROCESS worker type:
 *   1. Drop a file at `src/workers/<type>.ts` exporting a default WorkerSpawner.
 *   2. Add one line to this list.
 *
 * Per ADR-014 we deliberately do NOT auto-discover by filesystem scan —
 * keeping registration explicit makes the build deterministic across
 * packaging modes (tsx, dist, future bundlers).
 *
 * MCP-backed worker types (ADR-042 Decision 5) are loaded separately from
 * `~/.stavr/worker-mcp-servers.yaml` via `loadMcpWorkerSpawners()` and
 * merged at daemon boot — they live alongside the static list rather than
 * in it, so the in-process spawners stay stable when the operator edits
 * their manifest.
 */
export const builtInSpawners: WorkerSpawner[] = [ccSpawner, shellSpawner, unitySpawner];

/**
 * Backward-compat alias. Existing call sites import `allSpawners` and pass
 * it straight to `WorkerOrchestrator.register()`. Keeping this name working
 * means the orchestrator's wiring in `daemon.ts` doesn't need a refactor —
 * it just needs an additional `loadMcpWorkerSpawners()` call to layer the
 * MCP-backed types on top.
 */
export const allSpawners: WorkerSpawner[] = builtInSpawners;

/**
 * Resolve the full spawner set — built-in plus any MCP-backed types loaded
 * from the worker manifest. Call this at daemon boot, register every entry,
 * and you've covered both worlds. Throws if the manifest is malformed
 * (manifests are operator-configured, so a parse error is operator-visible).
 */
export function resolveAllSpawners(opts: LoadOptions = {}): WorkerSpawner[] {
  const mcp = loadMcpWorkerSpawners(opts);
  return [...builtInSpawners, ...mcp.spawners];
}
