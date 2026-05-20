# Audit 08 — Performance Review

> Post memory-leak-fix (commit fbcc2e4, 2026-05-19), what's still a risk: sync hot paths, unbounded buffers, N+1 queries, event-loop blockers, leak shapes.

## Headline

| Risk | Severity | Status |
|---|---|---|
| Stateless `/mcp` POST leaked McpServer instances | HIGH (pre-fix) | ✅ FIXED in fbcc2e4 — rejected early; `mcp_oneshot_cleanup` aggregator emits every 60s as safety net |
| Notification dispatch can retain promises if channels hang | MEDIUM | ⚠️ no per-channel timeout (`src/notify/notifier.ts:168-174`) — test run actually emitted `notifier: background dispatch threw {"error":"The database connection is not open"}` confirming the race |
| Peer registry listeners with no explicit dispose | LOW–MEDIUM | depends on dashboard page lifecycle |
| Two heap snapshots in repo root (`Heap.20260519.*`) | (post-fix verification still needed) | 37 MB and 0 B (truncated) — pre-fix evidence |
| Test suite writes 37–43 MB heap snapshots into `tmp/` during normal `npm test` runs | LOW (dev-experience) | `--heapsnapshot-near-heap-limit` and debug-endpoint test setup are firing on the test rig |
| `pruneEvents: uncategorized event kinds preserved` warned once during test | LOW (data growth) | per ADR-030 "never delete UNKNOWN" but unbounded over time |
| Federation `mDNS error {"error":"ServiceConfig requires \`port\` property to be set"}` ~40× per test run | LOW (test flakiness / prod config) | either tests leak mDNS or prod path also fires the warn-and-continue |
| Node `DEP0190` deprecation: shell-true child_process args | LOW (track) | one occurrence in test transcript; locate before Node 22 promotes it to an error |

## 1. Synchronous work on hot paths — LOW

No blocking I/O found in request handlers:
- `src/server.ts` registration: async only.
- `src/broker.ts` publish: async pipeline, no sync I/O.
- `src/transports.ts` request handling: async; janitor + memo cache are non-blocking.

Sync I/O is confined to boot / lifecycle:
- `src/persistence.ts:100-142` — `mkdirSync`, `renameSync` on init.
- `src/credentials/vault.ts:102-148` — master-key load (one-time).
- `src/observability/metrics.ts:38` — `readFileSync(package.json)` at startup.
- `src/dashboard/data/topology-data.ts:139` — `readFileSync(peers.yaml)` inside a memoized data fetcher.

`while (true)` loops in `src/steward/executor.ts:230`, `src/watchdog.ts:234`, `src/tail.ts:162` all `await` inside the loop, so they yield.

Crypto in hot paths uses non-blocking variants only (`randomBytes`, `createCipheriv` stream). No `pbkdf2Sync` / `scryptSync` outside test code.

## 2. Unbounded buffers, arrays, maps — MEDIUM (managed)

| Structure | File | Growth shape | Cleanup |
|---|---|---|---|
| `sseSessions = new Map<string, McpSession>()` | `src/transports.ts:143` | per-client session, grows on connect | janitor at line 910–947, every 5 min, walks the map and removes destroyed sockets; explicit `broker.removeSession()` on close (line 581) + on stateless cleanup (lines 747–767 — post-leak-fix path) |
| `broker.subscribers = new Map<string, Subscription>()` | `src/broker.ts:21` | one per session | removed via `removeSession()` in `transports.ts:581, 697, 923` |
| `broker.taps / rawListeners = Set<>` | `src/broker.ts:22-23` | per-tap | each `onEvent()` returns a dispose function; dashboard SSE handler calls it on socket close (line 799) |
| `bomState / workerTypeById = new Map<>` | `src/observability/metrics.ts:164-165` | per active BOM / worker | `endBomState()` + `workerTerminated()` clear entries on completion |
| `rateLimit.buckets = new Map<>` | `src/notify/rate-limit.ts:23` | per unique IP in 60s window | `maybeSweep()` deletes expired buckets |
| `peerRegistry.records = new Map<>` | `src/federation/peer-registry.ts:25` | per known/discovered peer | `markLost()` evicts discovered-only; configured peers stay |
| `orchestrator.live = new Map<>` | `src/workers/orchestrator.ts:62` | per live worker | listener closures collected in `offs[]`, `live.detach()` on exit (lines 251–253); `this.live.delete(id)` |

**Risk profile:** every map has a cleanup mechanism. The remaining failure mode is "the cleanup mechanism doesn't fire" — primarily janitor reliance on `_writable?.destroyed` (SDK internal) and worker `exit` event firing.

## 3. N+1 query patterns — LOW

- `src/trust/store.ts findActiveScopeFor()` lines 177–195: walks active scopes; per-row UPDATE for expiry/completion. **Bounded by active-scope count (typically 1–3)**. Acceptable.
- `src/credentials/store.ts list()` line 99: single SELECT, maps client-side. Clean.
- `src/notify/notifier.ts:236-250` records dispatches with one UPDATE per channel. Bounded by configured channel count (typically 1–5). Acceptable.

No `.forEach(... db.prepare ...)` or `for (... db.get ...)` patterns found in the data-fetcher layer.

## 4. Event loop blockers — LOW

- No `while (true)` with sync work.
- No `JSON.stringify` of unknown-size payloads on hot paths (broker payloads are pre-shaped).
- No recursive functions without depth limit.
- `normalizeSourceAgent()` in `src/observability/metrics.ts:145` uses simple prefix matching, not regex.

