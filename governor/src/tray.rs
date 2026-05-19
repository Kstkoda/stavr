//! Tauri 2 tray-icon wiring.
//!
//! Bug fix (v0.6.5 PR #34 amendment P1): the operator saw TWO tray icons in
//! Windows tray during the 2026-05-17 smoke test. Root cause: `tauri.conf.json`
//! declared an `app.trayIcon { id: "main" }` block AND `build()` here also
//! ran the tray builder with the same id. Tauri 2 ends up materialising both
//! registrations. Fix: removed the config-side declaration; this code path
//! is now the SINGLE source of tray instantiation and the singleton is
//! reached at runtime via `app.tray_by_id(TRAY_ID)`.

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
use stavr_governor::state::{DaemonState, StateMachine};
use stavr_governor::supervisor::Supervisor;

/// Canonical id of the one-and-only Governor tray icon. All runtime updates
/// MUST resolve the live tray via `app.tray_by_id(TRAY_ID)` — never build a
/// second `TrayIconBuilder` after startup.
pub const TRAY_ID: &str = "main";

/// Menu item id for the "Quit Governor" action.
pub const MENU_ID_QUIT: &str = "quit";

/// Menu item id for the "Reset & Restart" action (P3) — clears the GiveUp
/// counter and re-runs `restart_with_orphan_kill` on the daemon port.
pub const MENU_ID_RESET_RESTART: &str = "reset_restart";

/// Menu item id for the "Pause" action (operator transitions daemon to
/// `StoppedManually`). Future work (v0.6.5 PR #2) wires the click handler.
pub const MENU_ID_PAUSE: &str = "pause";

// --- P5 (v0.6.5 PR #2) — operator action menu items -------------------------

/// Menu item id for "Open Dashboard" — opens the dashboard helm page in
/// the OS-default browser.
pub const MENU_ID_OPEN_DASHBOARD: &str = "open_dashboard";

/// Menu item id for "View Logs" — opens the daemon's PM2 log in the
/// OS-default text-file handler.
pub const MENU_ID_VIEW_LOGS: &str = "view_logs";

/// Menu item id for "View Decide Queue" — opens /dashboard/decide.
pub const MENU_ID_VIEW_DECIDE: &str = "view_decide";

/// Menu item id for "Mute notifications · 1 h".
pub const MENU_ID_MUTE_1H: &str = "mute_1h";

/// Menu item id for "Mute notifications · 1 d".
pub const MENU_ID_MUTE_1D: &str = "mute_1d";

/// Menu item id for "Unmute notifications".
pub const MENU_ID_UNMUTE: &str = "unmute";

/// Build the Governor tray icon and attach it to the running Tauri app.
///
/// Returns the live `TrayIcon` so callers (P3 supervisor wiring) can update
/// its image and tooltip as `DaemonState` changes. This function is the
/// SINGLE registration site — never build another `TrayIconBuilder` after
/// startup; runtime updates go through `apply_state` which resolves the live
/// instance via `app.tray_by_id(TRAY_ID)`.
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

