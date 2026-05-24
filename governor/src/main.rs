//! stavR Governor entry point.
//!
//! Phase 1 of the operator-companion refactor
//! (`proposed/governor-observe-only-bom.md`): the Governor observes the
//! daemon but never restarts it — the OS-native StavrDaemon service is the
//! sole supervisor. This file wires:
//!
//!   - a `HealthMonitor` that polls `/healthz` and updates a state machine,
//!   - the tray icon + tooltip (state-driven),
//!   - the SSE `event-bridge` → `EventRouter` → OS-toast pipeline.
//!
//! Restart / orphan-kill / sidecar-spawn paths were deleted in the same
//! commit as the `restart.rs` and `port_check.rs` modules.

// On Windows, hide the console window in release builds. Stay attached in
// debug so we can `println!` while iterating.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use stavr_governor::event_bridge::{EventBridge, EventSink, UreqFetcher, DEFAULT_STREAM_URL};
use stavr_governor::event_router::EventRouter;
use stavr_governor::heartbeat::{
    self, HeartbeatPayload, HeartbeatSender, UreqSender, DEFAULT_HEARTBEAT_URL, HEARTBEAT_INTERVAL,
};
use stavr_governor::icons;
use stavr_governor::notification::TauriToastRenderer;
use stavr_governor::service::{ServiceQuery, ServiceStatus, SystemServiceQuery};
use stavr_governor::state::DaemonState;
use stavr_governor::supervisor::{
    Clock, HealthMonitor, HealthProbe, HttpProbe, SystemClock, DEFAULT_HEALTH_URL,
};
use tauri::Manager;

mod tray;

/// How often the tray watcher re-renders the icon. 500 ms is comfortably
/// under the BOM's 1 s update budget.
const TRAY_TICK: Duration = Duration::from_millis(500);

