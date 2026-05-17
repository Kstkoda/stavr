//! stavR Governor entry point.
//!
//! P1 scope: launch the Tauri runtime headless (no main window) and attach
//! the Raido-rune tray icon with a Quit menu item. Supervision + state
//! machine are wired in P2; state-driven icon swapping in P3.

// On Windows, hide the console window in release builds. Stay attached in
// debug so we can `println!` while iterating.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use stavr_governor::icons;

mod tray;

fn main() {
    // env_logger reads RUST_LOG; default to info so the operator sees state
    // transitions during the supervision loop (P2) without enabling verbose
    // Tauri internals.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Sanity-check the embedded icons up front. If gen_icons.py was skipped
    // during a build, this catches it before we hand garbage to the OS tray.
    for &v in icons::IconVariant::all() {
        debug_assert!(icons::is_valid_png(v.bytes_32()), "icon {v:?} bytes invalid");
    }

    tauri::Builder::default()
        .setup(|app| {
            let _tray = tray::build(app.handle())?;
            log::info!("stavR Governor started; tray icon attached");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running stavR Governor");
}