/// Tauri menu-event dispatcher. The Supervisor and EventRouter handles are
/// fetched from Tauri's managed state — main.rs `app.manage()` makes them
/// available here. Decoupling like this is what lets `build()` stay
/// generic over `Runtime`; the supervisor/router references are recovered
/// at click time.
pub fn handle_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    match event.id.as_ref() {
        MENU_ID_QUIT => {
            // Hard rule #4: quitting Governor does NOT stop the daemon.
            // PM2 keeps it alive; the operator just loses the supervision
            // + status surface until they relaunch Governor.
            app.exit(0);
        }
        MENU_ID_RESET_RESTART => {
            if let Some(sup) = app.try_state::<Arc<Supervisor>>() {
                match sup.force_restart() {
                    Ok(_) => log::info!("tray: force_restart invoked (operator)"),
                    Err(e) => log::warn!("tray: force_restart failed: {e}"),
                }
            } else {
                log::warn!(
                    "tray: Restart Daemon clicked but Supervisor not in Tauri state — was app.manage() called in main.rs?"
                );
            }
        }
        MENU_ID_PAUSE => {
            if let Some(sup) = app.try_state::<Arc<Supervisor>>() {
                sup.pause();
                log::info!("tray: pause invoked (operator)");
            }
        }
        // ----- P5 (v0.6.5 PR #2) — operator actions -----
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

/// Apply a mute window to the EventRouter (if registered). The router holds
/// its own clock so the "later of two ends wins" extension rule works even
/// across overlapping clicks.
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

/// Build the standard Governor tray menu. Operator-facing ordering (P5 BOM):
///
/// ```text
/// Open Dashboard
/// View Logs
/// View Decide Queue
/// ───────────────
/// Restart Daemon            (force_restart — also clears GiveUp counter)
/// Pause supervision         (StoppedManually until operator restarts)
/// ───────────────
/// Mute notifications · 1 h
/// Mute notifications · 1 d
/// Unmute
/// ───────────────
/// Quit Governor
/// ```
///
/// `MENU_ID_RESET_RESTART` keeps its id (for backwards-compat with the P3
/// menu-id contract tests) but is rendered as "Restart Daemon" — the P5 BOM
/// label. Its force_restart semantics still clear GiveUp.
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
    let restart = MenuItem::with_id(
        app,
        MENU_ID_RESET_RESTART,
        "Restart Daemon",
        true,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(app, MENU_ID_PAUSE, "Pause supervision", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let mute_1h = MenuItem::with_id(app, MENU_ID_MUTE_1H, MuteWindow::OneHour.label(), true, None::<&str>)?;
    let mute_1d = MenuItem::with_id(app, MENU_ID_MUTE_1D, MuteWindow::OneDay.label(), true, None::<&str>)?;
    let unmute = MenuItem::with_id(app, MENU_ID_UNMUTE, "Unmute", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit Governor", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open_dashboard,
            &view_logs,
            &view_decide,
            &sep1,
            &restart,
            &pause,
            &sep2,
            &mute_1h,
            &mute_1d,
            &unmute,
            &sep3,
            &quit,
        ],
    )
}

/// The canonical set of menu-item ids the tray exposes. Used by tests to
/// pin down the menu contract so a future refactor cannot silently drop
/// items — particularly "Restart Daemon" (the operator's only path out of
/// GiveUp) and the mute submenu (P5 operator-control surface).
pub fn menu_ids() -> &'static [&'static str] {
    &[
        MENU_ID_OPEN_DASHBOARD,
        MENU_ID_VIEW_LOGS,
        MENU_ID_VIEW_DECIDE,
        MENU_ID_RESET_RESTART,
        MENU_ID_PAUSE,
        MENU_ID_MUTE_1H,
        MENU_ID_MUTE_1D,
        MENU_ID_UNMUTE,
        MENU_ID_QUIT,
    ]
}

/// Decode an `IconVariant`'s 32px PNG into a Tauri `Image`. 32px is the
/// platform-portable middle ground — Windows tray rescales it down at low DPI
/// and macOS uses it directly at retina. The 16px variant is reserved for the
/// Linux fallback path we will wire up if/when the GTK status-icon mode is
/// needed (Wayland-only desktops don't expose tray at all; that's a P6 doc
/// note, not a code path).
///
/// Tauri 2's `Image` takes raw RGBA, not encoded PNG, so we decode through the
/// `png` crate at startup. The bytes are static, so decode cost is one-time.
pub fn load_icon(variant: IconVariant) -> tauri::Result<Image<'static>> {
    let rgba = decode_png_rgba(variant.bytes_32())
        .map_err(|e| tauri::Error::Anyhow(anyhow::anyhow!("icon decode failed: {e}")))?;
    Ok(Image::new_owned(rgba.pixels, rgba.width, rgba.height))
}

/// Human-readable label for a `DaemonState` — used in tooltips and (P5) the
/// menu header. Keeps presentation strings out of the `state` module so
/// state.rs stays pure.
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

/// Short human-readable form of a `Duration`. The tooltip is short and the
/// operator just needs orders-of-magnitude — `12s`, `4m`, `2h 13m`, `1d 3h`.
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

