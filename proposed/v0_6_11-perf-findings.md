# v0.6.11 — Phase 0 perf findings (Plans-page freeze)

**Author:** CC (autonomous)
**Date:** 2026-05-19
**Status:** input to Phases 1–7 of `v0_6_11-perf-and-ux-pass-bom.md`

---

## TL;DR

There is **no SSE multiplexer in the repo** — the v0.6.5 PR #2 P4 mention in
the BOM is aspirational (`git log --all | grep -i multiplex` returns nothing
relevant). Every dashboard page opens its **own** `EventSource` on
`/dashboard/stream` and the dashboard uses **server-rendered full-page navigation**
(plain `<a href=>` links), so each tab switch tears down and re-establishes
the whole runtime + a fresh SSE connection.

The reported "freeze on enter AND on leave" for **Plans** is caused by **two
distinct hazards**, not one:

1. **Enter freeze**: Plans page's live-refresh strategy is `window.location.reload()`
   whenever the BOM-id set changes (`src/dashboard/pages/plans.ts:608-611`).
   Combined with a fast SSE feed of `bom_*` events on a busy daemon, the page
   can reload in a loop until events settle — visible as a freeze.
2. **Leave freeze**: each page mounts ≥4 inline scripts (INSPECTOR_JS,
   FLOATING_INSPECTOR_JS, TIMELINE_JS, WATCHDOG_PIP_JS, CAPTURE_BUTTON_JS,
   SHELL_CONN_JS, SHELL_CLOCK_JS) plus its own PAGE_JS, **none of which
   register `pagehide`/`unload` cleanup**. Multiple `setInterval` timers
   (clock tick @ 1s, plans refresh @ 6s, scrubber @ 500ms in some pages) keep
   firing into a dying document while the browser tears it down — Chrome
   does not freeze on the timers themselves but their callbacks issue
   `fetch()` requests that the browser must cancel one-by-one during unload.

Both problems are fixable with **client-side patches only** — no broker /
persistence / SSE-server changes required.

## What the v0.6.5 multiplexer would have been

A shared `BroadcastChannel`-backed SSE tap so all dashboard tabs share **one**
upstream connection per origin. Cleanly out of scope for v0.6.11 (would
require a service worker or `localStorage` coordination dance). Phase 1 will
adopt a **simpler** equivalent: a per-tab singleton EventSource exposed on
`window.__stavrStream` that all pages subscribe to via `addEventListener`
rather than opening their own connection. Saves one connection per tab and
removes the cleanup burden from each page.

---

## Static-analysis findings

### F-1 — Plans page reloads on BOM-set diff

**Location:** `src/dashboard/pages/plans.ts:608-611`

```js
if (differs) {
  window.location.reload();
  return;
}
```

If two `bom_proposed` events arrive in quick succession, `schedule()` debounces
to a single `refresh()`. But the refresh fetches `/dashboard/plans/list` which
sees both new BOMs → `differs=true` → reload → page re-mounts → new
EventSource → first event tap → `differs=true` (because the next BOM has
arrived in the meantime) → reload again. Operator observation of "freeze on
enter" matches this exactly.

**Fix (Phase 1):** replace `window.location.reload()` with an in-place
re-render of the BOM list using the JSON snapshot already in hand (`data.boms`).
No round-trip, no document teardown.

### F-2 — No `pagehide`/`beforeunload` cleanup on any page

**Locations:** all `src/dashboard/pages/*.ts` `PAGE_JS` blocks.

`setInterval(refresh, 6000)`, `setInterval(tick, 1000)` (shell clock),
SSE listeners, and in-flight `fetch()` calls all leak into unload.

**Fix (Phase 1):** add a single shell-level `window.__stavrCleanup` registry
that pages push dispose fns into; `window.addEventListener('pagehide', …)`
drains it before unload.

### F-3 — Every page opens its own `EventSource`

**Locations:** 8 occurrences (grep "new EventSource"):
`pages/decide.ts`, `pages/diagnostics.ts`, `pages/home.ts`, `pages/plans.ts`,
`pages/settings.ts`, `pages/streams.ts`, `pages/topology.ts`,
`widgets/topology-flow-particles.ts`.

Each one duplicates the keepalive + reconnect logic and the broker fans every
event to all of them on the server side.

