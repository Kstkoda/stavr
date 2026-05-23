# MCP Session Stability — Phase 0 cadence findings

**Branch:** `fix/mcp-session-stability`
**Phase:** 0 (cadence verification only)
**Date:** 2026-05-23
**Status:** COMPLETE — STOP for operator review before Phase 1.

---

## Verdict

**FIXED-TIMER.** The ~15-minute MCP session recycle is a client-driven
wall-clock timer firing every **900 s ± 1–2 s**. Not idle-driven.

This pins Phase 2 emphasis on the BOM's **2a — bounded eventStore +
replay** (calls must *survive* a planned recycle). The Phase 2b SSE
heartbeat is still useful as defence-in-depth — it costs little, and
hardens against the orthogonal idle-disconnect failure mode the recon
worried about — but it is not the primary lever. **A heartbeat cannot
prevent a wall-clock recycle.**

---

## Method

- **Source:** `tmp/pm2-stavr.err.log` (the live pm2 stderr log from the
  running `stavr` process; pino writes to stderr, so the
  `log("MCP session ${id} connected")` line at `src/transports.ts:858`
  lands here).
- **Window:** 2026-05-16 10:00:17 → 2026-05-23 18:14:12 (~7.3 days of
  uptime captured).
- **Parser:** `tmp/parse-mcp-cadence.mjs` (throwaway). Scans for
  `MCP session ${uuid} connected` and `daemon ready` lines, computes
  consecutive deltas in seconds, drops any pair whose interval crosses a
  daemon restart. Outputs distribution stats, histogram, hour-of-day,
  per-day count, and an overnight-window slice.
- **Raw output:** captured in this document (Distribution / Histogram /
  Overnight sections). Per-gap CSV written to `tmp/mcp-gaps.csv` (443
  rows, of which 419 are restart-clean).

### Caveat — client agent not in the log line

`transports.ts:858` logs only the session id; it carries no `User-Agent`
header and no `actor_id`. So this analysis measures the **aggregate**
cadence across all connecting clients (CC via shim, raw MCP clients
like Cowork, any other consumer). Per-client decomposition would
require either richer logging at the connect site or joining against
the `sse_session_opened` event log (which the global middleware stamps
with `actor_id`).

The cadence is unambiguous at the aggregate level — see Overnight
section — so the BOM-locked Q1 decision (Cowork is the primary
affected client) is consistent with the evidence without being directly
proved by it.

---

## Distribution (419 clean gaps)

| Statistic | Value |
|---|---|
| min | 0 s |
| p10 | 92 s |
| p25 | 315 s |
| **p50 (median)** | **901 s (15.02 min)** |
| **p75** | **902 s (15.03 min)** |
| **p90** | **902 s (15.03 min)** |
| p99 | 5792 s |
| max | 50 255 s |
| mean | 960.7 s |
| stdev | 3133.4 s (skewed by long quiet tails) |

The collapse of p50, p75, and p90 onto the same 901–902 s value is the
fingerprint of a fixed timer dominating the distribution — half the
population sits in a 2-second-wide spike.

### 15-min zone

| Window | Count | % of 419 |
|---|---|---|
| within ±30 s of 900 s (tightest realistic) | **186** | **44.4 %** |
| within ±90 s of 900 s | 194 | 46.3 % |
| within 14–16 min | 189 | 45.1 % |

The fact that ±30 s captures nearly all the events that ±90 s catches
(186 vs 194) is informative — once you're inside 30 s of the timer
firing, you're inside it. There's no wider "soft" cluster around 15 min,
which is what idle-driven distributions look like.

### Histogram (sub-1800 s region)

The 900–930 s bucket is **9.9× larger** than the next-highest sub-1800 s
bucket (185 vs 21 in the 0–30 s "double-connect" bucket, which is rapid
reinitialise storms — see below).

```
900-930s    185  ########################################
0-30s        21  #####
300-330s     15  ###
390-420s     14  ###
60-90s       13  ###
90-120s      13  ###
360-390s     12  ###
150-180s      9  ##
570-600s      9  ##
60+min        9  ##   (long quiet periods — stavR up, no client)
```

The minor sub-clusters (5–10 min, 0–30 s) are explained below in
Anomalies.

---

## The smoking gun: overnight cadence

Operator-idle window: 01:00–07:00 local (UTC+4). Across all 7 nights in
the sample:

| Metric | Value |
|---|---|
| connects in overnight windows | 85 |
| same-night gaps (restart-clean) | 81 |
| **median overnight gap** | **902 s (15.03 min)** |
| min / max overnight gap | 90 s / 4229 s |

The overnight median is *identical* to the all-day median. **The cadence
does not relax when no human activity drives it** — it's a free-running
timer.

Representative consecutive overnight run (2026-05-20 21:47 → 2026-05-21
03:47, 24 consecutive recycles, restart-clean, no operator activity):

```
2026-05-20T21:47:03 -> 22:02:05   902s
2026-05-20T22:02:05 -> 22:17:07   902s
2026-05-20T22:17:07 -> 22:32:08   901s
2026-05-20T22:32:08 -> 22:47:10   902s
2026-05-20T22:47:10 -> 23:02:12   902s
2026-05-20T23:02:12 -> 23:17:14   902s
2026-05-20T23:17:14 -> 23:32:16   902s
2026-05-20T23:32:16 -> 23:47:17   901s
2026-05-20T23:47:17 -> 00:02:19   902s
2026-05-21T00:02:19 -> 00:17:21   902s
2026-05-21T00:17:21 -> 00:32:22   901s
2026-05-21T00:32:22 -> 00:47:24   902s
2026-05-21T00:47:24 -> 01:02:26   902s
2026-05-21T01:02:26 -> 01:17:28   902s
2026-05-21T01:17:28 -> 01:32:30   902s
2026-05-21T01:32:30 -> 01:47:31   901s
2026-05-21T01:47:31 -> 02:02:33   902s
2026-05-21T02:02:33 -> 02:17:35   902s
2026-05-21T02:17:35 -> 02:32:37   902s
2026-05-21T02:32:37 -> 02:47:39   902s
2026-05-21T02:47:39 -> 03:02:41   902s
2026-05-21T03:02:41 -> 03:17:42   901s
2026-05-21T03:17:42 -> 03:32:44   902s
2026-05-21T03:32:44 -> 03:47:46   902s
```

