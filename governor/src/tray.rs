//! Tauri 2 tray-icon wiring.
//!
//! Bug fix (v0.6.5 PR #34 amendment P1): the operator saw TWO tray icons in
//! Windows tray during the 2026-05-17 smoke test. Root cause: `tauri.conf.json`
//! declared an `app.trayIcon { id: "main" }` block AND `build()` here also
//! ran the tray builder with the same id. Tauri 2 ends up materialising both
//! registrations. Fix: removed the config-side declaration; this code path
//! is now the SINGLE source of tray instantiation and the singleton is
//! reached at runtime via `app.tray_by_id(TRAY_ID)`.

use std::time::{Duration, Instant};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Runtime,
};

use stavr_governor::icons::{decode_png_rgba, IconVariant};
use stavr_governor::state::{DaemonState, StateMachine};

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
        .on_menu_event(|app, event| {
            if event.id.as_ref() == MENU_ID_QUIT {
                // Hard rule #4: quitting the Governor does NOT stop the
                // daemon. PM2 keeps the daemon alive; the operator simply
                // loses the supervision + status surface until they relaunch
                // Governor.
                app.exit(0);
            }
            // MENU_ID_RESET_RESTART / MENU_ID_PAUSE click handlers are wired
            // by main.rs after `build()` returns (they need access to the
            // Supervisor handle, which `build()` does not hold). See
            // `tray::install_supervisor_menu_handler`.
        })
        .build(app)?;
    Ok(tray)
}

/// Build the standard Governor tray menu. The order is operator-facing
/// (most-used first): Reset & Restart → Pause → Quit. The "Reset & Restart"
/// item is always visible but its semantics are only meaningful from GiveUp
/// (where it clears the 5-in-5min counter and retries with orphan-kill).
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let reset_restart = MenuItem::with_id(
        app,
        MENU_ID_RESET_RESTART,
        "Reset & Restart",
        true,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(app, MENU_ID_PAUSE, "Pause supervision", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit Governor", true, None::<&str>)?;
    Menu::with_items(app, &[&reset_restart, &pause, &quit])
}

/// The canonical set of menu-item ids the tray exposes. Used by tests to
/// pin down the menu contract so a future refactor cannot silently drop
/// "Reset & Restart" (which is the operator's only path out of GiveUp).
pub fn menu_ids() -> &'static [&'static str] {
    &[MENU_ID_RESET_RESTART, MENU_ID_PAUSE, MENU_ID_QUIT]
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
/// status overlay tray icon (v0.6.5 PR #34 amendment P1).
pub fn format_tooltip(
    state: DaemonState,
    uptime: Option<Duration>,
    since_last_probe: Option<Duration>,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(5);
    parts.push("stavR".to_string());
    parts.push(human_label(state).to_string());
    if let Some(up) = uptime {
        parts.push(format!("uptime {}", format_duration(up)));
    }
    if let Some(p) = since_last_probe {
        parts.push(format!("last check {}s ago", p.as_secs()));
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
}

impl StateSnapshot {
    /// Capture the relevant fields from a `StateMachine` while holding its
    /// lock as briefly as possible.
    pub fn from(sm: &StateMachine, now: Instant) -> Self {
        Self {
            state: sm.state(),
            uptime: sm.uptime(now),
            since_last_probe: sm.last_probe().map(|t| now.saturating_duration_since(t)),
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
    let tooltip = format_tooltip(snapshot.state, snapshot.uptime, snapshot.since_last_probe);
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
        let s = format_tooltip(DaemonState::Unknown, None, None);
        assert_eq!(s, "stavR · starting…");
    }

    #[test]
    fn format_tooltip_includes_uptime_when_healthy() {
        let s = format_tooltip(
            DaemonState::Healthy,
            Some(Duration::from_secs(900)),
            Some(Duration::from_secs(3)),
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
        );
        assert!(s.contains("Down"), "{s}");
        assert!(!s.contains("uptime"), "{s}");
        assert!(s.contains("last check 12s ago"), "{s}");
    }

    #[test]
    fn giveup_label_signals_operator_intervention() {
        assert_eq!(human_label(DaemonState::GiveUp), "Operator needed");
        let s = format_tooltip(DaemonState::GiveUp, None, Some(Duration::from_secs(1)));
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
        let s = format_tooltip(DaemonState::GiveUp, None, Some(Duration::from_secs(2)));
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
            let s = format_tooltip(state, None, Some(Duration::from_secs(1)));
            assert!(
                !s.contains(GIVEUP_HINT),
                "tooltip for {state:?} must not carry GIVEUP_HINT; got: {s}"
            );
        }
    }

    /// Menu contract: the tray must offer Reset & Restart (so the operator
    /// can exit GiveUp), Pause, and Quit. These ids are referenced by P3's
    /// click handler wiring + by the operator's tray-menu mental model.
    #[test]
    fn menu_ids_expose_reset_restart_pause_and_quit() {
        let ids = menu_ids();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&MENU_ID_RESET_RESTART));
        assert!(ids.contains(&MENU_ID_PAUSE));
        assert!(ids.contains(&MENU_ID_QUIT));
        // Ids stable as wire-level strings — main.rs / future scripting hangs
        // event handlers off them.
        assert_eq!(MENU_ID_RESET_RESTART, "reset_restart");
        assert_eq!(MENU_ID_PAUSE, "pause");
        assert_eq!(MENU_ID_QUIT, "quit");
    }
}
