# BOM: fix/v0.6.x-memory-leak

**Owner:** CC (autonomous)
**Sensitivity:** careful (touches live daemon path, OOM-class bug)
**Branch:** `fix/v0.6.x-memory-leak`
**Base:** `main`
**Estimated scope:** 1 investigation phase + 1-3 fix phases + 1 verification phase

---

## Context — operator-led diagnostic complete (2026-05-19)

The stavR daemon has been crashing every ~64 minutes from V8 heap OOM since 2026-05-16. Operator (Kenneth) ran a 90-minute diagnostic session and captured the following ground truth — **DO NOT REDISCOVER**.

### Confirmed leak characteristics

- **Rate:** 36 MB/min heap growth, sustained, idle.
- **Cycle:** ~64 minutes from fresh daemon (RSS ~100 MB) to V8 OOM at ~2 GB heap. V8 dies well before the `--max-old-space-size=8192` cap because of GC death-spiral plateau.
- **Independent of SSE sessions.** Time-window 07:42→07:51 on 2026-05-16 had `sseSessions=0` the entire 10 min, yet heap still grew 31→473 MB (44 MB/min). Rules out SSE broadcast-buffer leak.
- **Plateau when idle.** Heap stabilized at ~500 MB for 5 consecutive minutes (07:53→07:58 on 2026-05-16) when no MCP traffic. Growth resumed when activity resumed. **The leak is per-MCP-request, not time-based.**
- **eventCount irrelevant.** Only grew ~1/min during the leak (those are the daemon_memory events themselves). Real growth doesn't land in the events DB.

### Ruled OUT via diagnostic (do not re-investigate)

- ❌ Events table growth — `C:\Users\stenl\.stavr\runestone.db` is 5.5 MB total. Retention scheduler is working.
- ❌ OTel collector — `src/observability/otel.ts` returns null when `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` is unset. NodeSDK never starts.
- ❌ memory-poller — `src/observability/memory-poller.ts` is clean (setInterval, publish, unref, no accumulation).
- ❌ SSE socket descriptor leak — libuv handles normal (17 total, 4 TCP) at 18 GB RSS moment.
- ❌ SSE broadcast buffer — heap grows with `sseSessions=0`.
- ❌ The 5/16 `src/security/script-signing.ts` SyntaxError — was a transient broken-dist state, already fixed.
- ❌ "725 PM2 restart counter" — mostly phantom; PM2 thrashes on port-conflict no-op spawns every 30s, NOT 725 real crashes.

### Top suspects (investigate in this order)

1. **MCP SDK's `StreamableHTTPServerTransport`** — third-party `@modelcontextprotocol/sdk`. Per-request context map that never evicts is a known pattern in pre-1.0 MCP SDKs. Check the version in `package.json`; if a newer patch release exists, that's the first thing to try.
2. **`attachMcpAttributes` in `src/observability/spans.ts`** — builds attribute objects per MCP request. Even with OTel disabled (noop tracer), the wrapper code may hold references in a Map keyed by request ID.
3. **Notification queue from ntfy header bug** — operator observed `WARN: notifier: channel dispatch failed {"channel":"ntfy","error":"Invalid character in header content [\"Title\"]"}`. If failed dispatches enqueue without bound for retry, that's the leak. Fix the header encoding too.
4. **Per-request listener registration in `broker.publish()`** that doesn't unregister.
5. **Express middleware** in `src/transports.ts` caching per-request data.

### Companion bugs to fix in same PR (bundle for efficiency)

- **PM2 restart-loop spam** (every 30s, "daemon already running" errors filling `tmp/pm2-stavr.err.log`). Root cause: stavr CLI exits with non-zero when port is already bound, PM2 retries. Fix: CLI should exit 0 on port-conflict OR ecosystem.config.cjs `min_uptime` should be raised to make PM2 treat fast exits as failures and trip `max_restarts`. Pick whichever has cleaner UX.
- **ntfy notifier header encoding** (mentioned above). The Title field contains a char the HTTP layer rejects. Likely UTF-8 emoji or non-ASCII.
- **`max_memory_restart: '7000M'` didn't fire** when daemon hit 18 GB RSS earlier today. Test whether PM2's memory check is actually polling. If it's broken at this scale, add an external watchdog script as belt-and-suspenders.

---

## Diagnostic artifacts available

