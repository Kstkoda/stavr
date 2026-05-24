//! Tauri 2 tray-icon wiring.
//!
//! Phase 1 of the operator-companion refactor
//! (`proposed/governor-observe-only-bom.md`): the operator-triggered
//! daemon-control items ("Restart Daemon", "Pause supervision") have been
//! temporarily removed — they're re-introduced in Phase 4 as service-aware
//! actions. Open Dashboard / View Logs / View Decide Queue / Mute · 1h /
//! Mute · 1d / Unmute / Quit Governor remain.
//!
//! Single-tray-instance invariant (carried over from the v0.6.5 P1 fix):
//! `tauri.conf.json` must NOT declare `app.trayIcon` — `build()` here is the
//! single source of truth; runtime updates go through `app.tray_by_id(TRAY_ID)`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, Runtime,
};
use tauri_plugin_autostart::ManagerExt;

use parking_lot::Mutex as PlMutex;
use stavr_governor::actions::{self, MuteWindow};
use stavr_governor::event_router::{Severity, ToastRenderer, ToastSpec};
use stavr_governor::event_router::EventRouter;
use stavr_governor::icons::{decode_png_rgba, IconVariant};
use stavr_governor::notification::TauriToastRenderer;
use stavr_governor::service::{
    self, ServiceController, ServiceStatus, SystemServiceController,
};
use stavr_governor::state::{DaemonState, StateMachine};

/// Banner-style tooltip override shared with the tray watcher. When set,
/// the watcher uses the override string instead of the computed
/// state-+-service tooltip — used by long-running operator actions
/// ("upgrading…") so the operator sees the action is in flight rather
/// than the stale steady-state tooltip.
#[derive(Debug, Default)]
pub struct TrayOverride {
    tooltip: PlMutex<Option<String>>,
}

impl TrayOverride {
    pub fn new() -> Self {
        Self {
            tooltip: PlMutex::new(None),
        }
    }
    pub fn set(&self, msg: impl Into<String>) {
        *self.tooltip.lock() = Some(msg.into());
    }
    pub fn clear(&self) {
        *self.tooltip.lock() = None;
    }
    pub fn current(&self) -> Option<String> {
        self.tooltip.lock().clone()
    }
}

/// Canonical id of the one-and-only Governor tray icon. All runtime updates
/// MUST resolve the live tray via `app.tray_by_id(TRAY_ID)` — never build a
/// second `TrayIconBuilder` after startup.
pub const TRAY_ID: &str = "main";

/// Menu item ids — wire-level strings the click handler hangs off.
pub const MENU_ID_QUIT: &str = "quit";
pub const MENU_ID_OPEN_DASHBOARD: &str = "open_dashboard";
pub const MENU_ID_VIEW_LOGS: &str = "view_logs";
pub const MENU_ID_VIEW_DECIDE: &str = "view_decide";
pub const MENU_ID_MUTE_1H: &str = "mute_1h";
pub const MENU_ID_MUTE_1D: &str = "mute_1d";
pub const MENU_ID_UNMUTE: &str = "unmute";
/// Phase 4 — operator-triggered control surface.
pub const MENU_ID_RESTART_DAEMON: &str = "restart_daemon";
pub const MENU_ID_UPGRADE_DAEMON: &str = "upgrade_daemon";
/// Phase 5 — login auto-start toggle.
pub const MENU_ID_AUTOSTART: &str = "autostart";

/// Build the Governor tray icon and attach it to the running Tauri app.
///
/// Returns the live `TrayIcon` so callers can update its image and tooltip
/// as the daemon's state changes. This function is the SINGLE registration
/// site — never build another `TrayIconBuilder` after startup; runtime
/// updates go through `apply_state` which resolves the live instance via
/// `app.tray_by_id(TRAY_ID)`.
///
/// Cluster C (audit #6): the `Menu<R>` is also managed so
/// `toggle_autostart` can look up the live `CheckMenuItem` and call
/// `set_checked` after the operator flips "Start at login" — the
/// visible check mark stays in sync without a relaunch.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let menu = build_menu(app)?;
    let icon = load_icon(IconVariant::Brand)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("stavR · starting…")
        .on_menu_event(handle_menu_event::<R>)
        .build(app)?;
    // Stash the menu so per-item mutators (autostart toggle, future
    // disabled-state flips) can resolve the live items by id.
    app.manage(menu);
    Ok(tray)
}

