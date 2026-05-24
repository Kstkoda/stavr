# BOM: stavR Governor — Operator Companion Refactor

**Owner:** CC
**Sensitivity:** `routine` — the Governor app has no current users (it is not running in production); changes are low blast-radius. Standard autonomous flow; one delta report at completion.
**Verification window:** `targeted` — `cargo build` + `cargo test` green per phase. CC does NOT exercise restart/upgrade/approvals against the live daemon — the operator runs that smoke (Phase 6).
**Branch:** `feat/governor-observe-only` off `main` (currently `9ac6d8e`).
**Base:** `main`.
**Estimated scope:** 6 working phases + recon. One PR.

---

## Why this BOM exists

The Governor story is currently messy, and this BOM consolidates it into one coherent thing.

The os-native-governor work (PR #76, merged 2026-05-24) made the OS init system — Windows Service via WinSW, systemd, launchd — the daemon's supervisor. The operator migrated his daemon onto the WinSW `StavrDaemon` service the same day. But the Tauri Governor companion app (`governor/`, ADR-033) still runs its **own** supervision loop — `Supervisor::run_forever()` polls `/healthz` and restarts the daemon via `restart.rs`. Run it as-is and two supervisors fight over the daemon. Meanwhile there is no tray icon, no approval notifications outside Telegram, and the operator checks daemon health by curling `/healthz` by hand.

This BOM makes the Governor the operator's **single companion** for the daemon — it does three things and only three things:

1. **Observes** — a tray pip showing daemon `/healthz` + OS-service status. No autonomous supervision loop (the WinSW service is the sole supervisor).
2. **Notifies** — a native OS notification when the daemon opens an approval gate (CONFIRM/EXPLICIT-tier decision), deep-linking to the Decide page.
3. **Controls** — operator-triggered **Restart Daemon** and **Upgrade Daemon** actions. Operator-triggered control is not supervision: nothing fires unless the operator clicks it, so there is no competing auto-restart and no conflict.

Plus: it auto-starts at login, so the operator always has it.

**Operator context:** Kenneth migrated to the WinSW service 2026-05-24, wants the tray icon back, wants approval notifications surfaced, and wants the Governor to be where he restarts *and* upgrades the daemon.

---

## Phases

### Phase 0 — Recon

Pin the current state: `governor/src/{main,supervisor,state,tray,restart,actions,port_check,event_router,event_bridge,notification}.rs`, their `#[cfg(test)]` modules, `governor/Cargo.toml`, `governor/tauri.conf.json`. Confirm: (a) the supervision/restart call graph; (b) how the daemon emits an event when a decision-gate opens, and what the current `EventRouter` does with that event kind. One short findings paragraph in the PR description. Proceed unless reality diverges materially from this BOM.

### Phase 1 — Desupervise the core

- `Supervisor` becomes a health **monitor**: `tick()` probes `/healthz`, records the outcome on the state machine, stops there. Delete the `should_restart` block and the restart wiring in `run_forever()`. Rename `Supervisor` → `HealthMonitor` (encouraged).
- **Delete `restart.rs` outright** — `RestartError`, `Restarter`, `Pm2Restarter`, `SidecarRestarter`, `OrphanAwareRestarter`, `SystemKiller`, `ProcessKiller`, `MockRestarter`, `MockKiller`, `restart_with_orphan_kill`. Delete `port_check.rs` if it is only used by the orphan-kill path (CC confirms). Remove all imports from `main.rs` / `supervisor.rs`.
- Temporarily drop the daemon-control tray menu items ("Restart Daemon", "Pause supervision") — reworked back in Phase 4. Leave Open Dashboard / View Logs / View Decide Queue / Mute · 1h / Mute · 1d / Unmute / Quit.
- **Leave the event-bridge → `EventRouter` → OS-toast path untouched** — that is observability, and Phase 3 builds on it.
- `DaemonState::{Restarting, GiveUp, StoppedManually}` become unreachable — leave the enum intact.
- **Tests are derivative (CLAUDE.md invariant #1):** rewrite/remove the supervision tests in `supervisor.rs` / `restart.rs` and update `tray.rs` `menu_ids_*` tests **in the same commit**.
- **Acceptance:** the Governor has no code path that can restart the daemon; `cargo build` + `cargo test` green.

### Phase 2 — OS-service awareness

New module `governor/src/service.rs` — queries the OS-native service status per-platform: Windows `sc query StavrDaemon`; Linux `systemctl --user is-active stavr.service`; macOS `launchctl print gui/<uid>/com.stavr.daemon`. The tray pip + tooltip combine daemon `/healthz` and service status: Running + ok → **green**; Running + `/healthz` failing → **amber**; Stopped/NotInstalled → **red/grey**.

**Acceptance:** with the WinSW service running the pip is green; `Stop-Service StavrDaemon` turns it red within a couple of ticks.

### Phase 3 — Approval notifications

When the daemon opens a decision-gate (a CONFIRM- or EXPLICIT-tier action awaiting operator approval), the Governor raises a **distinct, actionable** native OS notification — "stavR — approval needed", with the action summary — and clicking it opens `/dashboard/decide`.

- The infrastructure exists: `event_bridge.rs` subscribes to the daemon's SSE event stream, `event_router.rs` maps event kinds → toasts, `notification.rs` (`TauriToastRenderer`) renders them. This phase ensures the decision-gate event kind is subscribed and rendered as a *first-class approval notification* — not folded into generic event toasts.
- Click handler → `actions::open_dashboard(app, "/dashboard/decide")`.
- The Governor does NOT host an approval UI — the operator approves in the dashboard (consistent with ADR-033 / the family-mode-phase-2 "B+" decision). The notification is the prompt, the Decide page is the surface.
- Phase 0 recon supplies the exact decision-opened event kind(s).
- **Acceptance:** trigger a CONFIRM/EXPLICIT decision on the daemon → an OS notification appears → clicking it opens the Decide page.

### Phase 4 — Operator control surface (Restart + Upgrade)

Two operator-triggered tray actions. Both delegate; neither is a supervision loop.

**Restart Daemon** → `service.rs::restart()`: Windows `Restart-Service StavrDaemon` via an elevated helper (`Start-Process -Verb RunAs` → a UAC prompt — appropriate friction); Linux `systemctl --user restart stavr.service`; macOS `launchctl kickstart -k gui/<uid>/com.stavr.daemon`.

**Upgrade Daemon** → invokes a new hardened upgrade script (elevated where needed):

- Add `bin/upgrade-daemon.ps1` (Windows) + `bin/upgrade-daemon.sh` (Linux/macOS) — a service-aware successor to the operator's ad-hoc `deploy-stavr.ps1`.
- **Upgrade script contract — a failed upgrade must always leave the daemon running the pre-upgrade commit:**
  1. Capture `OLD = git rev-parse HEAD`.
  2. Stop the OS-native service.
  3. `git pull` (fast-forward `main`).
  4. `npm ci`.
  5. `npm run build`.
  6. Start the service; health-check `/healthz` (poll, ~60 s timeout).
  7. **On any failure in 3-6:** `git reset --hard $OLD` → `npm ci` → `npm run build` → start the service → exit non-zero with a clear reason.
  8. On success: report the new version.
- The "Upgrade Daemon" action invokes the script, shows "upgrading…" in the tray, reports the outcome via an OS toast.

**Acceptance:** `cargo build` + `cargo test` green; the upgrade script's rollback path is tested with a forced-build-failure case.

### Phase 5 — Governor auto-start

Add `tauri-plugin-autostart` (Startup-folder/registry on Windows, LaunchAgent on macOS, XDG autostart on Linux). Register autostart in the installed app; add a tray menu toggle **"Start at login"** reflecting the plugin's `is_enabled()`.

**Acceptance:** with autostart enabled, the Governor launches after a login / reboot.

### Phase 6 — Build + verify

- CC: `cargo build --release` and `cargo test` green; one PR, per-phase commits, DCO sign-off (`-s`).
- **Operator smoke** (handed back to Kenneth): run the Governor → tray icon appears, pip green → trigger an approval gate → notification appears, click opens Decide → **Restart Daemon** → daemon bounces, pip recovers → **Upgrade Daemon** → daemon upgrades or rolls back cleanly. `pm2 list` stays empty and exactly one `node` serves 7777 throughout.

---

## Deferred (NOT in this BOM)

- **Automatic / scheduled** upgrade ("realtime upgrades", task #34) — this BOM delivers the *manual* operator-triggered upgrade; an auto-check layer can sit on top later.
- The family-mode-phase-2 "Governor surface" first-run wizard — separate, larger scope.
- Reconciling the two deployment models (OS-service-runs-`dist/cli.js` vs SEA-sidecar) — architectural, separate cycle.

## Don't-touch

- The daemon (`src/`), the WinSW / systemd / launchd templates and install/uninstall scripts in `bin/`, `ecosystem.config.cjs`.
- **In scope:** the Governor app (`governor/`), and **adding** `bin/upgrade-daemon.ps1` + `bin/upgrade-daemon.sh`.

## Run prompt for CC

```
Read CLAUDE.md, then proposed/governor-observe-only-bom.md. Execute the
6-phase refactor: turn the Tauri Governor into the operator's single
companion for the daemon — desupervised (no auto-restart loop, coexists
with the OS-native StavrDaemon service), a tray pip showing /healthz +
OS-service status, native approval notifications, operator-triggered
Restart Daemon and Upgrade Daemon, and login auto-start.

Branch feat/governor-observe-only off main. One PR, per-phase commits,
DCO sign-off (-s). Sensitivity routine — standard autonomous flow, one
delta report at completion.

Skarp och hangslen: git status --short + git symbolic-ref HEAD before every
mutating git op.

Phase 1 is critical — after it the Governor must be incapable of restarting
the daemon on its own; delete restart.rs outright. Tests are derivative
(CLAUDE.md #1): rewrite the supervision tests in the same commit.

The Phase 4 upgrade script MUST honor the rollback contract — a failed
upgrade always leaves the daemon running the pre-upgrade commit.

Do NOT run Restart/Upgrade/approval flows against the live daemon — that
smoke is the operator's (Phase 6). Go.
```

---

## End of BOM
