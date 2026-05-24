//! Operator-action implementations for the tray menu (P5).
//!
//! Each function takes a Tauri `AppHandle` and performs one side-effect
//! (opens a URL, opens a log file in the OS-default editor, etc.). The
//! tray-menu click handler dispatches to these.
//!
//! Errors are logged and absorbed — a failed "Open Dashboard" must NEVER
//! propagate up and crash the Governor; the tray icon stays alive.

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Default base URL of the daemon's dashboard. Configurable via
/// `STAVR_DASHBOARD_BASE` env var so a federated stavR (ADR-035) can point
/// at a peer's host. The tray menu items use this base for all click
/// targets.
pub const DEFAULT_DASHBOARD_BASE: &str = "http://127.0.0.1:7777";

/// Resolve the dashboard base URL — env var override or default. Trims any
/// trailing slash so callers can safely append paths starting with `/`.
pub fn dashboard_base() -> String {
    let raw =
        std::env::var("STAVR_DASHBOARD_BASE").unwrap_or_else(|_| DEFAULT_DASHBOARD_BASE.to_string());
    raw.trim_end_matches('/').to_string()
}

/// Resolve the operator-facing log file path.
///
/// Per-platform defaults follow what the OS-native service installers
/// actually write (`bin/install-{windows-service.ps1,launchd.sh,
/// systemd.sh}` + their templates):
///   - Windows: `<install-dir>\logs\StavrDaemon.err.log` — the WinSW
///     `<logpath>` in `bin/StavrDaemon.xml.template`.
///     `STAVR_INSTALL_DIR` set by the install script wins; otherwise
///     falls back to `<cwd>\logs\StavrDaemon.err.log`.
///   - macOS:   `~/Library/Logs/stavr/stderr.log` — the plist
///     `StandardErrorPath`.
///   - Linux:   systemd journals don't have a static file path. We
///     return a sentinel under `~/.local/share/stavr/` so the
///     file-opener has something concrete to fail on; `open_logs()`
///     surfaces the journalctl recipe via a log warning when the
///     sentinel is absent.
/// `STAVR_LOG_PATH` overrides on every platform.
pub fn log_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("STAVR_LOG_PATH") {
        return std::path::PathBuf::from(p);
    }
    default_log_path()
}

#[cfg(windows)]
fn default_log_path() -> std::path::PathBuf {
    if let Ok(install) = std::env::var("STAVR_INSTALL_DIR") {
        return std::path::PathBuf::from(install)
            .join("logs")
            .join("StavrDaemon.err.log");
    }
    std::env::current_dir()
        .map(|d| d.join("logs").join("StavrDaemon.err.log"))
        .unwrap_or_else(|_| std::path::PathBuf::from("logs/StavrDaemon.err.log"))
}

#[cfg(target_os = "macos")]
fn default_log_path() -> std::path::PathBuf {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    home.join("Library").join("Logs").join("stavr").join("stderr.log")
}

#[cfg(target_os = "linux")]
fn default_log_path() -> std::path::PathBuf {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    home.join(".local").join("share").join("stavr").join("stavr.log")
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn default_log_path() -> std::path::PathBuf {
    std::path::PathBuf::from("stavr.log")
}

/// Operator-facing recipe for tailing the daemon's logs when no static
/// file is available (Linux/systemd). Surfaced by `open_logs()` so the
/// operator has an actionable next step instead of "file not found."
#[cfg(target_os = "linux")]
pub const JOURNALCTL_HINT: &str =
    "On Linux the daemon logs to the systemd journal; tail with: \
     journalctl --user -u stavr.service -f";

/// Open a URL in the OS-default browser via the opener plugin. Errors are
/// logged but never propagated.
pub fn open_url<R: Runtime>(app: &AppHandle<R>, url: &str) {
    match app.opener().open_url(url, None::<String>) {
        Ok(_) => log::info!("actions: opened url {url}"),
        Err(e) => log::warn!("actions: failed to open url {url}: {e}"),
    }
}

/// Open the daemon's log file in the OS-default text-file handler.
/// Cross-platform: Windows opens Notepad/VS Code (whatever owns .log);
/// macOS opens Console.app or the default; Linux follows xdg-open.
pub fn open_logs<R: Runtime>(app: &AppHandle<R>) {
    let path = log_path();
    if !path.exists() {
        log::warn!(
            "actions: log file not found at {:?} — operator may need to set STAVR_LOG_PATH or wait for the daemon to emit",
            path
        );
        #[cfg(target_os = "linux")]
        log::warn!("actions: {}", JOURNALCTL_HINT);
        // Fall through and open anyway — the OS handler will surface the
        // "file not found" message in a user-visible dialog, which is the
        // right operator signal.
    }
    let path_str = path.to_string_lossy().into_owned();
    match app.opener().open_path(&path_str, None::<String>) {
        Ok(_) => log::info!("actions: opened log path {path_str}"),
        Err(e) => log::warn!("actions: failed to open log {path_str}: {e}"),
    }
}

/// Convenience: jump to a dashboard sub-page. Builds the full URL from the
/// configured base, then delegates to `open_url`.
pub fn open_dashboard<R: Runtime>(app: &AppHandle<R>, sub_path: &str) {
    let suffix = if sub_path.starts_with('/') {
        sub_path.to_string()
    } else {
        format!("/{sub_path}")
    };
    let url = format!("{}{}", dashboard_base(), suffix);
    open_url(app, &url);
}

/// Mute-window options exposed on the tray. Resolves to a wall-clock
/// `Duration` the EventRouter uses to compute its mute-until target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MuteWindow {
    OneHour,
    OneDay,
}