/// Tauri menu-event dispatcher. The EventRouter handle is fetched from
/// Tauri's managed state — main.rs `app.manage()` makes it available here.
pub fn handle_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    match event.id.as_ref() {
        MENU_ID_QUIT => {
            // Quitting Governor does NOT stop the daemon — the OS-native
            // StavrDaemon service keeps it alive; the operator just loses
            // the status surface until they relaunch Governor.
            app.exit(0);
        }
        MENU_ID_OPEN_DASHBOARD => {
            actions::open_dashboard(app, "/dashboard/helm");
        }
        MENU_ID_VIEW_LOGS => {
            actions::open_logs(app);
        }
        MENU_ID_VIEW_DECIDE => {
            actions::open_dashboard(app, "/dashboard/decide");
        }
        MENU_ID_MUTE_1H => {
            apply_mute(app, MuteWindow::OneHour);
        }
        MENU_ID_MUTE_1D => {
            apply_mute(app, MuteWindow::OneDay);
        }
        MENU_ID_UNMUTE => {
            if let Some(router) = app.try_state::<Arc<EventRouter>>() {
                router.unmute();
                log::info!("tray: unmuted (operator)");
            } else {
                log::warn!(
                    "tray: Unmute clicked but EventRouter not in Tauri state — was app.manage() called in main.rs?"
                );
            }
        }
        MENU_ID_RESTART_DAEMON => trigger_restart(app),
        MENU_ID_UPGRADE_DAEMON => trigger_upgrade(app),
        MENU_ID_AUTOSTART => toggle_autostart(app),
        _ => {}
    }
}

/// Operator toggled "Start at login". Flips the autostart plugin state
/// AND mutates the live `CheckMenuItem`'s check mark via the managed
/// `Menu<R>` handle (Cluster C / audit #6) — the visible state stays
/// honest without a Governor relaunch.
fn toggle_autostart<R: Runtime>(app: &AppHandle<R>) {
    let manager = app.autolaunch();
    let currently = manager.is_enabled().unwrap_or(false);
    let result = if currently {
        manager.disable()
    } else {
        manager.enable()
    };
    match result {
        Ok(()) => {
            let now = !currently;
            log::info!("tray: autostart toggled → {}", now);
            // Refresh the visible check mark by reaching into the
            // managed Menu<R>. Failures here are non-fatal — the
            // functional toggle already succeeded.
            if let Some(menu) = app.try_state::<Menu<R>>() {
                if let Some(item) = menu.get(MENU_ID_AUTOSTART) {
                    if let Some(check) = item.as_check_menuitem() {
                        if let Err(e) = check.set_checked(now) {
                            log::warn!(
                                "tray: set_checked on autostart item failed: {e}"
                            );
                        }
                    } else {
                        log::warn!(
                            "tray: autostart menu item is not a CheckMenuItem — was build_menu changed?"
                        );
                    }
                } else {
                    log::warn!(
                        "tray: no menu item with id {:?} — was build_menu changed?",
                        MENU_ID_AUTOSTART
                    );
                }
            } else {
                log::warn!(
                    "tray: Menu<R> not in Tauri state — was app.manage(menu) called in build()?"
                );
            }
        }
        Err(e) => log::warn!("tray: autostart toggle failed (was {currently}): {e}"),
    }
}

/// Operator clicked "Restart Daemon" — delegate to the OS init system.
/// Runs on a dedicated thread so the UAC / sudo prompt doesn't freeze
/// the Tauri event loop. On completion, fires an OS toast carrying the
/// outcome (Phase 4 BOM acceptance — parity with the upgrade flow).
fn trigger_restart<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("operator-restart".to_string())
        .spawn(move || {
            let controller = SystemServiceController::default();
            log::info!(
                "tray: operator triggered Restart Daemon → {:?}",
                controller.name
            );
            match controller.restart() {
                Ok(()) => {
                    log::info!("tray: Restart Daemon dispatched ok");
                    show_action_toast(
                        &app,
                        Severity::Info,
                        "stavR — restart dispatched",
                        "OS service restart issued. Pip will recover when /healthz comes back.",
                    );
                }
                Err(e) => {
                    log::warn!("tray: Restart Daemon failed: {e}");
                    show_action_toast(
                        &app,
                        Severity::Crit,
                        "stavR — restart failed",
                        &format!("{e}"),
                    );
                }
            }
        })
        .expect("spawn operator-restart thread");
}