24 cycles, range 901–902 s, drift across 6 hours: 0–1 s. That is
clock-driven, not load-driven.

The 901-vs-902 alternation is exactly what you get when a client timer
sleeps for 15:00.000 wall-clock and adds 1–2 s of network + handler
latency before stavR logs the new session — log-write resolution is
seconds, so adjacent log times rotate between the two integers as the
timer drifts against the second boundary.

---

## Anomalies (non-disqualifying, useful for Phase 2 design)

### The 0–30 s "double-connect" cluster (21 hits)

These are pairs of `connected` lines within seconds of each other. A
plausible source: client startup races (a shim + raw client both
initialising on the same tool invocation), or a client reconnecting
twice across a momentary failure. Out of scope for Phase 2 per BOM
(`mcp_oneshot_cleanup` follow-up territory) but the eventStore from
Phase 2a will handle these gracefully if they ever happen mid-call.

### The 5–10 min cluster (50-ish hits across 300–600 s buckets)

Bursty, irregular. Best explained as operator-driven activity (manual
restarts, shim re-initialisation on a fresh CC session, dashboard
debugging). Does not exhibit any timer signature.

### The `>60 min` tail (9 hits)

Quiet windows where stavR was up but no client was running. The 50 255 s
max gap (13.9 h) is a stretch when nothing was using the daemon at all.

### Per-day count

```
2026-05-16   19    (partial day)
2026-05-17   41
2026-05-18   19
2026-05-19   15
2026-05-20   33
2026-05-21  108
2026-05-22   81
2026-05-23  128    (still partial)
```

The recent uptick (May 21 onward) reflects more time with the affected
client connected, not a change in the timer itself — the per-gap
distribution stays at the same 900 s peak across days.

---

## Implications for the fix plan

Re-reading the BOM in light of this verdict:

> **Fixed interval** → the fix must make calls *survive* a planned
> recycle: eventStore + resumption carry the weight.

That is what the data dictates. Specifically:

- **Phase 2a (bounded eventStore) is the primary durability mechanism.**
  When the client's 900 s timer fires mid-call, the response stream's
  events must already have IDs in a store the SDK can replay from on
  reconnect with `last-event-id`. Without it, a long-blocking call
  (`await_decision`, slow `github_*` writes) lands in the recycle window
  ~1 in `(call_duration / 900)` of the time and gets silently dropped —
  consistent with the operator's observed intermittent loss.
- **Phase 2b (SSE heartbeat) drops to defence-in-depth.** It does not
  prevent the fixed-timer recycle — the client tears the session down
  unilaterally regardless of how chatty the server is on the wire. The
  heartbeat still earns its keep against the *idle-disconnect* failure
  mode (orthogonal: undici body-timeout, intermediate proxies, future
  client behaviour changes), so keep it in scope, but treat it as
  insurance rather than the load-bearing fix. The spike question in the
  BOM (SDK hook vs `transport.send` notification) stands.
- **The eventStore's bound (256 events or 5 min per stream) must comfortably
  cover a 900 s + handler-latency reconnect window for a stream whose
  long-blocking call has not yet produced its response.** For
  `await_decision` this is trivial — the stream holds at most one
  protocol-level message in flight (the eventual tool response). The
  realistic risk to the bound is bursty progress notifications from a
  long handler, which today the codebase does not emit. The bound
  remains safe; Phase 3's counter will tell us empirically.

---

## Caveats and follow-up data the fix can produce

- This analysis cannot directly identify *which* client owns the 900 s
  timer (the connect log has no UA). The decisions-locked Q1 (Cowork)
  remains the working hypothesis. Phase 3's observability work could
  add the actor_id to the connect log or to the
  `sse_session_opened` payload (already has it via middleware) to make
  per-client cadence measurable in future.
- The exact timer-source remains unconfirmed (Cowork's MCP client
  config? a wrapper library setting? a default in
  `StreamableHTTPClientTransport` that we missed?). For the fix it does
  not matter — the eventStore makes us resilient regardless of source —
  but for completeness, looking at Cowork's MCP client configuration is
  cheap and worth doing later. It is **not** a Phase 1 / 2 blocker.
- 8 of the 419 clean gaps fall in the 1800–3600 s band, and 9 sit
  beyond 60 min. These are not "the timer drifting"; they are quiet
  windows where the affected client was disconnected entirely. They do
  not weaken the verdict.

---

## Artifacts kept

- `tmp/parse-mcp-cadence.mjs` — the parser (throwaway, ~140 lines, no
  deps beyond `node:fs`).
- `tmp/mcp-gaps.csv` — 443 rows of `(prev_iso, next_iso, delta_sec,
  crosses_restart)`. Useful for spot-checks; can be deleted once the fix
  ships.
- This document: `proposed/mcp-session-stability-cadence-findings.md`.

## Phase 0 STOP

Operator reviews this document before Phase 1 (retention classification)
begins. Once green-lit, Phases 1 → 2 → 3 proceed per the BOM with a
single PR at the end.