impl MuteWindow {
    pub fn as_duration(self) -> std::time::Duration {
        match self {
            Self::OneHour => std::time::Duration::from_secs(3600),
            Self::OneDay => std::time::Duration::from_secs(86_400),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::OneHour => "Mute notifications · 1 h",
            Self::OneDay => "Mute notifications · 1 d",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises both branches of `dashboard_base()` — env-override (with
    /// trailing-slash stripping) and the default fallback — in a single
    /// test. Same parallel-env-mutation race rationale as
    /// `log_path_env_override_and_fallback` below.
    #[test]
    fn dashboard_base_env_override_and_fallback() {
        // Branch 1 — env-override wins; trailing slash stripped.
        std::env::set_var("STAVR_DASHBOARD_BASE", "https://example.test/");
        assert_eq!(dashboard_base(), "https://example.test");

        // Branch 2 — fallback when the env var is absent.
        std::env::remove_var("STAVR_DASHBOARD_BASE");
        assert_eq!(dashboard_base(), DEFAULT_DASHBOARD_BASE);
    }

    /// Exercises both branches of `log_path()` — env-override and the
    /// per-platform default — in a single test. Same parallel-env-mutation
    /// race rationale as `dashboard_base_env_override_and_fallback` above.
    ///
    /// Cluster B (audit #5): the default is per-platform and points at
    /// the OS-native service's actual log destination, not the legacy
    /// PM2 tmp path. Windows: <install>\logs\StavrDaemon.err.log (or
    /// cwd-relative). macOS: ~/Library/Logs/stavr/stderr.log. Linux:
    /// ~/.local/share/stavr/stavr.log (with a journalctl recipe surfaced
    /// from `open_logs` when the sentinel doesn't exist).
    #[test]
    fn log_path_env_override_and_per_platform_default() {
        // Branch 1 — env-override wins (also pin: NO PM2 strings appear
        // anywhere in the default-resolver source; the audit point is
        // that PM2 must be off the operator's log surface).
        std::env::set_var("STAVR_LOG_PATH", "/tmp/custom/stavr.log");
        assert_eq!(
            log_path(),
            std::path::PathBuf::from("/tmp/custom/stavr.log"),
        );

        // Branch 2 — per-platform default. We assert on the platform
        // we're actually running on, plus a source-level scan that none
        // of the OTHER platforms' code drifted back to a PM2 path.
        std::env::remove_var("STAVR_LOG_PATH");
        let p = log_path();
        let s = p.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            assert!(
                s.ends_with("logs/StavrDaemon.err.log"),
                "Windows default log path should end with logs/StavrDaemon.err.log; got {s}"
            );
        } else if cfg!(target_os = "macos") {
            assert!(
                s.ends_with("Library/Logs/stavr/stderr.log"),
                "macOS default log path should end with Library/Logs/stavr/stderr.log; got {s}"
            );
        } else if cfg!(target_os = "linux") {
            assert!(
                s.ends_with(".local/share/stavr/stavr.log"),
                "Linux default log path should end with .local/share/stavr/stavr.log; got {s}"
            );
        }

        // Belt-and-braces: NO PM2 reference must survive in actions.rs
        // production code (the audit's stated regression vector).
        let src = include_str!("actions.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("actions.rs non-test prelude");
        for forbidden in ["pm2-stavr", "pm2_stavr", "pm2/stavr"] {
            assert!(
                !prod.contains(forbidden),
                "actions.rs prod code must not reference {forbidden:?} (PM2 path is off the View Logs surface)"
            );
        }
    }

    /// Linux-only: the journalctl recipe is exposed as a constant so
    /// `open_logs` can surface it, and so a future log-surface revamp
    /// doesn't have to re-derive the recipe.
    #[test]
    #[cfg(target_os = "linux")]
    fn journalctl_hint_is_exposed_and_actionable() {
        assert!(JOURNALCTL_HINT.contains("journalctl"));
        assert!(JOURNALCTL_HINT.contains("--user"));
        assert!(JOURNALCTL_HINT.contains("stavr.service"));
    }

    #[test]
    fn mute_window_durations_are_one_hour_and_one_day() {
        assert_eq!(MuteWindow::OneHour.as_duration().as_secs(), 3600);
        assert_eq!(MuteWindow::OneDay.as_duration().as_secs(), 86_400);
    }

    #[test]
    fn mute_window_labels_match_bom() {
        assert!(MuteWindow::OneHour.label().contains("1 h"));
        assert!(MuteWindow::OneDay.label().contains("1 d"));
        // Labels must be operator-distinguishable.
        assert_ne!(MuteWindow::OneHour.label(), MuteWindow::OneDay.label());
    }
}