/// Operator clicked "Upgrade Daemon" — invoke the hardened upgrade
/// script. Long-running; spawned on its own thread so the tray stays
/// responsive. The script enforces the rollback contract: on any failure
/// the daemon ends up on the pre-upgrade commit with the service
/// restarted.
///
/// Phase 4 BOM acceptance:
///   - shows "upgrading…" in the tray tooltip while the script runs
///     (via the shared `TrayOverride`)
///   - reports the outcome via an OS toast (`Severity::Info` on success,
///     `Severity::Crit` on failure with the exit code in the body so
///     the operator knows whether rollback succeeded — exit 2 = rollback
///     ok, exit 3 = rollback also failed and operator must intervene).
fn trigger_upgrade<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("operator-upgrade".to_string())
        .spawn(move || {
            if let Some(ov) = app.try_state::<Arc<TrayOverride>>() {
                ov.set("stavR · upgrading…");
            }
            let script = service::resolve_upgrade_script();
            log::info!(
                "tray: operator triggered Upgrade Daemon → {}",
                script.display()
            );
            let (title, severity, body) = match service::spawn_upgrade(&script) {
                Ok(mut child) => match child.wait() {
                    Ok(status) if status.success() => {
                        log::info!("tray: Upgrade Daemon completed ok");
                        (
                            "stavR — upgrade complete",
                            Severity::Info,
                            "Daemon now on the latest commit.".to_string(),
                        )
                    }
                    Ok(status) => {
                        let code = status.code().unwrap_or(-1);
                        log::warn!(
                            "tray: Upgrade Daemon exited with status {code}"
                        );
                        let detail = match code {
                            2 => "Upgrade failed; rollback ok — daemon is back on the pre-upgrade commit.",
                            3 => "Upgrade AND rollback failed — operator intervention required.",
                            4 => "Could not capture pre-upgrade commit; nothing was attempted.",
                            _ => "See operator log for details.",
                        };
                        (
                            "stavR — upgrade failed",
                            Severity::Crit,
                            format!("exit {code} · {detail}"),
                        )
                    }
                    Err(e) => {
                        log::warn!("tray: Upgrade Daemon wait failed: {e}");
                        (
                            "stavR — upgrade failed",
                            Severity::Crit,
                            format!("wait failed: {e}"),
                        )
                    }
                },
                Err(e) => {
                    log::warn!("tray: Upgrade Daemon spawn failed: {e}");
                    (
                        "stavR — upgrade failed",
                        Severity::Crit,
                        format!("spawn failed: {e}"),
                    )
                }
            };
            if let Some(ov) = app.try_state::<Arc<TrayOverride>>() {
                ov.clear();
            }
            show_action_toast(&app, severity, title, &body);
        })
        .expect("spawn operator-upgrade thread");
}

/// Fire a one-shot OS notification for an operator-triggered action.
/// Bypasses the `EventRouter` (no mute, no per-kind debounce) — the
/// operator clicked, the operator gets the outcome.
fn show_action_toast<R: Runtime>(
    app: &AppHandle<R>,
    severity: Severity,
    title: &str,
    body: &str,
) {
    let spec = ToastSpec {
        kind: "operator-action".to_string(),
        title: title.to_string(),
        body: body.to_string(),
        severity,
    };
    TauriToastRenderer::new(app.clone()).render(&spec);
}

fn apply_mute<R: Runtime>(app: &AppHandle<R>, window: MuteWindow) {
    if let Some(router) = app.try_state::<Arc<EventRouter>>() {
        let until = Instant::now() + window.as_duration();
        router.mute_until(until);
        log::info!("tray: muted via window {:?} (operator)", window);
    } else {
        log::warn!(
            "tray: {:?} clicked but EventRouter not in Tauri state — was app.manage() called in main.rs?",
            window
        );
    }
}

