# Test Use Cases — stavR Daemon (2026-05-19)

**Purpose:** Test scenarios for the v0.6.11 BOM Phase 2 (synthetic load harness) and Phase 7 (verification). Mix of smoke tests, load tests, and end-to-end operator workflows.

**For CC:** the ⭐ items are the minimum bar for v0.6.11 Phase 7. Others are candidates for the bigger v0.8 stress-test BOM or manual operator testing.

---

## Group A — Smoke / sanity (<1 min each, every CI build)

### A1. Daemon cold start ⭐
Start from cold (no PID file); MCP shim connects; one trivial MCP request round-trips. **Pass:** daemon ready <5s, request <100ms, no stderr errors.

### A2. Dashboard page-load all 12 pages ⭐
Headless Chrome navigates `/dashboard/{helm,topology,streams,plans,decide,toolkit,mcps,tools,permissions,capabilities,diagnostics,settings}`. **Pass:** each page DCL in <2s, no console errors, no 4xx/5xx.

### A3. Daemon graceful shutdown
SIGTERM running daemon; verify PID cleanup + port released + clean MCP disconnect. **Pass:** shutdown <10s, no orphan, port immediately free.

### A4. Restart preserves runestone.db
Write 100 events, restart, confirm 100 events queryable. **Pass:** count unchanged, no migration errors.

---

## Group B — Load / perf (Phase 2 harness scenarios)

### B1. Sustained MCP load ⭐ — leak regression
5 rps stateless POSTs for 90 min against fresh daemon. **Pass:** heap <500 MB throughout; RSS <1 GB; no OOM.

### B2. SSE subscriber churn ⭐
Open + close 10 SSE subscribers/sec for 30 min. **Pass:** libuv handles return to baseline; broker.sessionCount() drains; no socket leak.

### B3. Mixed read+write
50% read / 30% write / 20% subscribe at 20 rps for 60 min. **Pass:** p95 read <100ms, p95 write <200ms, p95 subscribe-establish <50ms.

### B4. Cold-cache page hits
Concurrent first-time visits to each dashboard page. **Pass:** p95 TTI <1.5s, no page >3s.

### B5. Long-tail event store
100k events of mixed kinds over 4 hours, then trigger retention sweep. **Pass:** DB size returns ±10%; no uncategorized warnings.

### B6. Concurrent BOM dispatch ⭐
Queue 5 BOMs simultaneously, each spawns 3 workers (2-10 min each). **Pass:** all complete; no deadlocks; output captured; Plans page renders all 5 without freeze.

### B7. Synthetic decision queue
20 decision_requested events with 30s deadlines + synthetic responders. **Pass:** Decide page renders 20; expired marked correctly; resolved show responder + chosen + elapsed.

---

## Group C — Edge / failure resilience

### C1. Daemon crash mid-flight ⭐
Kill daemon (SIGKILL) while worker 2 of 5 is mid-execution. **Pass:** PM2 respawns; new daemon detects in-flight BOM; auto-resumes or surfaces recovery decision.

### C2. Port already in use on start
Start while another process holds 7777. **Pass:** clear error, exits non-zero, PM2 doesn't spin (min_uptime fix).

### C3. SQLite locked
Force busy condition during writes. **Pass:** retry with backoff; no data loss; eventual write succeeds.

### C4. Shim disconnect mid-request
Daemon kills TCP connection mid-MCP-response. **Pass:** sessionCount decrements; clean client error (no hang).

### C5. Disk full during event write
99% disk usage; 100 event publish attempts. **Pass:** graceful fail; `disk_pressure` event emits; operator notified via ntfy.

### C6. Notifier dispatch failure with retry
ntfy returns 503; 10 notifications queued. **Pass:** bounded retry (≤3); falls through to telegram fallback; operator sees notifications.

### C7. OOM-near-limit watchdog
Force heap pressure until RSS exceeds STAVR_RSS_WATCHDOG_MB. **Pass:** watchdog warns + writes snapshot; daemon stays alive; operator notified.

---

## Group D — End-to-end operator workflows

### D1. Onboarding cold-start
Fresh daemon → install GitHub MCP → Tools page → run a tool. **Pass:** complete <5 min, no errors, tool result correct.

### D2. Capture-this → BOM proposal
Click Capture-this → "investigate X" → Send. **Pass:** BOM proposal on Plans page <5s; correlation_id traceable.

### D3. Approval timeout fallback
Tier 3 action; operator ignores; deadline expires. **Pass:** default option chosen at deadline; status=expired; audit shows responder=switch-default, reason=timeout fallback.

### D4. Mid-BOM mode switch (v0.8 scope)
Operator switches mode chip mid-execution. **Pass:** pause at next checkpoint; queue for review.

### D5. Federation handoff (v0.7+ scope)
Originator dispatches BOM requiring peer resources. **Pass:** both sides have audit events; handshake <5s.

### D6. Leak symptom + auto-recovery ⭐
Force event-store retention OFF; run load 1 hour. **Pass:** RSS-watchdog fires before OOM; daemon auto-restarts or warns clearly.

### D7. Mid-execution no-go edit (v0.8 scope)
Add "delete file" no-go rule, dispatch BOM with delete op. **Pass:** new rule active; BOM blocked at delete step.

### D8. Dashboard nav stress ⭐
Headless Chrome navigates between all 12 pages, 5 times each (60 navs) in 2 min. **Pass:** no page-freeze >100ms; SSE multiplexer handles churn; daemon RSS flat ±50 MB.

### D9. Hot-reload while Cowork connected
Operator runs `pm2 restart stavr` while Cowork has active MCP session. **Pass:** shim auto-reconnects <5s; no permanent failure; mid-request retries cleanly.

---

## Group E — UI / dashboard-specific

### E1. Capture-this ARIA correctness
Open dialog, keyboard tab through. **Pass:** focus enters dialog; aria-labelledby on radio groups; Esc closes.

### E2. Plans page tab keyboard nav
Tab to filter tabs, Enter/Space activate. **Pass:** discernible labels; content swap announced.

### E3. Decide page expand/collapse
Click row to expand, click again to collapse. **Pass:** smooth animation; state preserved; keyboard accessible.

### E4. Topology shortcut rebind
Press `/` on Topology. **Pass:** search focused; Ctrl+K no longer collides; visible hint present.

### E5. Helm tier-band sizing
Render at 1024/1440/1920 widths. **Pass:** all 5 bands same width; columns align vertically across all 5 tiers.

### E6. Inspector panel auto-hide
Navigate to Plans page. **Pass:** Inspector hidden; main area uses full width.

---

## ⭐ Minimum bar for v0.6.11 Phase 7

8 starred items: **A1, A2, B1, B2, B6, C1, D6, D8.**

Everything else is v0.8 stress-test BOM material or manual testing during v0.7 federation rollout.

---

## Test infrastructure suggestions for Phase 2

1. **Library**: Playwright (better than puppeteer for dashboard nav). Plain `http` + `eventsource` Node for MCP/SSE load.
2. **Shape**: `tmp/perf/run-suite.mjs --suite={smoke,load,nav,full}`. Output: JSON time series per scenario.
3. **CI fitness**: Smoke + load <10 min in CI on every PR. Full suite is overnight.
4. **Report rendering**: JSON output suitable for the new `/dashboard/diagnostics#perf` panel (Phase 4) and PR descriptions.
