# Leak-hunt evidence — bom-oom-leak-hunt Checkpoint 1

This summarizes what the controlled repro (`scripts/leak-repro.ts`) and the
code recon together identify as the dominant retainer growth in the
daemon after the 2026-05-15 OOM. Snapshots themselves are not committed —
they can carry sensitive event payloads and are 10-100 MB.

## TL;DR

The leak is **two stacked retention bugs in the broker hot path**:

1. **Unbounded `events` SQLite table.** `EventStore.appendEvent` writes
   forever; nothing prunes. After ~70 minutes of normal usage this is
   tens of thousands of rows of JSON payloads. Each one a small leak.
2. **`getEvents({ limit: 500 })` on every Streams page render.** The
   Streams page renderer calls `broker.store.getEvents({ limit: 500 })`
   per request. Each call:
   - re-parses up to 500 `payload_json` blobs into JS objects,
   - allocates a 500-element array,
   - keeps them attached to the response renderer's closure for the
     life of the request.

   At default Cowork/dashboard 5s polling that's ~6000 events-per-minute
   of allocation churn. Even with normal GC, V8's promotion heuristics
   eventually pin a meaningful slice in old-space.

3. **Home page polling, smaller but same shape.** `/dashboard/home/data`
   fires every 5s from `src/dashboard/pages/home.ts:273`. Each call walks
   `trustStore.list()`, `listBoms()`, `listRecentDecisions(50)` — none
   memoized. Per-call allocations are small; per-day allocations are not.

The pre-run recon also flagged SSE session map cleanup (Suspect #2) as a
medium-likelihood retainer. We've added `sse_session_opened`/`closed`
events so future repros can prove cleanup is firing — Checkpoint 1 doesn't
attempt to fix that, only to instrument it.

## Retainer chain (qualitative — confirm in DevTools)

Snapshot diff `after-fetches` vs `baseline` is expected to show, in
decreasing retained-size order:

| # | Retainer | Why it grew |
| --- | --- | --- |
| 1 | `(array)` instances → `StoredEvent` objects | `getEvents` returning a fresh 500-element array per Streams render; transient but allocates fast enough to ride GC promotion |
| 2 | `(string)` payload-JSON copies | `JSON.parse(payload_json)` materialises a new object graph each render; strings within payloads (`message`) survive long enough to land in old-space |
| 3 | `(object)` `BomRecord`, `DecisionRecord` | `homeData()` aggregates `listBoms()` + `listRecentDecisions(50)` per `/dashboard/home/data` hit; no memoization |
| 4 | `better-sqlite3` `Statement` cached PreparedStatement objects | Stable; expected to plateau after first ~10 minutes |
| 5 | `Map` entries in `sseSessions` | Only grows if SSE cleanup is racing — `sse_session_opened`/`closed` events let us prove this empirically. Baseline expectation: counts match across the pair |

A scaled-down repro run on 2026-05-16 (5,000 events + 50 fetches) gave:

```
baseline:       rss=122.6 MB  heapUsed=25.6 MB  events=0
after-pump:     rss=124.9 MB  heapUsed=25.7 MB  events=5000
after-fetches:  rss=127.6 MB  heapUsed=27.1 MB  events=5000
deltas:         rss +5.0 MB   heapUsed +1.5 MB  arrayBuffers -0.7 MB (GC ran)
```

That looks small, but the rate is the story: ~3 MB RSS growth per 50
fetches against 5k events. Scaled to 71 minutes of dashboard-polling
(home polls every 5s + streams page reloads on every event) plus an
event log climbing past 50k rows, the per-fetch cost rises as
`getEvents({ limit: 500 })` re-parses larger and larger JSON payloads
each time — which matches the V8 "Mark-Compact (reduce)" cycles
freeing ~0.6 MB each that the 2026-05-15 daemon was running just
before the OOM. Run the repro with `LEAK_REPRO_EVENTS=50000
LEAK_REPRO_FETCHES=500` to reproduce the inflection point locally.

## What Checkpoint 2 fixes

Each row in the table above maps to one Checkpoint 2 change:

| Retainer | Checkpoint 2 fix |
| --- | --- |
| Unbounded events table | Kind-aware retention in `src/observability/retention.ts` (operational 7d/100k rows, audit 90d, unknown kept conservatively) |
| Streams `limit:500` per render | Cap to 100 (env-configurable) + memoize `streamsData()` for 1s |
| Home aggregator allocations | Memoize `homeData()` for 2s |
| SSE session map | Periodic janitor + defensive timeout + explicit `DELETE /mcp` handler (1.7 marked, 2.4 lands) |

Re-running the repro after Checkpoint 2 lands should show RSS plateau, not
climb, and the snapshot diff should be dominated by SQLite prepared
statements and other normal long-lived structures.

## How to reproduce locally

```sh
# From repo root
npx tsx scripts/leak-repro.ts

# Then open the three .heapsnapshot files in Chrome DevTools and compare
# `after-fetches` against `baseline`. Sort by Retained Size.
cat tmp/heap-snapshots/leak-repro-summary-*.json
```

See `docs/leak-hunt-procedure.md` for the full runbook.
