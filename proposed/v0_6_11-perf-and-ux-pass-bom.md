# BOM: feat/v0.6.11-perf-and-ux-pass

**Owner:** CC (autonomous)
**Sensitivity:** careful (touches live dashboard, perf-critical paths, multiple pages)
**Branch:** `feat/v0.6.11-perf-and-ux-pass`
**Base:** `main` (post PR #45 merged 2026-05-19 09:11Z, post PR #47 merged 2026-05-19 08:52Z)
**Estimated scope:** 7 phases, ~3-6 hour autonomous run

---

## Current state (verified 2026-05-19 via GitHub API)

- PR #45 (topology revamp) — MERGED
- PR #46 (leak fix BOM doc) — MERGED
- PR #47 (memory leak fix) — MERGED
- No prerequisite blockers; start directly from `main`.

The audit findings doc `proposed/v0_6_11-ux-audit-findings.md` was generated AGAINST the post-PR-#45 dashboard, so its Topology findings reflect what PR #45 actually shipped (vs what was planned). Notably PR #45 did NOT fully remove the worker roster from Topology (it duplicates with Streams). TO1/TO2 findings remain in scope for this BOM Phase 6b.

## Context — operator-led signal collection complete (2026-05-19)

Today's operator activity surfaced these symptoms + design gaps. The diagnostic priors are in memory files — **DO NOT REDISCOVER.**

### Symptoms (operator-observed)

- **Plans page freezes on enter AND on leave.** The v0.6.5 PR #2 P4 SSE multiplexer was supposed to fix nav-freeze; either it didn't ship or doesn't cover Plans. Verify deployment status of the multiplexer first.
- **No visible changes after PR #47 merge.** Operator expected the new `/dashboard/api/diagnostics/memory` endpoint to surface visually on the diagnostics page. PR #47 only landed the API; no UI consumer was added. Gap in BOM scope — fix in this PR.
- **"It still looks lego."** Layout cohesion is incomplete. Pages feel like assembled puzzle pieces, not unified design. Cross-page typography, spacing, color usage, and interaction patterns drift. A parallel UX audit by the operator's design partner (Claude via Cowork + Chrome connector) is running concurrently with this BOM; **CC should pull `proposed/v0_6_11-ux-audit-findings.md` as input for Phase 6** once Claude commits it.
- **Helm has no version number.** Operator wants the running daemon version visible at all times. Easy: pull from `package.json`, render near the topbar wordmark.

### Memory-tracked QA followups to bundle (from prior reviews)

These are previously documented but deferred — bundle into Phase 6:

- **Tools page** (`project_stavr_tools_page_redesign_followup`): `github.*` tools tagged "Other" (should be "GitHub"); no grouping by category; no visible tier hierarchy.
- **Topology page** (`project_stavr_topology_page_redesign_followup`): galactic-map empty (data fetcher doesn't wire MCP registry → nodes); worker roster belongs on Streams; in-flight BOMs belong on Plans; palette-door FAB has parked v0.7 buttons; timeline scrubber needs YouTube-style event-density heatmap; Ctrl+K rebinds to `/`.
- **Decide page** (`project_stavr_decide_page_redesign_followup`): Recently Resolved rows should be clickable to inline-expand full decision record.
- **Helm page** (`project_stavr_helm_page_redesign_followup`): 5 tier bands freelance column layouts; fix with single CSS grid `200px 1fr auto` + secondary 12-col body grid.

### Already verified — do NOT re-investigate

- McpServer per-session leak (FIXED in PR #47)
- SQLite events table growth (NOT a leak; runestone.db is 5.5 MB total)
- OTel collector (returns null when endpoint unset; safe)
- ntfy header bug (FIXED in PR #47 commit bca959a)
- PM2 restart-loop fast-fail (FIXED in PR #47 commit 80fdd27)
- The orphan-daemon pattern bug (DIFFERENT from PM2 restart loop; logged separately as task #40 for v0.6.12; NOT in scope for this BOM)

---

## Phases

### Phase 0 — Recon (read-only, ≤30 min)

- Re-read CLAUDE.md (hard invariants apply throughout).
- Read `proposed/v0_6_11-ux-audit-findings.md` if Claude has committed it; if not, proceed without — but check back after Phase 2.
- Profile Plans page nav-freeze in headless Chrome (puppeteer or playwright in `tmp/perf/`) — record main-thread blocking, event-loop lag, JS heap delta on enter and on leave. Save trace to `tmp/perf/plans-freeze-trace.json`.
- Locate the v0.6.5 SSE multiplexer code in `src/dashboard/data/`. Confirm it's wired into the live shell. If not, that's the freeze root cause.
- Output 1-page findings doc → `proposed/v0_6_11-perf-findings.md`. Commit + push BEFORE Phase 1.

### Phase 1 — Fix Plans-page freeze

- Implement based on Phase 0 findings. Likely candidates:
  - SSE multiplexer not deployed → deploy it
  - Plans page renders too much synchronously → virtualize / paginate
  - Cleanup on nav-away missing → add cleanup hook
- Regression test: headless puppeteer script that navs to/from Plans 10 times, asserts heap stays < 200 MB and time-to-interactive < 500ms.
- DCO commit. Push.

### Phase 2 — Synthetic load harness

- Build `tmp/perf/load-runner.mjs` — extends CC's earlier `load-and-sample.mjs` to cover:
  - MCP request/response cycles (not just POSTs)
  - SSE subscriber churn (open/close N subscribers/sec)
  - Mixed read+write workload
  - Configurable concurrency, duration, request mix
- Output: structured JSON time series + summary stats per endpoint.
- DCO commit. Push.

### Phase 3 — Response-time + perf metrics

- Instrument key endpoints with timing: every MCP method, every dashboard data fetcher, every SSE event broadcast.
- Expose as `/dashboard/api/perf` endpoint returning `{ endpoints: { ... p50/p95/p99/count/error_rate per route } }`.
- Plumb into the existing observability fabric (Pino logs + daemon_memory event channel pattern).
- Add new event kind `perf_sample` published every 60s.
- DCO commit. Push.

### Phase 4 — Perf + memory dashboard panel

- Add new panel/section on `/dashboard/diagnostics` page that:
  - Shows live heap_used + RSS chart (Chart.js or similar) consuming `/dashboard/api/diagnostics/memory` (PR #47's endpoint, currently unused by UI)
  - Shows response-time distributions per endpoint from Phase 3
  - Shows event-throughput per kind
  - Includes a "Run synthetic load" button that triggers the Phase 2 harness via authenticated POST (operator-only, EXPLICIT-tier action)
- Make it deep-linkable: `/dashboard/diagnostics#perf` jumps to the perf panel.
- DCO commit. Push.

### Phase 5 — Version display

- Read version from `package.json` at daemon boot, expose via existing config endpoint.
- Render in topbar wordmark area: `stav ᚱ v0.6.11` or as a small chip near system-health cluster.
- Match the iron-palette + design conventions in `proposed/v0_6_11-ux-audit-findings.md` if Claude's audit specifies placement.
- DCO commit. Push.

### Phase 6 — Bundled QA polish

One sub-commit per page:

- **6a — Tools page**: re-tag `github.*` as "GitHub" category; add visual grouping; add tier hierarchy (visual weight differs across AUTO / CONFIRM / EXPLICIT / NO-GO cards).
- **6b — Topology page**: wire MCP registry → galactic-map nodes; move worker roster → Streams; move in-flight BOMs → Plans; clean up palette-door FAB (hide v0.7 buttons); render timeline scrubber heatmap (thickness ∝ event density per 1-min bucket, hover tooltip with event-kind breakdown); rebind Ctrl+K to `/`.
- **6c — Decide page**: make Recently Resolved rows clickable; inline-expand to show question + options + default + deadline + reason text + responder + timestamps + elapsed.
- **6d — Helm page**: single CSS grid `200px 1fr auto` per tier band + secondary 12-column body grid; align big numbers, drill-down buttons, sub-labels across all 5 tiers.
- **6e — Apply UX audit feedback** from `proposed/v0_6_11-ux-audit-findings.md` (one commit, may include cross-page tweaks like consistent typography, spacing, button styles).

Each sub-phase is a DCO commit. Push after each.

### Phase 7 — Verification (DO NOT skip)

- Run Phase 2 load harness for 90 min against the daemon with all changes live.
- Confirm:
  - Plans page nav: 10 consecutive enters/exits, no freeze > 100ms, heap stable
  - Memory: heap stays < 500 MB across the 90 min (PR #47 leak fix still holds)
  - Response times: p95 < 100ms for dashboard data fetchers; p95 < 50ms for MCP request/response
  - Event throughput: matches load harness rate within 1%
  - No 5xx in logs, no unhandled rejections, no V8 OOM
- Open PR against `main` with verification time-series + screenshots of new perf panel attached.

---

## Constraints (per CLAUDE.md hard invariants)

- **Per-phase commits**, all `git commit -s` (DCO).
- **`git status --short` + `git symbolic-ref HEAD` before every git op** (rule #8).
- **Don't touch list** still applies — this BOM does NOT open `src/persistence.ts`, `src/types/`, `migrations/`, `db/schema*`. Phase 4's new panel mounts NEW fetchers in `src/dashboard/data/` — that's allowed (new files, not reshaping existing).
- **Tests are derivative** — if a test asserts on Plans-page render shape that this BOM changes, update the assertion in the same commit.
- **Verify file writes** with `stat -c %s` + `tail -5` (rule #2). Heredoc for new files >30 KB.
- **NO-GO handoff** if you hit an action you can't take — name it, give the operator the exact PowerShell command.

---

## Definition of done

1. PR opened against `main`, all CI green.
2. Phase 7 verification attached to PR description (90-min run, all assertions hold).
3. Plans page no longer freezes on nav (verified via puppeteer regression test).
4. New perf panel on `/dashboard/diagnostics#perf` rendering live heap + response-time + event-throughput data.
5. Helm page shows daemon version number.
6. All 4 QA sub-phases applied (Tools, Topology, Decide, Helm align).
7. UX audit findings from `proposed/v0_6_11-ux-audit-findings.md` (when committed by Claude) applied in 6e.
8. No regression in existing tests.
9. Notification sent via ntfy when PR is ready (uses ntfy-fix from PR #47).