/// Suffix shown in the tooltip when the daemon is in `GiveUp`. Surfaces the
/// operator-action requirement directly in the tray hover so the operator
/// knows BOTH that intervention is needed AND how (right-click → menu) —
/// without a second tray icon.
pub const GIVEUP_HINT: &str = "needs operator action — right-click for Reset & Restart";

/// Compose the tray tooltip text. Format from BOM P3:
///   `stavR · {state} · uptime {duration} · last check {N}s ago`
/// Pieces are omitted gracefully — pre-probe there's no uptime; right after
/// startup there's no last-check yet. When `state == GiveUp` the tooltip
/// appends `GIVEUP_HINT` so the operator can act without needing a second
/// status overlay tray icon (v0.6.5 PR #34 amendment P1). When the
/// supervisor is inside its settle window after a fresh boot or restart,
/// the tooltip surfaces "Ns into settle window" so the operator can see
/// Governor is patiently waiting rather than flapping (P3).
pub fn format_tooltip(
    state: DaemonState,
    uptime: Option<Duration>,
    since_last_probe: Option<Duration>,
    settle_seconds_in: Option<u64>,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(6);
    parts.push("stavR".to_string());
    parts.push(human_label(state).to_string());
    if let Some(up) = uptime {
        parts.push(format!("uptime {}", format_duration(up)));
    }
    if let Some(p) = since_last_probe {
        parts.push(format!("last check {}s ago", p.as_secs()));
    }
    if let Some(s) = settle_seconds_in {
        parts.push(format!("{s}s into settle window"));
    }
    if state == DaemonState::GiveUp {
        parts.push(GIVEUP_HINT.to_string());
    }
    parts.join(" · ")
}

/// Read-only snapshot of the supervisor state, suitable for passing across
/// the lock boundary so the tray watcher doesn't hold the state Mutex while
/// it talks to Tauri.
#[derive(Debug, Clone)]
pub struct StateSnapshot {
    pub state: DaemonState,
    pub uptime: Option<Duration>,
    pub since_last_probe: Option<Duration>,
    /// Seconds into the settle window (post-fresh-boot or post-restart),
    /// or `None` if the window has closed / daemon has been Healthy since.
    pub settle_seconds_in: Option<u64>,
}

impl StateSnapshot {
    /// Capture the relevant fields from a `StateMachine` while holding its
    /// lock as briefly as possible.
    pub fn from(sm: &StateMachine, now: Instant) -> Self {
        Self {
            state: sm.state(),
            uptime: sm.uptime(now),
            since_last_probe: sm.last_probe().map(|t| now.saturating_duration_since(t)),
            settle_seconds_in: sm.settle_seconds_in(now),
        }
    }
}

