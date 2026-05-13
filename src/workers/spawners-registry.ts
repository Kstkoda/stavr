import ccSpawner from './cc.js';
import shellSpawner from './shell.js';
import unitySpawner from './unity.js';
import type { WorkerSpawner } from './types.js';

/**
 * Static registry of built-in spawners. Adding a new worker type:
 *   1. Drop a file at `src/workers/<type>.ts` exporting a default WorkerSpawner.
 *   2. Add one line to this list.
 *
 * Per ADR-014 we deliberately do NOT auto-discover by filesystem scan â€”
 * keeping registration explicit makes the build deterministic across
 * packaging modes (tsx, dist, future bundlers).
 */
export const allSpawners: WorkerSpawner[] = [ccSpawner, shellSpawner, unitySpawner];
