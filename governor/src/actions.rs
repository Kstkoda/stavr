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

/// Resolve the operator-facing log file path. PM2 writes daemon stdout to
/// `tmp/pm2-stavr.out.log` relative to the repo root by default. The
/// `STAVR_LOG_PATH` env var lets the P6 installer pin this to the absolute
/// path the daemon was started from, since cwd at Governor launch is not
/// guaranteed to be the repo root.
pub fn log_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("STAVR_LOG_PATH") {
        return std::path::PathBuf::from(p);
    }
    std::env::current_dir()
        .map(|d| d.join("tmp").join("pm2-stavr.out.log"))
        .unwrap_or_else(|_| std::path::PathBuf::from("tmp/pm2-stavr.out.log"))
}

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

    #[test]
    fn dashboard_base_strips_trailing_slash() {
        std::env::set_var("STAVR_DASHBOARD_BASE", "https://example.test/");
        assert_eq!(dashboard_base(), "https://example.test");
        std::env::remove_var("STAVR_DASHBOARD_BASE");
    }

    #[test]
    fn dashboard_base_uses_default_when_unset() {
        std::env::remove_var("STAVR_DASHBOARD_BASE");
        assert_eq!(dashboard_base(), DEFAULT_DASHBOARD_BASE);
    }

    #[test]
    fn log_path_honours_env_override() {
        std::env::set_var("STAVR_LOG_PATH", "/tmp/custom/stavr.log");
        assert_eq!(
            log_path(),
            std::path::PathBuf::from("/tmp/custom/stavr.log")
        );
        std::env::remove_var("STAVR_LOG_PATH");
    }

    #[test]
    fn log_path_falls_back_to_repo_default() {
        std::env::remove_var("STAVR_LOG_PATH");
        let p = log_path();
        let s = p.to_string_lossy();
        assert!(
            s.ends_with("tmp/pm2-stavr.out.log") || s.ends_with("tmp\\pm2-stavr.out.log"),
            "default log path should end with tmp/pm2-stavr.out.log; got {s}"
        );
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
