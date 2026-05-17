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

use stavr_governor::icons;
use stavr_governor::restart::Pm2Restarter;
use stavr_governor::supervisor::{
    Clock, HealthProbe, HttpProbe, Supervisor, SystemClock, DEFAULT_HEALTH_URL,
};

mod tray;

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
    let restarter = Arc::new(Pm2Restarter::new(ecosystem_path));
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
            let _tray = tray::build(app.handle())?;
            log::info!("stavR Governor started; tray icon attached");
            // P3 will wire the supervisor's state into the tray icon here.
            let _state_handle = supervisor.state();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running stavR Governor");
}