- `C:\dev\cowire\diag\leak-20260519-085550\` contains:
  - `Heap.20260519.032659.112220.0.002.heapsnapshot` (16 GB — too large for Chrome DevTools; use `memlab` from npm if needed)
  - 4 V8 diagnostic-report JSONs from prior crashes
  - `stavr-tail.log` and `steward-tail.log` snapshots
- `runestone.db` has `daemon_memory` events as a time-series (query via `stavr events --kind daemon_memory --limit N`).
- `tmp/pm2-stavr.err.log` has the full restart-loop spam if needed for the PM2 fix.

---

## Phases

### Phase 0 — Reconnaissance (read-only)

- Read `src/broker.ts` end-to-end. Look for: per-session Maps/Sets, request-correlation maps, listener arrays without removal hooks.
- Read `src/transports.ts` Express middleware setup + `StreamableHTTPServerTransport` integration. Look for: per-request request-ID maps, response-promise stores.
- Read `src/observability/spans.ts` — `attachMcpAttributes` implementation.
- Read `src/notify/` directory — find the ntfy dispatcher + retry queue.
- Check `package.json` MCP SDK version. Check the SDK's changelog for memory-leak fixes since.
- Output: 1-page findings doc to `proposed/v0_6_x-memory-leak-findings.md` listing the smoking-gun line(s) and the planned fix. **Commit and push** before writing any fix code.

### Phase 1 — Smoking-gun fix

- Implement the fix identified in Phase 0.
- Add a regression test that exercises the leaking code path and verifies heap doesn't grow over N iterations (use `process.memoryUsage().heapUsed` deltas with a tolerance).
- DCO-sign commit. Push.

### Phase 2 — ntfy header bug + PM2 restart loop

- Fix the ntfy header encoding (sanitize Title field).
- Fix the PM2 restart-loop (CLI exit code OR ecosystem.config.cjs change — pick the cleanest).
- Both as separate commits in the same branch, DCO-signed.

### Phase 3 — Diagnostics surface (so the next leak is easier)

- Add `/dashboard/diagnostics/memory` endpoint: live `process.memoryUsage()`, SQLite `pragma page_count`, broker session count, event-store row count, BOM in-flight count.
- Add lightweight self-watchdog in the daemon: if RSS exceeds a configurable threshold (env `STAVR_RSS_WATCHDOG_MB`, default 4000), log a warning + write a heap snapshot.
- DCO-sign. Push.

### Phase 4 — Verification (DO NOT skip)

- Start daemon fresh, attach Cowork or a synthetic MCP client.
- Drive it under load for **at least 90 minutes** (cycle is 64 min — need to clear that threshold + buffer).
- Pull `stavr events --kind daemon_memory --limit 200` and confirm:
  - Heap stays under 500 MB the entire window.
  - No `V8` OOM in `tmp/pm2-stavr.err.log`.
  - No new heap snapshots written to `C:\dev\cowire\Heap.*.heapsnapshot`.
- Open PR with the verification time-series included in the description.

---

## Constraints (read CLAUDE.md hard invariants)

- **Per-phase commits**, all `git commit -s` (DCO).
- **`git status --short` + `git symbolic-ref HEAD` before every git op** (rule #8 in CLAUDE.md).
- **Don't touch list** still applies — this BOM does NOT open `src/persistence.ts`, `src/types/`, `src/dashboard/data/*`, `src/dashboard/adapters/*`, `migrations/`, `db/schema*`. The dashboard diagnostics endpoint in Phase 3 mounts NEW data fetchers, doesn't reshape existing ones.
- **Tests are derivative** — if a test asserts on the leaking behavior or against a session-cleanup contract that conflicts with the fix, delete/update the assertion in the same commit. Document in the PR.
- **Verify file writes** with `stat -c %s` + `tail -5` (rule #2). Use heredoc for files >30 KB.
- **NO-GO handoff** if you hit an action you can't take — name it, give the operator the exact PowerShell command.

---

## Definition of done

1. PR opened against `main`, all CI green.
2. Phase 4 verification time-series attached to PR description (90-min run, heap < 500 MB throughout).
3. No regression in existing tests.
4. `runestone.db` events table size unchanged (retention still working).
5. PM2 logs no longer fill with restart-loop spam after a clean restart cycle.
6. Operator gets a notification when the PR is ready for review (via ntfy if ntfy fix lands, otherwise via standard "PR ready" event).
