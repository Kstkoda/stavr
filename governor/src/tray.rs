//! Tauri 2 tray-icon wiring.
//!
//! P1 scope: build the tray with the brand glyph and a single "Quit" menu
//! item. P3 adds state-driven icon + tooltip refresh via `apply_state`. The
//! full operator menu (open dashboard / pause / restart / mute) lands in P5
//! per the v0.6.5 BOM phase plan.

use std::time::{Duration, Instant};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Runtime,
};

use stavr_governor::icons::{decode_png_rgba, IconVariant};
use stavr_governor::state::{DaemonState, StateMachine};

/// Build the Governor tray icon and attach it to the running Tauri app.
///
/// Returns the live `TrayIcon` so callers (P3 supervisor wiring) can update
/// its image and tooltip as `DaemonState` changes.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let quit = MenuItem::with_id(app, "quit", "Quit Governor", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    let icon = load_icon(IconVariant::Brand)?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("stavR · starting…")
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                // Hard rule #4: quitting the Governor does NOT stop the
                // daemon. PM2 keeps the daemon alive; the operator simply
                // loses the supervision + status surface until they relaunch
                // Governor.
                app.exit(0);
            }
        })
        .build(app)?;
    Ok(tray)
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

/// Compose the tray tooltip text. Format from BOM P3:
///   `stavR · {state} · uptime {duration} · last check {N}s ago`
/// Pieces are omitted gracefully — pre-probe there's no uptime; right after
/// startup there's no last-check yet.
pub fn format_tooltip(
    state: DaemonState,
    uptime: Option<Duration>,
    since_last_probe: Option<Duration>,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(4);
    parts.push("stavR".to_string());
    parts.push(human_label(state).to_string());
    if let Some(up) = uptime {
        parts.push(format!("uptime {}", format_duration(up)));
    }
    if let Some(p) = since_last_probe {
        parts.push(format!("last check {}s ago", p.as_secs()));
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
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(icon))?;
        tray.set_tooltip(Some(&tooltip))?;
    } else {
        log::warn!("tray::apply_state: no tray icon with id 'main' registered");
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
}