/// How often the service-status poller shells out to the OS init system.
/// 1 s gives "Stop-Service StavrDaemon turns the pip red within a couple
/// of ticks" (BOM Phase 2 acceptance) without making the daemon's host
/// run `sc query` 10× per second.
const SERVICE_POLL: Duration = Duration::from_secs(1);

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    for &v in icons::IconVariant::all() {
        debug_assert!(icons::is_valid_png(v.bytes_32()), "icon {v:?} bytes invalid");
    }

    let health_url = std::env::var("STAVR_HEALTH_URL")
        .unwrap_or_else(|_| DEFAULT_HEALTH_URL.to_string());
    log::info!("health monitor will probe {health_url}");

    let probe: Arc<dyn HealthProbe> = Arc::new(HttpProbe::new(health_url));
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let monitor = Arc::new(HealthMonitor::new(probe, clock));

    // CLAUDE.md hard rule #10: anything that can stall lives off the main
    // path. The Tauri event loop owns the main thread; health probing is a
    // sibling thread.
    let mon_for_thread = monitor.clone();
    std::thread::Builder::new()
        .name("health-monitor".to_string())
        .spawn(move || mon_for_thread.run_forever())
        .expect("spawn health-monitor thread");

    // Phase 2: OS-native service status. The poller updates a shared cell
    // every SERVICE_POLL; the tray watcher reads it alongside the health
    // monitor's state snapshot.
    let service_query: Arc<dyn ServiceQuery> = Arc::new(SystemServiceQuery::default());
    let service_status: Arc<Mutex<ServiceStatus>> = Arc::new(Mutex::new(ServiceStatus::Unknown));
    let svc_for_thread = service_query.clone();
    let cell_for_thread = service_status.clone();
    std::thread::Builder::new()
        .name("service-poll".to_string())
        .spawn(move || loop {
            let s = svc_for_thread.status();
            *cell_for_thread.lock() = s;
            std::thread::sleep(SERVICE_POLL);
        })
        .expect("spawn service-poll thread");

    let stream_url =
        std::env::var("STAVR_STREAM_URL").unwrap_or_else(|_| DEFAULT_STREAM_URL.to_string());

    // governor-polish Cluster C — Governor → daemon heartbeat. Every
    // HEARTBEAT_INTERVAL we POST /governor/heartbeat so the daemon's
    // Diagnostics tile knows the Governor is alive. Failures are
    // logged and absorbed (the daemon may be restarting or stopped).
    let heartbeat_url = std::env::var("STAVR_HEARTBEAT_URL")
        .unwrap_or_else(|_| DEFAULT_HEARTBEAT_URL.to_string());
    let heartbeat_payload = HeartbeatPayload::from_build_env();
    let heartbeat_sender: Arc<dyn HeartbeatSender> = Arc::new(UreqSender);
    log::info!(
        "heartbeat sender will POST {heartbeat_url} every {:?} (version {}, signing {})",
        HEARTBEAT_INTERVAL,
        heartbeat_payload.version,
        heartbeat_payload.signing.as_deref().unwrap_or("unsigned"),
    );
    {
        let sender = heartbeat_sender.clone();
        let url = heartbeat_url.clone();
        let payload = heartbeat_payload.clone();
        std::thread::Builder::new()
            .name("heartbeat-sender".to_string())
            .spawn(move || heartbeat::run_forever(sender, url, payload, HEARTBEAT_INTERVAL))
            .expect("spawn heartbeat-sender thread");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Phase 5: login auto-start. On installed apps the OS surface is
        // Windows Startup folder / macOS LaunchAgent / XDG autostart.
        // The tray "Start at login" toggle is the operator's control.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(move |app| {
            app.manage(monitor.clone());
            // Phase 4 cluster A — shared tooltip override so operator
            // actions can paint "stavR · upgrading…" while their script
            // is in flight without racing the tray watcher.
            let tray_override = Arc::new(tray::TrayOverride::new());
            app.manage(tray_override.clone());
            let _tray = tray::build(app.handle())?;
            log::info!("stavR Governor started; tray icon attached");

            // SSE event subscription + OS toast.
            //
            // The bridge owns a single long-lived TCP connection to
            // `/dashboard/stream` (Footgun #6 — never spam parallel SSE
            // sessions). Events pass through the router (per-kind debounce
            // + operator-awareness filter) before reaching the OS toast.
            let toast_renderer = TauriToastRenderer::new(app.handle().clone());
            let router: Arc<EventRouter> = Arc::new(EventRouter::new(toast_renderer));
            app.manage(router.clone());
            let sink: Arc<dyn EventSink> = router;
            let bridge = Arc::new(EventBridge::new(
                stream_url.clone(),
                Arc::new(UreqFetcher),
                sink,
            ));
            let bridge_thread = bridge.clone();
            std::thread::Builder::new()
                .name("event-bridge".to_string())
                .spawn(move || {
                    bridge_thread.run_forever();
                })
                .expect("spawn event-bridge thread");

            // Tray watcher: snapshot monitor state + service status every
            // TRAY_TICK and push it onto the tray (icon + tooltip). When
            // the operator's `TrayOverride` is set ("upgrading…" etc.)
            // we repaint every tick so the banner survives even when no
            // pip-color change would otherwise have triggered a paint.
            let watcher_app = app.handle().clone();
            let watcher_state = monitor.state();
            let watcher_service = service_status.clone();
            let watcher_override = tray_override.clone();
            std::thread::Builder::new()
                .name("tray-watcher".to_string())
                .spawn(move || {
                    let mut prev: Option<(DaemonState, ServiceStatus, Option<String>)> = None;
                    loop {
                        let service = *watcher_service.lock();
                        let snapshot = {
                            let sm = watcher_state.lock();
                            tray::StateSnapshot::from(&sm, service, Instant::now())
                        };
                        let override_msg = watcher_override.current();
                        let key = (snapshot.state, snapshot.service, override_msg.clone());
                        if Some(&key) != prev.as_ref() {
                            if let Err(e) =
                                tray::apply_state(&watcher_app, &snapshot, override_msg.as_deref())
                            {
                                log::warn!("tray watcher: apply_state failed: {e}");
                            }
                            prev = Some(key);
                        }
                        std::thread::sleep(TRAY_TICK);
                    }
                })
                .expect("spawn tray watcher thread");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running stavR Governor");
}