/// Push current state into the tray icon + tooltip. Called by the watcher
/// thread spawned in `main.rs`. Returns Err if Tauri's tray lookup fails;
/// the watcher logs and continues so a transient failure doesn't kill the
/// status surface.
pub fn apply_state<R: Runtime>(
    app: &AppHandle<R>,
    snapshot: &StateSnapshot,
    pulse_phase: bool,
) -> tauri::Result<()> {
    let variant = IconVariant::for_state(snapshot.state, pulse_phase);
    let icon = load_icon(variant)?;
    let tooltip = format_tooltip(
        snapshot.state,
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
        // If a new DaemonState is added the match in human_label is
        // non-exhaustive at compile time, so this test just sanity-checks
        // that each label is non-empty and doesn't collide.
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
        assert_eq!(
            sorted.len(),
            labels.len(),
            "labels collided: {labels:?}"
        );
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
        // Before any probe completes there's no uptime and no last-check.
        let s = format_tooltip(DaemonState::Unknown, None, None, None);
        assert_eq!(s, "stavR · starting…");
    }

    #[test]
    fn format_tooltip_includes_uptime_when_healthy() {
        let s = format_tooltip(
            DaemonState::Healthy,
            Some(Duration::from_secs(900)),
            Some(Duration::from_secs(3)),
            None,
        );
        assert!(s.contains("Healthy"), "{s}");
        assert!(s.contains("uptime 15m"), "{s}");
        assert!(s.contains("last check 3s ago"), "{s}");
        // Separator integrity
        assert_eq!(s.matches(" · ").count(), 3);
    }

    #[test]
    fn format_tooltip_omits_uptime_in_non_healthy_states() {
        // sm.uptime() returns None unless Healthy, so the caller passes None.
        let s = format_tooltip(
            DaemonState::Down,
            None,
            Some(Duration::from_secs(12)),
            None,
        );
        assert!(s.contains("Down"), "{s}");
        assert!(!s.contains("uptime"), "{s}");
        assert!(s.contains("last check 12s ago"), "{s}");
    }

    #[test]
    fn giveup_label_signals_operator_intervention() {
        assert_eq!(human_label(DaemonState::GiveUp), "Operator needed");
        let s = format_tooltip(
            DaemonState::GiveUp,
            None,
            Some(Duration::from_secs(1)),
            None,
        );
        assert!(s.contains("Operator needed"));
    }

    // -- P1 (v0.6.5 PR #34 amendment) — single-tray-instance invariants ---

    /// `tauri.conf.json` MUST NOT declare an `app.trayIcon` block. Tauri 2
    /// will auto-register that block as a tray and our `tray::build()` will
    /// register another with the same id → two ᚱ icons in the Windows tray
    /// (the bug observed during the 2026-05-17 21:00 GST smoke test). The
    /// code path in `build()` is the SINGLE source of truth; the config file
    /// must stay tray-free.
    #[test]
    fn tauri_config_does_not_declare_tray_icon_duplicate() {
        let config = include_str!("../tauri.conf.json");
        assert!(
            !config.contains("\"trayIcon\""),
            "tauri.conf.json must not declare app.trayIcon — that would register a SECOND tray icon next to the one tray::build() creates. See P1 in v0.6.5 fix BOM."
        );
        // Belt-and-braces: also ensure the id "main" isn't bound from config.
        assert!(
            !config.contains("\"id\": \"main\""),
            "tauri.conf.json still pins id 'main' — likely a stale tray declaration."
        );
    }

    /// `TRAY_ID` is the single source of truth for the singleton tray's
    /// identifier. `build()` registers under it; `apply_state()` resolves it
    /// via `tray_by_id`. Both must use the constant — never a literal — so a
    /// future rename can't silently desync the two sites.
    #[test]
    fn tray_id_constant_is_used_by_build_and_apply_state() {
        assert_eq!(TRAY_ID, "main");
        let source = include_str!("tray.rs");
        // Drop the test module from the scan so test-fixture mentions of the
        // builder/lookup strings don't get counted as second registrations.
        let prod = source
            .split("#[cfg(test)]")
            .next()
            .expect("tray.rs should have a non-test prelude");
        assert!(
            prod.contains("TrayIconBuilder::with_id(TRAY_ID)"),
            "build() must register with the TRAY_ID constant (single source of truth)"
        );
        assert!(
            prod.contains("app.tray_by_id(TRAY_ID)"),
            "apply_state() must resolve the tray via TRAY_ID constant"
        );
        // Outside the test module there must be exactly ONE builder call.
        let builder_call_count = prod.matches("TrayIconBuilder::with_id(").count();
        assert_eq!(
            builder_call_count, 1,
            "exactly one TrayIconBuilder registration call expected in prod code; found {builder_call_count}"
        );
    }

    /// In `GiveUp` the operator must be told (a) that intervention is needed
    /// AND (b) how to act, via the tooltip on the SAME tray — not via a
    /// second "status overlay" tray icon. The hint references the
    /// Reset & Restart menu item.
    #[test]
    fn giveup_tooltip_includes_operator_action_hint() {
        let s = format_tooltip(
            DaemonState::GiveUp,
            None,
            Some(Duration::from_secs(2)),
            None,
        );
        assert!(
            s.contains(GIVEUP_HINT),
            "GiveUp tooltip should append the operator hint; got: {s}"
        );
        assert!(s.contains("right-click"), "{s}");
        assert!(s.contains("Reset & Restart"), "{s}");
    }

    /// The non-GiveUp states must NOT carry the operator hint — keeping the
    /// tooltip noise-free during normal operation. The hint is GiveUp-only.
    #[test]
    fn non_giveup_states_do_not_get_operator_hint() {
        for state in [
            DaemonState::Healthy,
            DaemonState::Degraded,
            DaemonState::Down,
            DaemonState::Restarting,
            DaemonState::StoppedManually,
            DaemonState::Unknown,
        ] {
            let s = format_tooltip(state, None, Some(Duration::from_secs(1)), None);
            assert!(
                !s.contains(GIVEUP_HINT),
                "tooltip for {state:?} must not carry GIVEUP_HINT; got: {s}"
            );
        }
    }

    // ---- P3: settle-window tooltip + StateSnapshot wiring ----------------

    /// During the settle window the tooltip MUST tell the operator
    /// "Governor is patiently waiting, not stuck." Format from the BOM:
    /// "Starting · 45s into settle window".
    #[test]
    fn format_tooltip_includes_settle_window_seconds() {
        let s = format_tooltip(DaemonState::Unknown, None, Some(Duration::from_secs(2)), Some(45));
        assert!(s.contains("45s into settle window"), "{s}");
        assert!(s.contains("starting"), "{s}");
    }

    /// `settle_seconds_in = None` (window closed) → no settle phrase.
    #[test]
    fn format_tooltip_omits_settle_phrase_when_window_closed() {
        let s = format_tooltip(DaemonState::Healthy, Some(Duration::from_secs(100)), Some(Duration::from_secs(1)), None);
        assert!(!s.contains("settle window"), "{s}");
    }

    /// `StateSnapshot::from` reads `settle_seconds_in` from the state
    /// machine — so the watcher thread propagates the new field without
    /// extra wiring at the call site.
    #[test]
    fn state_snapshot_propagates_settle_seconds_in() {
        let now = Instant::now();
        let sm = StateMachine::new(now);
        // 10 seconds into a 60-second settle window
        let snap = StateSnapshot::from(&sm, now + Duration::from_secs(10));
        assert_eq!(snap.settle_seconds_in, Some(10));
    }

    /// Menu contract (P5 expansion): the tray must offer the full operator-
    /// action surface — Open Dashboard / View Logs / View Decide Queue /
    /// Restart Daemon (operator's path out of GiveUp) / Pause / Mute 1h /
    /// Mute 1d / Unmute / Quit. These ids are wire-level strings hung off
    /// by the click handler in `handle_menu_event`.
    #[test]
    fn menu_ids_expose_full_operator_action_set() {
        let ids = menu_ids();
        // P3 → P5 expansion: 3 ids became 9. New tests pinning means a
        // future refactor cannot silently drop an action without breaking
        // this assertion.
        assert_eq!(ids.len(), 9, "expected 9 menu ids in P5, got {ids:?}");
        for required in [
            MENU_ID_OPEN_DASHBOARD,
            MENU_ID_VIEW_LOGS,
            MENU_ID_VIEW_DECIDE,
            MENU_ID_RESET_RESTART,
            MENU_ID_PAUSE,
            MENU_ID_MUTE_1H,
            MENU_ID_MUTE_1D,
            MENU_ID_UNMUTE,
            MENU_ID_QUIT,
        ] {
            assert!(ids.contains(&required), "menu_ids missing {required}");
        }
        // Ids stable as wire-level strings — main.rs / future scripting
        // hangs event handlers off them.
        assert_eq!(MENU_ID_OPEN_DASHBOARD, "open_dashboard");
        assert_eq!(MENU_ID_VIEW_LOGS, "view_logs");
        assert_eq!(MENU_ID_VIEW_DECIDE, "view_decide");
        assert_eq!(MENU_ID_RESET_RESTART, "reset_restart");
        assert_eq!(MENU_ID_PAUSE, "pause");
        assert_eq!(MENU_ID_MUTE_1H, "mute_1h");
        assert_eq!(MENU_ID_MUTE_1D, "mute_1d");
        assert_eq!(MENU_ID_UNMUTE, "unmute");
        assert_eq!(MENU_ID_QUIT, "quit");
    }

    /// P5 — no duplicate ids slipped in. Tauri menu builds happily with two
    /// items sharing an id, but the click handler can't disambiguate them.
    #[test]
    fn menu_ids_are_unique() {
        let mut ids: Vec<&str> = menu_ids().to_vec();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "menu ids must be unique; duplicates present");
    }
}
