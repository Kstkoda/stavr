# ADR-033 — stavr-tray companion (revised from stavr-watch standalone supervisor)

**Status:** Proposed
**Date:** 2026-05-16 (revised from earlier draft after recheck)
**Related:** ADR-006 (loopback-only), ADR-020 (in-daemon worker watchdog), ADR-030 (retention), ADR-031 (observability stack)

> **Revision note:** An earlier draft of this ADR proposed a from-scratch Rust/Go binary `stavr-watch` that would supervise the daemon (poll `/health`, restart on failure, OS tray icon, OS notifications). That design predated the parallel observability arc shipping PRs #15-#21. With PM2 (PR #17) already serving as the process supervisor and the diagnostics endpoints (PRs #18, #20, #21) exposing rich operational signals, building a from-scratch supervisor would duplicate PM2's job for a small UX win. This revision pivots to a much smaller `stavr-tray` companion that **leverages the existing stack** rather than replacing it.

## Context

The 2026-05-15 OOM exposed a gap: when the daemon dies, the operator may not notice for hours. PM2 restarts it, but PM2's UX is CLI-only (`pm2 list`, `pm2 logs`). The dashboard is dark while the daemon is down — it's the daemon serving it.

Kenneth's framing on 2026-05-16: *"quis custodiet ipsos custodes?"* — the operator needs ambient visibility into daemon health without opening a terminal or the dashboard. OS-native presence: tray/menu-bar icon, desktop notifications.

The pieces now in place that change what's needed:

