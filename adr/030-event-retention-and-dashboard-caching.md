# ADR-030 — Event-table retention + dashboard fetch memoization

- Status: Accepted
- Date: 2026-05-16
- Driver: Kenneth Stenlund
- Supersedes: —
- Related: ADR-006 (loopback-only daemon), ADR-028 (dashboard architecture)
- Replaces: nothing
- BOM: `proposed/bom-oom-leak-hunt.md`

## Context

On 2026-05-15 ~17:30 local the stavr daemon hit `FATAL ERROR: Reached
heap limit Allocation failed - JavaScript heap out of memory` after ~71
minutes of normal operation. V8 had been running repeated
`Mark-Compact (reduce)` GC cycles freeing ~0.6 MB each in the leadup —
the canonical "slow leak saturating old-space" signature.

Pre-OOM recon (2026-05-15 evening, captured in the BOM spec) ranked
three suspects:

1. **HIGH** — unbounded `events` SQLite table + the dashboard hot paths
   that re-parse it on every render. `EventStore.appendEvent` had no
   retention; the Streams page renderer called `getEvents({ limit: 500 })`
   on every render; `/dashboard/home/data` was polled every 5s with no
   memoization. Math: 71 min × ~10 ev/s × ~300 B JSON × parse+render
   amplification ≈ saturation.
2. **MEDIUM** — SSE session map cleanup race on rapid client reconnect.
3. **MEDIUM** — same shape as (1), called out separately because it
   touches the dashboard and not the broker directly.

Checkpoint 1 of `bom-oom-leak-hunt` instrumented the daemon
(`daemon_memory` events, `POST /debug/heap-snapshot`, `sse_session_*`
events, pre-OOM auto-snapshot via Node V8 flags) and reproduced the leak
shape locally. This ADR captures the Checkpoint 2 fix decisions.

## Decision

Apply **two fixes that target the dominant retainers directly**, plus
two defensive fixes for the SSE session map.

### 1. Kind-aware retention on the `events` table

The audit-vs-operational split lives in `src/observability/retention.ts`:

- **OPERATIONAL** kinds (`daemon_memory`, `worker_progress`,
  `worker_log`, `sse_session_*`, `mcp_session_deleted`,
  `retention_swept`): aggressive prune. **7 days OR 100,000 rows**,
  whichever fires first. No audit value; deleted rows are gone.
- **AUDIT** kinds (trust-scope lifecycle, decisions, BOM lifecycle,
  steward lifecycle, credential lifecycle, no-go matches, PR/commit
  events, session boundaries): **90 days, no row cap by default.** These
  are the "policy evaluation outcomes, identity context, delegation
  lineage, decision timestamps" that the 2026 agentic-observability
  guidance calls out as audit-bearing.
- **UNKNOWN** kinds: **never deleted**, but logged with a warning so
  the operator extends `retention.ts` rather than silently dropping
  data. This is intentional: a forgotten kind is better preserved than
  vanished.

Driven by `EventStore.pruneEvents`, scheduled at boot + every 60 minutes
from `src/daemon.ts`. Each sweep emits a `retention_swept` event with
the per-class delete counts, before/after counts, and duration.

Env overrides:
- `STAVR_EVENTS_OP_RETENTION_DAYS` (default 7)
- `STAVR_EVENTS_OP_MAX_ROWS` (default 100,000)
- `STAVR_EVENTS_AUDIT_RETENTION_DAYS` (default 90; set to a very large
  number to effectively never expire)

Migration: additive `created_at` column on the `events` table,
backfilled from `persisted_at` on first run. Indexed for both age and
`(kind, created_at)` so the per-kind age-based deletes don't full-scan.

### 2. Server-side memoization on hot dashboard data builders

`src/dashboard/memo.ts` exposes `memoize<T>(fn, ttlMs)` — single-slot,
time-based cache. Wrapped at `src/transports.ts` `mountDashboardRoutes`:

- `homeData()` — TTL 2 s (env: `STAVR_DASHBOARD_CACHE_MS`, default 2000)
- `streamsData()` — TTL `dashboardCacheMs/2` (default 1 s) — pulls
  `getEvents({ limit: STAVR_STREAMS_MAX_EVENTS })` so the cache
  amortises the hottest single allocation in the recon

Acceptable staleness: dashboards lag real state by up to TTL. This is
an oversight surface, not a transactional UI; 1-2 s is fine.

### 3. Streams page event-fetch cap

Cap dropped from 500 to **100** (`STAVR_STREAMS_MAX_EVENTS`). The page
already shows the most recent 8 events per worker — pulling 500 to
filter to 8 was profligate. 100 is enough headroom for an active
worker's last-minute history without ballooning per-render allocations.

### 4. Synchronous SSE / Streamable HTTP teardown

- **Explicit `app.delete('/mcp', …)` handler** (suspect #2 fix).
  Synchronously: `transport.close` → `broker.removeSession` →
  `sseSessions.delete` → `mcp_session_deleted` event. Closes the
  reconnect race that the SDK's async `transport.onclose` left open.
- **Defensive 30 s timeout** on `transport.onclose`. If the session is
  still in `sseSessions` 30 s after onclose fired, force-remove and
  emit `sse_session_force_removed`.
- **5-min janitor** scans the session map for sockets the runtime
  reports as destroyed and reaps them, emitting the same
  `sse_session_force_removed` event so dashboards see the count.

## Consequences

### Positive

- Daemon RSS plateau instead of climb. The 24h soak (`STAVR_RUN_SOAK=1
  npx vitest run tests/soak`) asserts < 600 MB; the weekly GH Actions
  workflow at `.github/workflows/soak.yml` runs long-mode (100k events
  + 1000 fetches).
- Dashboard fetches no longer dominate per-render allocation. Streams
  page render cost is bounded, not proportional to event-log size.
- DELETE `/mcp` now follows the Streamable HTTP spec semantics
  (synchronous teardown, explicit termination event) — which makes
  client behaviour easier to reason about.
- Future leak regressions surface as a soak test failure, not a
  3 a.m. OOM.

### Negative / accepted trade-offs

- Dashboards are now 0-2 s stale. Live SSE streams (`/dashboard/stream`)
  still push real-time, so this only affects the polled JSON paths.
- Operational events older than 7 days are gone — no archival yet.
  Future ADR-031 (or similar) can add cold-storage forwarding when we
  need it. For now, the audit-class retention covers the things that
  matter for compliance.
- Unknown kinds preserved indefinitely. This is conservative by design
  but means the operator must extend `retention.ts` after introducing a
  new kind. The warning log is the nudge.
- One additional table-info pragma at boot. Single-digit ms.

### Out of scope (deliberate, not deferred)

- Replacing `better-sqlite3`. The leak isn't a SQLite issue.
- Restructuring the events schema beyond the additive `created_at` +
  indexes. Bigger schema work belongs in its own ADR.
- Increasing `--max-old-space-size` past 8192 as the fix. C1 already
  bumped it to 8192 as **headroom for forensic dumps**, not as a
  bandage. The retention + memoization changes here are the fix.
- Dashboard SPA / client-side caching. Server-side memoization is
  enough; client-side caching adds complexity for marginal gain on a
  loopback-only oversight surface.

## Verification

- `npm run check` — all unit + integration tests.
- `STAVR_RUN_SOAK=1 npx vitest run tests/soak` — short-mode soak,
  ~5 min, asserts RSS ceiling.
- `.github/workflows/soak.yml` — weekly long-mode soak on Linux.
- `stavr tail --kind retention_swept` — see retention working live.
- `docs/leak-hunt-procedure.md` updated with the new env vars + the
  expected `retention_swept` cadence.