/// Build the Phase-5 tray menu.
///
/// ```text
/// Open Dashboard
/// View Logs
/// View Decide Queue
/// ───────────────
/// Restart Daemon            (operator-triggered, never autonomous)
/// Upgrade Daemon            (invokes bin/upgrade-daemon.* with rollback)
/// ───────────────
/// Mute notifications · 1 h
/// Mute notifications · 1 d
/// Unmute
/// ───────────────
/// ☑ Start at login          (CheckMenuItem; live-updates on toggle)
/// ───────────────
/// Quit Governor
/// ```
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open_dashboard = MenuItem::with_id(
        app,
        MENU_ID_OPEN_DASHBOARD,
        "Open Dashboard",
        true,
        None::<&str>,
    )?;
    let view_logs = MenuItem::with_id(app, MENU_ID_VIEW_LOGS, "View Logs", true, None::<&str>)?;
    let view_decide = MenuItem::with_id(
        app,
        MENU_ID_VIEW_DECIDE,
        "View Decide Queue",
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let restart_daemon = MenuItem::with_id(
        app,
        MENU_ID_RESTART_DAEMON,
        "Restart Daemon",
        true,
        None::<&str>,
    )?;
    let upgrade_daemon = MenuItem::with_id(
        app,
        MENU_ID_UPGRADE_DAEMON,
        "Upgrade Daemon",
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let mute_1h = MenuItem::with_id(
        app,
        MENU_ID_MUTE_1H,
        MuteWindow::OneHour.label(),
        true,
        None::<&str>,
    )?;
    let mute_1d = MenuItem::with_id(
        app,
        MENU_ID_MUTE_1D,
        MuteWindow::OneDay.label(),
        true,
        None::<&str>,
    )?;
    let unmute = MenuItem::with_id(app, MENU_ID_UNMUTE, "Unmute", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    // Phase 5: "Start at login" toggle. Initial check state reflects
    // what the autostart plugin reports — a fresh install on Windows
    // typically returns false; the installer enables it post-bundling.
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        MENU_ID_AUTOSTART,
        "Start at login",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit Governor", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open_dashboard,
            &view_logs,
            &view_decide,
            &sep1,
            &restart_daemon,
            &upgrade_daemon,
            &sep2,
            &mute_1h,
            &mute_1d,
            &unmute,
            &sep3,
            &autostart,
            &sep4,
            &quit,
        ],
    )
}

/// Decode an `IconVariant`'s 32px PNG into a Tauri `Image`.
pub fn load_icon(variant: IconVariant) -> tauri::Result<Image<'static>> {
    let rgba = decode_png_rgba(variant.bytes_32())
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("icon decode failed: {e}")))?;
    Ok(Image::new_owned(rgba.pixels, rgba.width, rgba.height))
}

/// Human-readable label for a `DaemonState` — used in tooltips.
pub fn human_label(state: DaemonState) -> &'static str {
    match state {
        DaemonState::Unknown => "starting…",
        DaemonState::Healthy => "Healthy",
        DaemonState::Degraded => "Degraded",
        DaemonState::Down => "Down",
        DaemonState::Restarting => "Restarting",
        DaemonState::StoppedManually => "Paused",
        DaemonState::GiveUp => "Operator needed",
    }
}

/// Short human-readable form of a `Duration`.
pub fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d {}h", secs / 86_400, (secs % 86_400) / 3600)
    }
}

/// Compose the tray tooltip text.
///   `stavR · {state} · {service-status} · uptime {duration} · last check {N}s ago`
pub fn format_tooltip(
    state: DaemonState,
    service: ServiceStatus,
    uptime: Option<Duration>,
    since_last_probe: Option<Duration>,
    settle_seconds_in: Option<u64>,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(6);
    parts.push("stavR".to_string());
    parts.push(human_label(state).to_string());
    parts.push(service.human_label().to_string());
    if let Some(up) = uptime {
        parts.push(format!("uptime {}", format_duration(up)));
    }
    if let Some(p) = since_last_probe {
        parts.push(format!("last check {}s ago", p.as_secs()));
    }
    if let Some(s) = settle_seconds_in {
        parts.push(format!("{s}s into settle window"));
    }
    parts.join(" · ")
}

/// Logical pip color for the tray icon. Service status takes precedence
/// over daemon state: a Stopped service is always red regardless of what
/// the (now-stale) /healthz probe says, a NotInstalled service is always
/// grey, and an Unknown service falls through to the /healthz verdict.
///
/// Mapping (BOM Phase 2):
///   Running + Ok                       → Green
///   Running + Degraded/Unknown         → Amber
///   Running + Down                     → Red
///   Stopped                            → Red
///   NotInstalled                       → Grey
///   Unknown   → defer to daemon state  (best-effort)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipColor {
    Green,
    Amber,
    Red,
    Grey,
}