| Capability | Provided by |
|---|---|
| Restart on crash | PM2 `ecosystem.config.cjs` (PR #17) — `args: ['daemon', 'start']` |
| Liveness check | `GET /healthz` (PR #18) |
| Memory metric | `GET /metrics` → `process_resident_memory_bytes` |
| Pre-OOM heap snapshot | `--heapsnapshot-near-heap-limit=2` flag in start script (PR #15) |
| On-demand heap snapshot | `POST /debug/heap-snapshot` (PRs #15, #20) |
| On-demand CPU profile | `POST /debug/cpu-profile?duration=N` (PR #20) |
| On-demand diagnostic report | `POST /debug/diagnostic-report` (PR #20) |
| Event-loop lag gauge | `stavr_eventloop_lag_seconds` (PR #21) |
| Trace correlation | OTel + correlation_id middleware (PR #21) |

PM2 + this diagnostics stack already does **the supervision and the introspection.** What's missing is **the operator's ambient awareness layer.**

## Decision

1. **Build `stavr-tray` — a tiny ~200-line companion app** instead of a from-scratch supervisor. Its responsibilities are narrow:
   - Read PM2 status (via `pm2 jlist` socket call or shelling out to `pm2 list --json`)
   - Poll daemon `/healthz` every 5s
   - Read selected `/metrics` lines (heap, RSS, eventloop lag p99) every 30s
   - Render OS tray/menu-bar icon based on combined health
   - Fire OS notifications on incidents
   - Right-click menu: trigger diagnostic endpoints, open dashboard, open Jaeger UI, open Prometheus

2. **Choose Tauri 2 or wxPython** for the binary. Recommend Tauri 2:
   - Cross-platform (macOS / Windows / Linux from one codebase)
   - Tiny bundle (~5-10 MB)
   - Webview-rendered tray menu can show recent events, sparklines, live metric mini-charts
   - Rust core for OS integration (tray, notifications, PM2 socket)
   - Frontend in vanilla HTML/CSS/JS — same design tokens as the Helm dashboard
   
   Alternative: pure Rust with `tray-icon` crate + `notify-rust` if webview is unwanted overhead. ~3 MB binary; menu is text-only.

3. **No process supervision.** PM2 owns that. `stavr-tray` is read-only with respect to lifecycle: it observes, surfaces, and exposes diagnostic triggers. It does NOT decide to restart anything (PM2 + `--report-on-fatalerror` already cover that). The operator can manually trigger `pm2 restart stavr` from the tray menu, but that's a forwarded command, not a supervision decision.

4. **Tray icon states** (mirrored on the dashboard `WATCH OK` pip via the `/healthz` + `/metrics` data, no separate API):
   - 🟢 healthy — `/healthz` 200, RSS < 80% of cap, eventloop lag p99 < 50ms, no incidents in last hour
   - 🟡 degraded — any of: one missed health check, RSS 80-95% of cap, eventloop lag p99 50-200ms, or incident in last hour
   - 🔴 down — `/healthz` failing 3× in a row OR PM2 reports `errored`/`stopped`
   - ⚙ restarting — PM2 reports state transition
   - ⚫ unreachable — daemon port not bound at all

5. **OS notifications** fired on:
   - State transitions (healthy → degraded → down → healthy)
   - Pre-OOM warning (RSS crosses 90% threshold)
   - Daemon restart (whether PM2-initiated or user-triggered)
   - Stuck event-loop detected (lag p99 > 1s)
   
   No other events fire OS toasts. Routine events stay in the dashboard's notifications sheet.

6. **Right-click menu surfaces diagnostics** as one-click actions:
   - Open dashboard
   - Open Jaeger (if `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT` is set, derive UI URL)
   - Open Prometheus (if `STAVR_PROM_UI_URL` is set)
   - Take heap snapshot now → POST `/debug/heap-snapshot` → notification with file path
   - Take CPU profile (30s) → POST `/debug/cpu-profile?duration=30` → notification when done
   - Take diagnostic report → POST `/debug/diagnostic-report` → notification with file path
   - Restart daemon → `pm2 restart stavr --update-env`
   - Tail logs → `pm2 logs stavr -f` in a new terminal window
   - Quit tray
   
   These bind the operator's "I want to know what's wrong" intent directly to the diagnostic endpoints PRs #18-#21 already shipped.

7. **No own state store.** `stavr-tray` is stateless beyond a small `~/.stavr/tray/config.yaml` for menu preferences and `STAVR_DEBUG_ENABLED` flag handling. Incident history lives in the daemon's runestone.db (per ADR-030 retention model — `daemon_memory`, `sse_session_*`, `retention_swept` are operational events the daemon already records).

8. **Per-platform packaging:**
   - macOS: `.app` bundle with launchd plist for autostart
   - Windows: `.exe` installer (NSIS or MSI) + Startup folder shortcut
   - Linux: AppImage + systemd `--user` unit

## Consequences

**Positive:**
- ~200-line companion vs ~500-1000 for a from-scratch supervisor — 4× less code to maintain
- PM2's supervision logic (battle-tested, decades of correctness) is the source of truth for restarts, not our custom code
- Operator gets ambient awareness + one-click diagnostic triggers without learning the curl commands
- Tray icon + dashboard pip mirror each other, single mental model
- Pre-OOM warning gives operator chance to investigate BEFORE restart wipes the in-memory state

**Negative we accept:**
- Adds a dependency on PM2 being the chosen supervisor (already true; ecosystem.config.cjs shipped in PR #17)
- macOS menu bar UX differs from Linux/Windows tray; per-platform polish required
- Apple Silicon Tauri sometimes needs explicit code signing; document in installer scripts
- If user disables PM2 and runs the daemon directly via `npm start`, tray loses its restart-state visibility (degrade gracefully — show 🟢 if `/healthz` ok, hide PM2-specific menu items)

## Alternatives considered

- **From-scratch Rust supervisor** (the original draft) — duplicates PM2's job. Rejected after PR #17 landed.
- **Pure CLI tool, no tray** — lose ambient awareness; operator forgets to look. Rejected.
- **Browser-tab dashboard always open** — loses presence when tab is in background; not OS-native. Rejected as primary.
- **Embed in PM2 Plus paid offering** — proprietary; locks operator into a vendor.
- **Build it into the dashboard as a service-worker notification** — works for browser-active scenarios; doesn't help when browser is closed. Rejected as sole surface.

## Implementation

`proposed/v0.6-stavr-tray-bom.md` (to be drafted) — phase-by-phase spec. ~6-8h autonomous run (much smaller than the original watchdog spec). Sequenced after PR #21 lands and after v0.4 visible-value bundle ships, but can run in parallel with v0.5 Steward portability since they touch different surfaces.

## Acceptance for moving Status to Accepted

1. v0.6 stavr-tray BOM lands in `proposed/`
2. Tauri vs pure-Rust binary choice locked in
3. Per-platform packaging plan validated (at minimum macOS + Windows; Linux can defer)
