# ADR 014 — Spawners registered via static list, not filesystem auto-discovery

**Status**: Accepted
**Date**: 2026-05-12

## Context

Spec 42 said "adding a new worker type is a single file in `src/workers/`." The most aesthetically pleasing reading is filesystem auto-discovery — scan `src/workers/*.ts`, dynamically `import()` each one, treat the default export as a spawner. The static-list reading is `src/workers/spawners-registry.ts` with one `import` and one entry in `allSpawners`. Both honor the "one file plus one line" budget; one is implicit, the other explicit.

The trade-offs are packaging-bound. Dynamic discovery works fine under `tsx` (everything is on disk) but fights with bundlers and ESM static analysis: when Stavr eventually ships as a single bundled file, "scan a directory at runtime" stops working. We've already had to thread `dist/cli.js` location resolution through `import.meta.url` in [`daemon.ts`](../src/daemon.ts) — the cost of "look at your own filesystem" in distributable JS is real and recurring.

## Decision

`src/workers/spawners-registry.ts` is a static list:

```ts
import ccSpawner from './cc.js';
import shellSpawner from './shell.js';
import type { WorkerSpawner } from './types.js';

export const allSpawners: WorkerSpawner[] = [ccSpawner, shellSpawner];
```

Adding a new spawner is two edits: drop the file at `src/workers/<type>.ts`, add one `import` + one entry. Both are mechanical. The contributing guide and the worker-authoring guide call this out explicitly.

## Consequences

- **Deterministic builds.** TypeScript's static analysis sees every spawner. Tree-shakers can prove what's actually used. Bundlers (when we get there) need no special handling for the workers directory.
- **One line of friction per spawner.** Trivial. The `Adding a new worker type` checklist is exactly two steps.
- **No surprise registration.** Dropping a half-finished `experimental.ts` into the directory doesn't accidentally register it. Spawners are opt-in by entry, not by file presence.
- **Test isolation.** Tests that want to register a mock spawner can do so without affecting `allSpawners`. The orchestrator's `register()` is the registration boundary; the static list is just one caller.

## Alternatives considered

- **Filesystem auto-discovery.** Scan `src/workers/`, dynamic-import each `.ts`. Aesthetic; breaks under bundlers and forces `import.meta.url` plumbing.
- **Decorator-based registration.** Each spawner file imports a registry and calls `registry.register(this)` at top level. Side-effecting imports are hard to reason about — order matters, partial imports break the system, and tree-shakers struggle.
- **Plugin manifest in `package.json`.** Over-engineering for a single-binary CLI. Useful if Stavr ever ships a plugin SDK for third-party spawners; not now.

## When to revisit

If Stavr ever exposes "drop this folder in `~/.stavr/spawners` to add a new worker type" — i.e., third-party plugins outside the source tree — auto-discovery comes back. It would be a `loadDynamicSpawners(dir)` helper that supplements the static list, not a replacement.