pub fn pip_color(service: ServiceStatus, state: DaemonState) -> PipColor {
    match service {
        ServiceStatus::NotInstalled => PipColor::Grey,
        ServiceStatus::Stopped => PipColor::Red,
        ServiceStatus::Unknown => pip_color_from_state_only(state),
        ServiceStatus::Running => match state {
            DaemonState::Healthy => PipColor::Green,
            DaemonState::Degraded => PipColor::Amber,
            DaemonState::Down => PipColor::Red,
            // Unknown / Restarting → Amber (service is up, daemon is
            // still warming or transitional)
            _ => PipColor::Amber,
        },
    }
}

fn pip_color_from_state_only(state: DaemonState) -> PipColor {
    match state {
        DaemonState::Healthy => PipColor::Green,
        DaemonState::Degraded => PipColor::Amber,
        DaemonState::Down => PipColor::Red,
        DaemonState::StoppedManually | DaemonState::GiveUp => PipColor::Grey,
        DaemonState::Unknown | DaemonState::Restarting => PipColor::Amber,
    }
}

/// Map a PipColor to the icon variant used by Tauri's tray renderer. The
/// existing halo set covers all four colors directly; no new assets needed.
pub fn pip_icon(color: PipColor) -> IconVariant {
    match color {
        PipColor::Green => IconVariant::Healthy,
        PipColor::Amber => IconVariant::Degraded,
        PipColor::Red => IconVariant::Down,
        PipColor::Grey => IconVariant::StoppedManually,
    }
}

/// Read-only snapshot of the supervisor + service state, suitable for
/// passing across the lock boundary so the tray watcher doesn't hold the
/// state Mutex while it talks to Tauri.
#[derive(Debug, Clone)]
pub struct StateSnapshot {
    pub state: DaemonState,
    pub service: ServiceStatus,
    pub uptime: Option<Duration>,
    pub since_last_probe: Option<Duration>,
    pub settle_seconds_in: Option<u64>,
}

impl StateSnapshot {
    pub fn from(sm: &StateMachine, service: ServiceStatus, now: Instant) -> Self {
        Self {
            state: sm.state(),
            service,
            uptime: sm.uptime(now),
            since_last_probe: sm.last_probe().map(|t| now.saturating_duration_since(t)),
            settle_seconds_in: sm.settle_seconds_in(now),
        }
    }
}

