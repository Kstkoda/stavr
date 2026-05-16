# Leak-hunt procedure

Operational runbook for the OOM diagnostics added in `bom-oom-leak-hunt`. Use
this when the daemon RSS climbs over ~1 GB, when an OOM crash hits, or as a
periodic 24h sanity check before merging anything that touches the broker /
persistence / dashboard hot paths.

## What's wired (Checkpoint 1)

| Surface | Where | How to read |
| --- | --- | --- |
| `daemon_memory` events every 60s | `src/observability/memory-poller.ts` | `stavr tail --kind daemon_memory` |
| SSE session open/close events | `src/transports.ts` `app.all('/mcp')` | `stavr tail --kind sse_session_opened --kind sse_session_closed` |
| POST `/debug/heap-snapshot` (loopback) | `src/transports.ts` | `curl -X POST http://127.0.0.1:7777/debug/heap-snapshot` |
| Crash-time heap dump | `npm start` flags `--heapsnapshot-near-heap-limit=2`, `--report-on-fatalerror`, `--report-directory=./tmp/diag-reports` | Files land in `./tmp/heap-snapshots` and `./tmp/diag-reports` |
| Controlled repro | `scripts/leak-repro.ts` | `npx tsx scripts/leak-repro.ts` |

## Triggering a snapshot against a running daemon

```sh
curl -X POST http://127.0.0.1:7777/debug/heap-snapshot
# {"ok":true,"file":"C:\\dev\\cowire\\tmp\\heap-snapshots\\snapshot-1715896234123.heapsnapshot","size_bytes":12345678}
```

The endpoint is **loopback only** — `isLoopbackRequest` is re-checked even
though the daemon binds 127.0.0.1 by default. If you've widened the bind via
`network.bind`, snapshotting still has to be initiated locally.

Open the resulting `.heapsnapshot` file in Chrome DevTools → Memory →
*Load*. Sort by *Retained Size*. The leak-hunt evidence doc
(`docs/leak-hunt-evidence.md`) names the retainer chains we expect to grow.

## Watching memory over time

```sh
stavr tail --kind daemon_memory --json | jq -c '{ts: .at, rss: (.payload.rss/1024/1024 | floor), heap: (.payload.heapUsed/1024/1024 | floor), events: .payload.eventCount, sse: .payload.sseSessions}'
```

A healthy daemon: RSS plateau within ~30 minutes of boot, eventCount climbing
linearly with usage (will plateau once Checkpoint 2 retention lands), SSE
session count returns to 0 between client lifecycles.

A leaking daemon: RSS climbing monotonically, eventCount unbounded, SSE
sessions only ever increasing.

## Running the controlled repro

```sh
npx tsx scripts/leak-repro.ts
# Tunables
LEAK_REPRO_EVENTS=20000 LEAK_REPRO_FETCHES=100 npx tsx scripts/leak-repro.ts
```

The script:

1. Boots an in-process daemon on a random loopback port using a tempdir
   `STAVR_HOME`, so it won't collide with your running production daemon.
2. Captures heap snapshot #1 (baseline).
3. Pumps `LEAK_REPRO_EVENTS` synthetic `progress` events via `broker.publish`.
4. Captures heap snapshot #2 (after-pump).
5. Makes `LEAK_REPRO_FETCHES` alternating GETs to `/dashboard/home/data`
   and `/dashboard/streams` (which calls `streamsData()` and pulls the
   most-recent 500 events on every render).
6. Captures heap snapshot #3 (after-fetches).
7. Writes `tmp/heap-snapshots/leak-repro-summary-<ts>.json` with RSS/heap
   deltas + paths to the three `.heapsnapshot` files.

Snapshots are `.gitignore`d — they can be 10-100 MB and may carry payload
strings. Don't commit them.

## What to do with a snapshot

1. Chrome DevTools → Memory → *Load snapshot*.
2. Click the *Comparison* dropdown, pick the baseline snapshot to diff
   against.
3. Sort by *Size Delta* — the row at the top of the diff is your dominant
   retainer growth.
4. Note the retaining chain (right pane in DevTools). Add it to
   `docs/leak-hunt-evidence.md` if it's a chain we haven't documented yet.

## Crash-time diagnostics

`npm start` runs with `--heapsnapshot-near-heap-limit=2` so the V8 OOM
killer dumps two snapshots before the process dies (one early when heap
hits ~50% of the limit, one final at ~90%). `--report-on-fatalerror`
additionally produces a node-style diagnostic report in
`./tmp/diag-reports/` covering libuv handles, native stacks, env, and the
last few GC cycles.

After an OOM:
- The `.heapsnapshot` files are in the CWD the daemon was started from (or
  `tmp/heap-snapshots/` if launched via `npm start` — Node writes near-heap-
  limit snapshots to `cwd`, so the recommendation is to always launch
  the daemon from the repo root).
- The `report.*.json` files are in `./tmp/diag-reports/`.
- Open the most-recent `.heapsnapshot` in Chrome DevTools and follow the
  procedure above.

Cross-platform notes:
- `--heapsnapshot-near-heap-limit` and `--report-on-fatalerror` work on
  Windows, macOS, and Linux.
- Signal-based snapshot triggers (`SIGUSR2`) do **not** work on Windows.
  Use the HTTP endpoint instead — same effect, cross-platform.
