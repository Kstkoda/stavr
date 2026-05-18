//! stavR Governor entry point.
//!
//! P1 scope: launch the Tauri runtime headless (no main window) and attach
//! the Raido-rune tray icon with a Quit menu item. Supervision + state
//! machine are wired in P2; state-driven icon swapping in P3.

// On Windows, hide the console window in release builds. Stay attached in
// debug so we can `println!` while iterating.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use stavr_governor::icons::{self, IconVariant};
use stavr_governor::port_check::SystemPortChecker;
use stavr_governor::restart::{OrphanAwareRestarter, Pm2Restarter, Restarter, SystemKiller};
use stavr_governor::supervisor::{
    Clock, HealthProbe, HttpProbe, Supervisor, SystemClock, DEFAULT_HEALTH_URL,
};
use tauri::Manager;

mod tray;

/// How often the tray watcher re-renders the icon. Acceptance criterion
/// from BOM P3 is "icon reflects state within 1s of state change"; 500 ms
/// gives a comfortable margin and a clean 2 Hz pulse for the animated
/// states (Restarting, GiveUp).
const TRAY_TICK: Duration = Duration::from_millis(500);

/// Resolve the path to `ecosystem.config.cjs`. Override via
/// `STAVR_ECOSYSTEM_PATH` env var (P6 installer wiring); fall back to the
/// current working directory so `cargo run` from the repo root works for
/// dev. The supervisor doesn't require the file to exist at startup — PM2
/// just fails the restart call if it's missing, which we surface as a
/// `RestartError`.
fn resolve_ecosystem_path() -> PathBuf {
    if let Ok(p) = std::env::var("STAVR_ECOSYSTEM_PATH") {
        return PathBuf::from(p);
    }
    std::env::current_dir()
        .map(|d| d.join("ecosystem.config.cjs"))
        .unwrap_or_else(|_| PathBuf::from("ecosystem.config.cjs"))
}

fn main() {
    // env_logger reads RUST_LOG; default to info so the operator sees state
    // transitions during the supervision loop without enabling verbose Tauri
    // internals.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Sanity-check the embedded icons up front. If gen_icons.py was skipped
    // during a build, this catches it before we hand garbage to the OS tray.
    for &v in icons::IconVariant::all() {
        debug_assert!(icons::is_valid_png(v.bytes_32()), "icon {v:?} bytes invalid");
    }

    let health_url = std::env::var("STAVR_HEALTH_URL")
        .unwrap_or_else(|_| DEFAULT_HEALTH_URL.to_string());
    let ecosystem_path = resolve_ecosystem_path();
    log::info!(
        "supervisor will probe {health_url}; restart via pm2 + {}",
        ecosystem_path.display()
    );

    let probe: Arc<dyn HealthProbe> = Arc::new(HttpProbe::new(health_url));
    // Wrap the raw PM2 restarter with the orphan-aware flow so Windows
    // restart cycles can recover from PM2's "daemon already running"
    // failure mode (v0.6.5 PR #34 amendment P2 — orphan Node holding
    // port 7777 after PM2's SIGTERM didn't actually terminate it).
    let base_restarter: Arc<dyn Restarter> = Arc::new(Pm2Restarter::new(ecosystem_path));
    let restarter: Arc<dyn Restarter> = Arc::new(OrphanAwareRestarter::new(
        base_restarter,
        Arc::new(SystemPortChecker),
        Arc::new(SystemKiller),
    ));
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let supervisor = Arc::new(Supervisor::new(probe, restarter, clock));

    // Spawn the supervisor on its own thread. CLAUDE.md hard rule #10:
    // anything that can stall lives off the main path. The Tauri event loop
    // owns the main thread; supervision is a sibling.
    let sup_for_thread = supervisor.clone();
    std::thread::Builder::new()
        .name("supervisor".to_string())
        .spawn(move || sup_for_thread.run_forever())
        .expect("spawn supervisor thread");

    tauri::Builder::default()
        .setup(move |app| {
            // Hand the supervisor to Tauri's managed state so the tray
            // menu's "Reset & Restart" / "Pause" handlers (in
            // `tray::handle_menu_event`) can fetch it via
            // `app.state::<Arc<Supervisor>>()` at click time. The handler
            // is decoupled from the supervisor reference at build() time
            // so we can keep `tray::build` generic over Runtime.
            app.manage(supervisor.clone());
            let _tray = tray::build(app.handle())?;
            log::info!("stavR Governor started; tray icon attached");

            // Tray watcher: snapshot supervisor state every TRAY_TICK and
            // push it onto the tray (icon + tooltip). The watcher runs on
            // its own thread so the Tauri event loop isn't blocked by PNG
            // decode or set_icon calls, and the state Mutex is held only
            // long enough to copy a few primitives into a StateSnapshot.
            let watcher_app = app.handle().clone();
            let watcher_state = supervisor.state();
            std::thread::Builder::new()
                .name("tray-watcher".to_string())
                .spawn(move || {
                    let mut prev_state = None;
                    let mut pulse_phase = false;
                    loop {
                        let snapshot = {
                            let sm = watcher_state.lock();
                            tray::StateSnapshot::from(&sm, Instant::now())
                        };
                        let pulses = IconVariant::state_pulses(snapshot.state);
                        let state_changed = Some(snapshot.state) != prev_state;
                        // Skip redundant re-renders: only call set_icon if
                        // the state changed OR we're in a pulsing state
                        // (where pulse_phase needs to flip frame).
                        if state_changed || pulses {
                            if let Err(e) =
                                tray::apply_state(&watcher_app, &snapshot, pulse_phase)
                            {
                                log::warn!("tray watcher: apply_state failed: {e}");
                            }
                        }
                        if pulses {
                            pulse_phase = !pulse_phase;
                        } else {
                            // Reset phase on entry to a non-pulsing state so
                            // the next pulse cycle starts at a defined frame.
                            pulse_phase = false;
                        }
                        prev_state = Some(snapshot.state);
                        std::thread::sleep(TRAY_TICK);
                    }
                })
                .expect("spawn tray watcher thread");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running stavR Governor");
}
