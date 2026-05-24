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
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, Runtime,
};

use stavr_governor::actions::{self, MuteWindow};
use stavr_governor::event_router::EventRouter;
use stavr_governor::icons::{decode_png_rgba, IconVariant};
use stavr_governor::service::ServiceStatus;
use stavr_governor::state::{DaemonState, StateMachine};

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

/// Build the Governor tray icon and attach it to the running Tauri app.
///
/// Returns the live `TrayIcon` so callers can update its image and tooltip
/// as the daemon's state changes. This function is the SINGLE registration
/// site — never build another `TrayIconBuilder` after startup; runtime
/// updates go through `apply_state` which resolves the live instance via
/// `app.tray_by_id(TRAY_ID)`.
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
        _ => {}
    }
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

/// Build the Phase-1 tray menu.
///
/// ```text
/// Open Dashboard
/// View Logs
/// View Decide Queue
/// ───────────────
/// Mute notifications · 1 h
/// Mute notifications · 1 d
/// Unmute
/// ───────────────
/// Quit Governor
/// ```
///
/// Daemon-control items (Restart Daemon, Pause supervision) were removed in
/// the Phase 1 desupervision and are reintroduced in Phase 4 as
/// service-aware operator actions.
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
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit Governor", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open_dashboard,
            &view_logs,
            &view_decide,
            &sep1,
            &mute_1h,
            &mute_1d,
            &unmute,
            &sep2,
            &quit,
        ],
    )
}

/// The canonical set of menu-item ids the tray exposes. Used by tests to
/// pin down the menu contract.
pub fn menu_ids() -> &'static [&'static str] {
    &[
        MENU_ID_OPEN_DASHBOARD,
        MENU_ID_VIEW_LOGS,
        MENU_ID_VIEW_DECIDE,
        MENU_ID_MUTE_1H,
        MENU_ID_MUTE_1D,
        MENU_ID_UNMUTE,
        MENU_ID_QUIT,
    ]
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
/// thread spawned in `main.rs`.
pub fn apply_state<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &StateSnapshot,
    _pulse_phase: bool,
) -> tauri::Result<()> {
    // Pip color is the combined verdict (service status first, /healthz
    // second). Pulse phase is no longer used — the OS-native service is
    // the supervisor, so transient "restarting" pulse states aren't
    // observable from the Governor.
    let variant = pip_icon(pip_color(snapshot.service, snapshot.state));
    let icon = load_icon(variant)?;
    let tooltip = format_tooltip(
        snapshot.state,
        snapshot.service,
        snapshot.uptime,
        snapshot.since_last_probe,
        snapshot.settle_seconds_in,
    );
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

    /// Menu contract after Phase 1 desupervision: 7 ids; Restart Daemon and
    /// Pause supervision are gone (returning in Phase 4). The remaining
    /// surface is the observation + notification controls.
    #[test]
    fn menu_ids_expose_phase_one_surface() {
        let ids = menu_ids();
        assert_eq!(ids.len(), 7, "expected 7 menu ids after Phase 1, got {ids:?}");
        for required in [
            MENU_ID_OPEN_DASHBOARD,
            MENU_ID_VIEW_LOGS,
            MENU_ID_VIEW_DECIDE,
            MENU_ID_MUTE_1H,
            MENU_ID_MUTE_1D,
            MENU_ID_UNMUTE,
            MENU_ID_QUIT,
        ] {
            assert!(ids.contains(&required), "menu_ids missing {required}");
        }
    }

    #[test]
    fn menu_ids_are_unique() {
        let mut ids: Vec<&str> = menu_ids().to_vec();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "menu ids must be unique");
    }

    /// Phase 1 desupervision: the tray must not reference daemon-control
    /// menu ids. Anchor checks so a partial revert can't sneak them back.
    #[test]
    fn tray_does_not_reference_restart_or_pause_ids() {
        let source = include_str!("tray.rs");
        let prod = source
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs should have a non-test prelude");
        for forbidden in [
            "MENU_ID_RESET_RESTART",
            "MENU_ID_PAUSE",
            "force_restart",
            "Supervisor",
            "reset_restart",
            "\"pause\"",
        ] {
            assert!(
                !prod.contains(forbidden),
                "tray.rs prod code must not mention {forbidden:?} after Phase 1 desupervision"
            );
        }
    }
}
