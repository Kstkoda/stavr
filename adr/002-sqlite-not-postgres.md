# ADR 002 — SQLite for persistence

**Status**: Accepted
**Date**: 2026-05-12

## Context

Switch needs durable storage for two things: the append-only event log and the decision table (with its `awaitDecisionResponse` rendezvous). Switch is a *local* broker — one daemon per host, accessed only by processes on `127.0.0.1`. It is not a backend service serving multiple machines, and the data does not need to outlive the host.

## Decision

Use SQLite via `better-sqlite3`, single file at `~/.cowire/cowire.db` (configurable with `--db`). WAL mode for concurrent readers. Schema is created idempotently with `CREATE TABLE IF NOT EXISTS` in `EventStore.init`.

## Consequences

- Zero operational surface: no "is the database up?" pre-flight, no users to provision, no port to expose.
- Trivial to inspect: `sqlite3 ~/.cowire/cowire.db` and you have the whole world. Backups are `cp`.
- Tests use `:memory:` and get full schema fidelity with no global state to clean up.
- Single writer per process — fine because Switch is single-process. If we ever want multi-process Switch we have to rethink this.
- No schema migrations system yet — schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). The day we need a destructive change, we add a migrations table; not before.

## Alternatives considered

- **Postgres.** Real database, mature tooling, but adds a service the user has to run and credentials we have to store. For a single-host broker this is operational tax with no benefit.
- **Plain JSON files on disk.** No transactions, no indexes, no `awaitDecisionResponse` rendezvous primitive. Would force us to reinvent half of SQLite.
- **In-memory only with periodic dumps.** Tempting for the broker, but `await_decision` may block up to 30 minutes — losing the decision table on every restart is unacceptable.
