# ADR 013 — Single `workers` table with type discriminator + metadata JSON

**Status**: Accepted
**Date**: 2026-05-12

## Context

Spec 40 Phase 2's first draft proposed a `cc_sessions` table with CC-specific columns (`branch`, `base`, `worktree_path`, `model`, …). When spec 42 generalized the design to support arbitrary spawnable worker types (cc, shell, unity, roblox, python, …), the question became how to model them: one table per type, one big table with NULL-ed columns per type, or one table with a type discriminator and a JSON blob for type-specific fields.

Each pattern trades schema strictness for evolution cost:

- **Per-type tables** (`cc_workers`, `shell_workers`, `unity_workers`, …) keep each schema tight but force every new worker type to ship a migration and means worker-agnostic code (the orchestrator, the dashboard) has to JOIN N tables to list "all workers."
- **One wide table** (`workers` with `branch`, `script_path`, `unity_project`, …) is type-strict at the column level but every column is NULL for most rows. Every new worker type adds columns.
- **One table with type discriminator + JSON** (`workers(type, metadata_json)`) is the model SQLite + better-sqlite3 + an event-sourced design steers toward naturally — the `events` table already uses `payload_json` for the same reason.

## Decision

One `workers` table with type-stable columns (`id`, `name`, `type`, `cwd`, `pid`, `status`, `started_at`, `ended_at`, `last_activity_at`, `spawn_params_hash`, `termination_reason`, `exit_code`) plus a free-form `metadata_json` column for type-specific fields (`branch`, `worktree_path`, `script`, `unity_project`, …). Indices on `status`, `type`, and a partial index `name WHERE status NOT IN ('terminated','crashed')` for the unique-name guard.

Type-specific data is the spawner's responsibility — `WorkerInstance.metadata` is a `Record<string, unknown>` the spawner fills, and `EventStore.updateWorkerMetadata(id, patch)` merges patches in over time. Tooling that needs to query into the JSON uses SQLite's `json_extract`; the dashboard's worker panel uses `metadata` generically and only branches into type-specific rendering when the user opens a row.

## Consequences

- **One DDL block, forever.** New worker types add zero columns. The schema for `workers` is set in this dispatch and shouldn't need to evolve.
- **Worker-agnostic queries work.** `SELECT * FROM workers WHERE status = 'running'` returns every live worker regardless of type. The dashboard's main panel can render a generic table.
- **Slight loss of column-level typing.** TypeScript carries the type via `WorkerSpawner<TParams>` and the spawner's Zod `paramsSchema`; SQLite sees `metadata_json` as opaque text. Acceptable — the event log already takes this trade for the same reasons.
- **Type-aware indexing requires expression indices.** If, later, we want a fast "all CC workers on branch X" query, we'd build `CREATE INDEX … ON workers(json_extract(metadata_json, '$.branch')) WHERE type = 'cc'`. We do not need this today.

## Alternatives considered

- **Per-type tables.** Forces every new worker type into a migration. JOINs to list everything. Hardest to keep the dashboard type-agnostic. Strongest typing but the typing isn't actually load-bearing — type validation already happens at the spawner's Zod schema before the row is written.
- **One wide table.** Every new worker type adds NULL columns. The "metadata" surface ends up scattered across the row anyway. Worst of both worlds.
- **Separate `worker_metadata` key-value table** (one row per (worker_id, key, value)). Tempting for queryability but doubles write count per worker, and the orchestrator's "merge a patch" semantics translate awkwardly into upserting N rows.

## See also

- `events.payload_json` uses the same pattern — type discriminator (`kind`) plus JSON blob (`payload_json`). Consistency across the persistence layer is its own benefit.