## 5. DB lifecycle — GOOD

- Singleton `Database` instance per `EventStore` (`src/persistence.ts:95`).
- better-sqlite3 caches prepared statements implicitly.
- WAL mode (`journal_mode=WAL`); `foreign_keys=ON`.
- Integrity check at open guards against corruption.
- No statement leaks — all `.prepare()` calls are immediate `.run() / .all() / .get()`.

## 6. Retention / cleanup workers — ACTIVE

`src/daemon.ts:363-394` schedules retention:
- Once at boot.
- Every 60 min.
- Interval handle is `unref`'d so it doesn't block shutdown.
- Emits `retention_swept` with deletion counts.

`src/persistence.ts:766-842 pruneEvents()`:
- OPERATIONAL: age cap (7d) + row cap (100k).
- AUDIT: age cap (90d), no row cap.
- UNKNOWN: counted + logged, never deleted (**this is the growth shape worth tracking — one warning observed in the test run**).

`src/daemon.ts:396-398` calls worker hard-delete (`STAVR_WORKER_HARD_DELETE_DAYS` default 30) alongside event retention.

## 7. Memory-leak shapes still present — MEDIUM (specific)

### Resolved (fbcc2e4)
- McpServer per stateless `/mcp` POST: now rejected early with JSON-RPC error; `mcp_oneshot_cleanup` event for visibility.

### EventEmitter patterns — clean
- Decision response: `responses.once(correlationId, onResponse)` + `responses.off()` on timeout (`src/persistence.ts:968-971`).
- Worker instance events: collected closures cleaned via `offs[]` + `live.detach()` (`src/workers/orchestrator.ts:178-253`).
- Peer registry extends EventEmitter; **no explicit listener cleanup observed** if dashboard widgets subscribe — recommend returning a dispose function on subscription.

### `setInterval` patterns — clean
- memory-poller, event-loop monitor, retention scheduler, session janitor — all `unref`'d, all return a dispose / stop function.

### Fire-and-forget promises — risk
- `src/notify/notifier.ts:168-174` enqueues dispatch via `setImmediate`. Promise (with closures of `eligible` + `channelInput`) lives until all channels resolve. **No per-channel timeout.** Confirmed shape: test run emitted `WARN: notifier: background dispatch threw {"error":"The database connection is not open"}`.

## 8. Heap snapshot evidence

Two snapshots in repo root:
- `Heap.20260519.032659.112220.0.002.heapsnapshot` (~37 MB)
- `Heap.20260519.090757.112124.0.002.heapsnapshot` (0 B — truncated mid-write)

`package.json start` script flags:
```
node --max-old-space-size=8192 --heapsnapshot-near-heap-limit=2 --report-on-fatalerror --report-directory=./tmp/diag-reports dist/cli.js daemon start
```

- Max heap 8 GB.
- Triggers up to 2 snapshots near the limit.
- The 03:26 snapshot fired before the post-leak fix was merged; the second (09:07) appears truncated. **Post-fix verification (48h soak) is the open work item.**

Test run noise: the suite produces `heap snapshot written {"size_bytes":37056103}` and `cpu profile written` events during normal `npm test`. The `src/observability/debug-endpoints.ts` paths are being exercised, and they really write multi-megabyte files into `tmp/heap-snapshots/` and `tmp/cpu-profiles/`. Worth gating behind `STAVR_TEST_ALLOW_SNAPSHOTS=1` to keep dev workspaces lean.

## 9. Other observed warnings (from the test transcript)

| Warning | Implication |
|---|---|
| `federation: mDNS error {"error":"ServiceConfig requires \`port\` property to be set"}` ~40× | mDNS coordinator is being constructed with an incomplete config; warn-and-continue masks it; same shape likely in prod |
| `notifier: background dispatch threw {"error":"The database connection is not open"}` | dispatch raced teardown — see §7 promise concern |
| `pruneEvents: uncategorized event kinds preserved (extend observability/retention.ts) {"unknown_count":1}` | uncategorised kinds are silently retained; growth shape over years |
| `DEP0190` Node deprecation: shell-true args to child_process | one occurrence; locate the call site (likely `src/workers/shell.ts` or `src/security/host-exec-runner.ts`) and fix before Node 22 makes it an error |

## Recommendations

| # | Action | Size |
|---|---|---|
| 1 | Run 48h soak with the post-leak-fix branch; monitor `process_resident_memory_bytes` slope (expected flat vs pre-fix 36 MB/min) | medium (operational) |
| 2 | Add per-channel timeout (`Promise.race`) to `src/notify/notifier.ts dispatchAll()` | trivial |
| 3 | Have `src/federation/peer-registry.ts` return dispose handles on `.on()` so dashboard widgets can unsubscribe cleanly | small |
| 4 | Reduce session-janitor interval to 60s (cheap; faster stale-socket cleanup) | trivial |
| 5 | Fix the mDNS port misconfig that produces ~40 warnings per test suite | trivial |
| 6 | Track the `pruneEvents` UNKNOWN-kind warning's count as a Prometheus counter so growth is visible | trivial |
| 7 | Locate the DEP0190 caller and pass args as an array (or drop `shell: true`) | small |
| 8 | Gate test-time heap-snapshot writes behind `STAVR_TEST_ALLOW_SNAPSHOTS` | trivial |
| 9 | Add a regression unit test that fires 1000 stateless `/mcp` POSTs and asserts subscriber count returns to baseline | small |