/// Push current state into the tray icon + tooltip. Called by the watcher
/// thread spawned in `main.rs`. `tooltip_override`, when `Some`, replaces
/// the computed steady-state tooltip — used by long-running operator
/// actions (e.g. "stavR · upgrading…") so the operator sees the action
/// is in flight.
pub fn apply_state<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &StateSnapshot,
    tooltip_override: Option<&str>,
) -> tauri::Result<()> {
    // Pip color is the combined verdict (service status first, /healthz
    // second).
    let variant = pip_icon(pip_color(snapshot.service, snapshot.state));
    let icon = load_icon(variant)?;
    let tooltip = match tooltip_override {
        Some(s) => s.to_string(),
        None => format_tooltip(
            snapshot.state,
            snapshot.service,
            snapshot.uptime,
            snapshot.since_last_probe,
            snapshot.settle_seconds_in,
        ),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(icon))?;
        tray.set_tooltip(Some(&tooltip))?;
    } else {
        log::warn!(
            "tray::apply_state: no tray icon with id {:?} registered",
            TRAY_ID
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical set of menu-item ids the tray exposes. Lives inside
    /// the test module — pure test fixture; production code looks up
    /// items via `Menu::get(id)` against the managed `Menu<R>` (audit #9
    /// / Cluster F: keeps the warning-clean build without scattering
    /// `#[cfg(test)]` attributes mid-file, which would break the
    /// source-scanning anchor tests below that split on `#[cfg(test)]`).
    fn menu_ids() -> &'static [&'static str] {
        &[
            MENU_ID_OPEN_DASHBOARD,
            MENU_ID_VIEW_LOGS,
            MENU_ID_VIEW_DECIDE,
            MENU_ID_RESTART_DAEMON,
            MENU_ID_UPGRADE_DAEMON,
            MENU_ID_MUTE_1H,
            MENU_ID_MUTE_1D,
            MENU_ID_UNMUTE,
            MENU_ID_AUTOSTART,
            MENU_ID_QUIT,
        ]
    }

    #[test]
    fn human_label_covers_every_state() {
        let labels: Vec<&str> = [
            DaemonState::Unknown,
            DaemonState::Healthy,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Restarting,
            DaemonState::StoppedManually,
            DaemonState::GiveUp,
        ]
        .iter()
        .map(|&s| human_label(s))
        .collect();
        for l in &labels {
            assert!(!l.is_empty());
        }
        let mut sorted = labels.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), labels.len(), "labels collided: {labels:?}");
    }

    #[test]
    fn format_duration_scales_through_units() {
        assert_eq!(format_duration(Duration::from_secs(0)), "0s");
        assert_eq!(format_duration(Duration::from_secs(45)), "45s");
        assert_eq!(format_duration(Duration::from_secs(60)), "1m");
        assert_eq!(format_duration(Duration::from_secs(125)), "2m");
        assert_eq!(format_duration(Duration::from_secs(3600)), "1h 0m");
        assert_eq!(format_duration(Duration::from_secs(3600 + 600)), "1h 10m");
        assert_eq!(format_duration(Duration::from_secs(86_400 + 7200)), "1d 2h");
    }

    #[test]
    fn format_tooltip_handles_pre_probe_state() {
        let s = format_tooltip(DaemonState::Unknown, ServiceStatus::Unknown, None, None, None);
        assert_eq!(s, "stavR · starting… · service status unknown");
    }

    #[test]
    fn format_tooltip_includes_uptime_when_healthy() {
        let s = format_tooltip(
            DaemonState::Healthy,
            ServiceStatus::Running,
            Some(Duration::from_secs(900)),
            Some(Duration::from_secs(3)),
            None,
        );
        assert!(s.contains("Healthy"), "{s}");
        assert!(s.contains("service running"), "{s}");
        assert!(s.contains("uptime 15m"), "{s}");
        assert!(s.contains("last check 3s ago"), "{s}");
    }

    #[test]
    fn format_tooltip_omits_uptime_in_non_healthy_states() {
        let s = format_tooltip(
            DaemonState::Down,
            ServiceStatus::Stopped,
            None,
            Some(Duration::from_secs(12)),
            None,
        );
        assert!(s.contains("Down"), "{s}");
        assert!(s.contains("service stopped"), "{s}");
        assert!(!s.contains("uptime"), "{s}");
        assert!(s.contains("last check 12s ago"), "{s}");
    }

    /// Single-tray-instance invariant — carried over from the v0.6.5 P1 fix.
    /// `tauri.conf.json` must NOT declare `app.trayIcon` or our `build()` will
    /// produce a second tray icon next to the one Tauri auto-registers.
    #[test]
    fn tauri_config_does_not_declare_tray_icon_duplicate() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            !config.contains("\"trayIcon\""),
            "tauri.conf.json must not declare app.trayIcon"
        );
        assert!(
            !config.contains("\"id\": \"main\""),
            "tauri.conf.json still pins id 'main' — likely a stale tray declaration."
        );
    }

    /// `TRAY_ID` is the single source of truth — both `build()` and
    /// `apply_state()` must use the constant.
    #[test]
    fn tray_id_constant_is_used_by_build_and_apply_state() {
        assert_eq!(TRAY_ID, "main");
        let source = include_str!("tray.rs");
        let prod = source
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs should have a non-test prelude");
        assert!(prod.contains("TrayIconBuilder::with_id(TRAY_ID)"));
        assert!(prod.contains("app.tray_by_id(TRAY_ID)"));
        let builder_call_count = prod.matches("TrayIconBuilder::with_id(").count();
        assert_eq!(builder_call_count, 1);
    }

    /// Settle window seconds surface through to the tooltip.
    #[test]
    fn format_tooltip_includes_settle_window_seconds() {
        let s = format_tooltip(
            DaemonState::Unknown,
            ServiceStatus::Running,
            None,
            Some(Duration::from_secs(2)),
            Some(45),
        );
        assert!(s.contains("45s into settle window"), "{s}");
        assert!(s.contains("starting"), "{s}");
    }

    #[test]
    fn format_tooltip_omits_settle_phrase_when_window_closed() {
        let s = format_tooltip(
            DaemonState::Healthy,
            ServiceStatus::Running,
            Some(Duration::from_secs(100)),
            Some(Duration::from_secs(1)),
            None,
        );
        assert!(!s.contains("settle window"), "{s}");
    }

    #[test]
    fn state_snapshot_propagates_settle_seconds_in() {
        let now = Instant::now();
        let sm = StateMachine::new(now);
        let snap = StateSnapshot::from(&sm, ServiceStatus::Unknown, now + Duration::from_secs(10));
        assert_eq!(snap.settle_seconds_in, Some(10));
        assert_eq!(snap.service, ServiceStatus::Unknown);
    }

    // ---- Phase 2: pip color ---------------------------------------------

    /// Running service + Healthy daemon = green. The BOM Phase 2 green
    /// case — must be the only path that lights the green halo.
    #[test]
    fn pip_color_green_only_when_service_running_and_daemon_healthy() {
        assert_eq!(
            pip_color(ServiceStatus::Running, DaemonState::Healthy),
            PipColor::Green
        );
        // Stopped / NotInstalled NEVER produce green — only the running
        // service can light the green halo. (Unknown deliberately defers
        // to the daemon state so a missing `sc`/`systemctl`/`launchctl`
        // still gives the operator a useful pip; that's covered
        // separately in `pip_color_unknown_service_defers_to_daemon_state`.)
        for service in [ServiceStatus::Stopped, ServiceStatus::NotInstalled] {
            assert_ne!(
                pip_color(service, DaemonState::Healthy),
                PipColor::Green,
                "service={service:?}, state=Healthy"
            );
        }
        for state in [
            DaemonState::Unknown,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Restarting,
            DaemonState::StoppedManually,
            DaemonState::GiveUp,
        ] {
            assert_ne!(
                pip_color(ServiceStatus::Running, state),
                PipColor::Green,
                "service=Running, state={state:?}"
            );
        }
    }

    /// Stopped service always wins as red regardless of any (stale)
    /// /healthz verdict. This is the "Stop-Service StavrDaemon turns it
    /// red within a couple of ticks" acceptance case.
    #[test]
    fn pip_color_stopped_service_is_red_regardless_of_state() {
        for state in [
            DaemonState::Healthy,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Unknown,
        ] {
            assert_eq!(
                pip_color(ServiceStatus::Stopped, state),
                PipColor::Red,
                "service=Stopped, state={state:?}"
            );
        }
    }

    /// NotInstalled service → grey. Operator hasn't installed the OS
    /// service yet; the daemon is not under WinSW/systemd/launchd
    /// supervision and the Governor has nothing to observe.
    #[test]
    fn pip_color_not_installed_is_grey() {
        for state in [
            DaemonState::Healthy,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Unknown,
        ] {
            assert_eq!(
                pip_color(ServiceStatus::NotInstalled, state),
                PipColor::Grey,
                "service=NotInstalled, state={state:?}"
            );
        }
    }

    /// Running service + Degraded daemon = amber. The service is
    /// supervising fine but /healthz is sketchy.
    #[test]
    fn pip_color_running_plus_degraded_is_amber() {
        assert_eq!(
            pip_color(ServiceStatus::Running, DaemonState::Degraded),
            PipColor::Amber
        );
    }

    #[test]
    fn pip_color_running_plus_down_is_red() {
        assert_eq!(
            pip_color(ServiceStatus::Running, DaemonState::Down),
            PipColor::Red
        );
    }

    /// Service status query failed (sc/systemctl/launchctl missing) — fall
    /// back to the /healthz verdict so the tray still says something
    /// useful instead of always-grey.
    #[test]
    fn pip_color_unknown_service_defers_to_daemon_state() {
        assert_eq!(
            pip_color(ServiceStatus::Unknown, DaemonState::Healthy),
            PipColor::Green
        );
        assert_eq!(
            pip_color(ServiceStatus::Unknown, DaemonState::Down),
            PipColor::Red
        );
    }

    #[test]
    fn pip_icon_maps_colors_to_existing_halo_assets() {
        assert_eq!(pip_icon(PipColor::Green), IconVariant::Healthy);
        assert_eq!(pip_icon(PipColor::Amber), IconVariant::Degraded);
        assert_eq!(pip_icon(PipColor::Red), IconVariant::Down);
        assert_eq!(pip_icon(PipColor::Grey), IconVariant::StoppedManually);
    }

    /// Menu contract after Phase 5: 10 ids. Phase-4 surface plus the
    /// login-autostart toggle.
    #[test]
    fn menu_ids_expose_phase_five_surface() {
        let ids = menu_ids();
        assert_eq!(ids.len(), 10, "expected 10 menu ids after Phase 5, got {ids:?}");
        for required in [
            MENU_ID_OPEN_DASHBOARD,
            MENU_ID_VIEW_LOGS,
            MENU_ID_VIEW_DECIDE,
            MENU_ID_RESTART_DAEMON,
            MENU_ID_UPGRADE_DAEMON,
            MENU_ID_MUTE_1H,
            MENU_ID_MUTE_1D,
            MENU_ID_UNMUTE,
            MENU_ID_AUTOSTART,
            MENU_ID_QUIT,
        ] {
            assert!(ids.contains(&required), "menu_ids missing {required}");
        }
        // Wire-level strings are stable across refactors.
        assert_eq!(MENU_ID_RESTART_DAEMON, "restart_daemon");
        assert_eq!(MENU_ID_UPGRADE_DAEMON, "upgrade_daemon");
        assert_eq!(MENU_ID_AUTOSTART, "autostart");
    }

    #[test]
    fn menu_ids_are_unique() {
        let mut ids: Vec<&str> = menu_ids().to_vec();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "menu ids must be unique");
    }

    /// Cluster C (audit #6) — `build()` must manage the `Menu<R>` so
    /// `toggle_autostart` can look up the live `CheckMenuItem` and
    /// call `set_checked`. Anchor the wiring so a future refactor
    /// can't silently drop it and re-introduce the stale check-mark.
    #[test]
    fn build_manages_menu_for_runtime_mutation() {
        let src = include_str!("tray.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs non-test prelude");
        assert!(
            prod.contains("app.manage(menu)"),
            "build() must app.manage(menu) so toggle_autostart can resolve CheckMenuItem at click time"
        );
        assert!(
            prod.contains("app.try_state::<Menu<R>>()"),
            "toggle_autostart must resolve the managed Menu<R> at click time"
        );
        assert!(
            prod.contains("set_checked(now)"),
            "toggle_autostart must call set_checked() on the CheckMenuItem"
        );
    }

    /// Phase 4 cluster A — TrayOverride is the shared banner that
    /// long-running operator actions paint while in flight. set/clear
    /// round-trip through `current()`.
    #[test]
    fn tray_override_round_trips_set_and_clear() {
        let ov = TrayOverride::new();
        assert!(ov.current().is_none());
        ov.set("stavR · upgrading…");
        assert_eq!(ov.current().as_deref(), Some("stavR · upgrading…"));
        ov.clear();
        assert!(ov.current().is_none());
    }

    /// `apply_state` must prefer the tooltip override over the computed
    /// steady-state tooltip — that's the contract that lets the
    /// "upgrading…" banner survive across tray-watcher ticks while the
    /// pip color underneath stays accurate.
    #[test]
    fn apply_state_signature_threads_tooltip_override() {
        // The function takes `Option<&str>`. We can't easily call it
        // headless (no Tauri app), so anchor the signature by scanning
        // source — keeps a future refactor from regressing the
        // override-aware tooltip path.
        let src = include_str!("tray.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs non-test prelude");
        assert!(
            prod.contains("tooltip_override: Option<&str>"),
            "apply_state must accept Option<&str> tooltip_override (Phase 4 cluster A)"
        );
        assert!(
            prod.contains("match tooltip_override"),
            "apply_state must short-circuit to the override when Some(_)"
        );
    }

    /// Phase 1 + 4 invariants: the tray must NEVER reach into a
    /// supervision loop or rebuild the auto-restart graph. The
    /// operator-triggered Restart Daemon delegates to the OS init system
    /// via `SystemServiceController` — those names are allowed; the
    /// pre-refactor `Supervisor` / `force_restart` / `MENU_ID_PAUSE`
    /// scaffolding stays gone.
    #[test]
    fn tray_does_not_resurrect_legacy_supervisor_surface() {
        let source = include_str!("tray.rs");
        let prod = source
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs should have a non-test prelude");
        for forbidden in [
            "MENU_ID_RESET_RESTART",
            "MENU_ID_PAUSE",
            "force_restart",
            "::Supervisor",
            "reset_restart",
            "\"pause\"",
            "Pm2Restarter",
            "SidecarRestarter",
            "OrphanAwareRestarter",
        ] {
            assert!(
                !prod.contains(forbidden),
                "tray.rs prod code must not mention {forbidden:?} (legacy supervision)"
            );
        }
        // What we DO want present after Phase 4 — operator-triggered
        // service control. Anchor those so the file can't drift back to
        // a supervision-loop shape silently.
        assert!(
            prod.contains("SystemServiceController"),
            "tray.rs must wire SystemServiceController for the Restart Daemon menu item"
        );
        assert!(
            prod.contains("spawn_upgrade"),
            "tray.rs must invoke service::spawn_upgrade for the Upgrade Daemon menu item"
        );
    }
}