**Fix (Phase 1):** introduce `window.__stavrStream` in `shell.ts`. Pages call
`window.__stavrStream.on('event', cb)` and receive a `dispose()` — registered
into `__stavrCleanup` (F-2).

### F-4 — Shell scripts run on every page (full reload cost)

**Location:** `src/dashboard/shell.ts:461-467`

7 inline `<script>` tags execute on every navigation. ICON_SPRITE_SVG is also
inlined per page. Combined with the largest payloads (Topology = 144 KB,
Helm = 74 KB, Diagnostics = 84 KB, Plans = 60 KB — measured by
`tmp/perf/freeze-probe.mjs` against an empty daemon), each nav re-parses
~50–150 KB of HTML + 30 KB of JS.

**Fix (Phase 1):** noted but **deferred** — the shell scripts are small (a
few hundred lines combined) and modern browsers parse this in <10ms.
Phase 1 will fix the freeze first; payload-trim is a Phase 4-adjacent
follow-up if metrics justify it.

### F-5 — Topology page is the heaviest dashboard page

144 KB of HTML per nav (measured). With many MCP nodes / actor-nodes /
in-flight permissions, it will grow further. Not the freeze cause (server
serves it in ~3 ms), but it is the worst-feeling page on slow links and a
prime UX-audit target for Phase 6b.

### F-6 — `/dashboard/api/diagnostics/memory` is server-only

The endpoint added by PR #47 returns JSON but no page consumes it. This is
the gap the operator flagged. **Phase 4** mounts a new panel on Diagnostics
that reads from this endpoint and renders a live heap+RSS chart.

---

## Measured baseline (empty daemon, no events, no BOMs)

`node tmp/perf/freeze-probe.mjs --port 7779 --iterations 15 --sse-seconds 20`

| Page         | bytes  | p50 ms | p95 ms | p99 ms |
|--------------|-------:|-------:|-------:|-------:|
| helm         | 73,981 |   1.74 |  21.74 |  21.74 |
| plans        | 60,819 |   1.39 |   1.80 |   1.80 |
| topology     |144,628 |   2.81 |   3.77 |   3.77 |
| decide       | 57,926 |   1.35 |   1.69 |   1.69 |
| diagnostics  | 83,993 |   2.59 |   4.42 |   4.42 |
| streams      | 56,123 |   1.32 |   5.58 |   5.58 |
| tools        | 53,414 |   1.35 |   8.65 |   8.65 |

SSE during the 20-s sample: 2 events (both `ping` keepalive). No `bom_*`
churn — to reproduce the operator's freeze we'd need a daemon with real
BOMs streaming. That measurement is gated on the Phase 2 load harness;
verification will re-run this probe on a loaded daemon.

Browser-level main-thread / heap trace (`tmp/perf/plans-freeze-trace.json`)
was **not captured** in Phase 0 — no puppeteer/playwright is in package.json
and adding one is on the don't-touch list. The static-analysis hypotheses
above are concrete enough to remediate; Phase 7 verification uses the
load harness + a manual Chrome DevTools record (operator-driven) for the
trace.

---

## Phase 1 plan (binding)

1. Shell: add `window.__stavrCleanup` (Set<()=>void>) + `pagehide` drain.
2. Shell: add `window.__stavrStream` singleton — one EventSource per tab,
   pages subscribe via `.on('event', cb) → dispose`.
3. Plans page (`src/dashboard/pages/plans.ts`):
   - Replace `window.location.reload()` (lines 608-611) with in-place
     `applyFilter()` after rebuilding the `data-bom-id` set.
   - Migrate the page's EventSource + setInterval onto `__stavrStream`
     and `__stavrCleanup`.
4. Other pages (home, topology, decide, diagnostics, settings, streams,
   widgets/topology-flow-particles): migrate `new EventSource` → shared stream
   in the same commit so the singleton is the only opener (F-3 closure).
5. Regression test: extend `tmp/perf/freeze-probe.mjs` with a "nav stress"
   mode (Node `fetch` loop that re-issues `GET /dashboard/plans` 30× within
   3 s) and assert TTFB stays <50 ms and broker SSE-session count returns
   to baseline within 2 s of last load. Browser-level TTI assertion is a
   manual Phase 7 step (operator records via DevTools, attaches to PR).

End of Phase 0.
