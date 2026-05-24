//! OS-native service status query.
//!
//! Phase 2 of the operator-companion refactor
//! (`proposed/governor-observe-only-bom.md`). The Governor observes daemon
//! state along two axes: the daemon's HTTP `/healthz` (covered by the
//! `supervisor::HealthMonitor`) and the OS init system's view of the
//! `StavrDaemon` service (this module).
//!
//!   - Windows: `sc query StavrDaemon`
//!   - Linux:   `systemctl --user is-active stavr.service`
//!   - macOS:   `launchctl print gui/<uid>/com.stavr.daemon`
//!
//! Combined into a tray pip color (`tray::pip_color`):
//!   Running + Ok           → green
//!   Running + Unhealthy/Down → amber
//!   Stopped                → red
//!   NotInstalled / Unknown → grey
//!
//! Parsers are public free functions tested with fixture strings on every
//! platform so a Linux CI run can still validate the Windows `sc` parser.

#[cfg(any(windows, unix))]
use std::process::Command;

/// Per-platform default service identifier (matches the units shipped under
/// `bin/`).
#[cfg(windows)]
pub const DEFAULT_SERVICE_NAME: &str = "StavrDaemon";
#[cfg(target_os = "linux")]
pub const DEFAULT_SERVICE_NAME: &str = "stavr.service";
#[cfg(target_os = "macos")]
pub const DEFAULT_SERVICE_NAME: &str = "com.stavr.daemon";
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub const DEFAULT_SERVICE_NAME: &str = "stavr";

/// What the OS init system says about the daemon service. Distinct from the
/// `DaemonState` (which is driven by the HTTP /healthz probe).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServiceStatus {
    Running,
    Stopped,
    NotInstalled,
    /// Query failed (tool missing on PATH, permission error, unexpected
    /// output, …). Surfaces as grey in the tray with a tooltip suffix.
    #[default]
    Unknown,
}

impl ServiceStatus {
    pub fn human_label(self) -> &'static str {
        match self {
            ServiceStatus::Running => "service running",
            ServiceStatus::Stopped => "service stopped",
            ServiceStatus::NotInstalled => "service not installed",
            ServiceStatus::Unknown => "service status unknown",
        }
    }
}

/// Query abstraction. Production is a thin shell-out to the platform's
/// init system; tests use the mock.
pub trait ServiceQuery: Send + Sync {
    fn status(&self) -> ServiceStatus;
}

/// Production probe — shells out to the per-platform tool.
pub struct SystemServiceQuery {
    pub name: String,
}

impl SystemServiceQuery {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
        }
    }
}

impl Default for SystemServiceQuery {
    fn default() -> Self {
        Self::new(DEFAULT_SERVICE_NAME)
    }
}

impl ServiceQuery for SystemServiceQuery {
    fn status(&self) -> ServiceStatus {
        #[cfg(windows)]
        {
            return query_windows(&self.name);
        }
        #[cfg(target_os = "linux")]
        {
            return query_linux(&self.name);
        }
        #[cfg(target_os = "macos")]
        {
            return query_macos(&self.name);
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = &self.name;
            ServiceStatus::Unknown
        }
    }
}

#[cfg(windows)]
fn query_windows(name: &str) -> ServiceStatus {
    // sc.exe ships with every Windows install. stdout and stderr land in
    // different streams; combine for parser convenience.
    let out = match Command::new("sc").args(["query", name]).output() {
        Ok(o) => o,
        Err(_) => return ServiceStatus::Unknown,
    };
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&out.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    parse_sc_query(&combined)
}

#[cfg(target_os = "linux")]
fn query_linux(name: &str) -> ServiceStatus {
    let out = match Command::new("systemctl")
        .args(["--user", "is-active", name])
        .output()
    {
        Ok(o) => o,
        Err(_) => return ServiceStatus::Unknown,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_systemctl_is_active(&stdout, &stderr, out.status.success())
}

#[cfg(target_os = "macos")]
fn query_macos(name: &str) -> ServiceStatus {
    let uid = match current_uid() {
        Some(u) => u,
        None => return ServiceStatus::Unknown,
    };
    let target = format!("gui/{}/{}", uid, name);
    let out = match Command::new("launchctl").args(["print", &target]).output() {
        Ok(o) => o,
        Err(_) => return ServiceStatus::Unknown,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_launchctl_print(&stdout, &stderr, out.status.success())
}

#[cfg(target_os = "macos")]
fn current_uid() -> Option<u32> {
    // `id -u` ships with every macOS install. We avoid pulling `libc` /
    // `nix` just for getuid().
    let out = Command::new("id").arg("-u").output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Parse Windows `sc query <name>` output. Looks for `STATE : N RUNNING`.
///
/// Typical RUNNING line shape:
///
/// ```text
///         STATE              : 4  RUNNING
/// ```
pub fn parse_sc_query(output: &str) -> ServiceStatus {
    let lower = output.to_ascii_lowercase();
    // sc emits "the specified service does not exist as an installed
    // service" on stderr when the service isn't registered.
    if lower.contains("does not exist as an installed service")
        || lower.contains("service does not exist")
    {
        return ServiceStatus::NotInstalled;
    }
    for line in output.lines() {
        let t = line.trim();
        let upper = t.to_ascii_uppercase();
        if upper.starts_with("STATE") && upper.contains(':') {
            if upper.contains("RUNNING") {
                return ServiceStatus::Running;
            }
            if upper.contains("STOPPED")
                || upper.contains("STOP_PENDING")
                || upper.contains("PAUSED")
                || upper.contains("START_PENDING")
            {
                return ServiceStatus::Stopped;
            }
        }
    }
    ServiceStatus::Unknown
}

/// Parse Linux `systemctl --user is-active <unit>` output. The exit code
/// drives the verdict; stdout is a single token (`active`, `inactive`,
/// `failed`, `activating`, `deactivating`, `unknown`, …).
pub fn parse_systemctl_is_active(stdout: &str, stderr: &str, success: bool) -> ServiceStatus {
    let s = stdout.trim();
    match s {
        "active" | "reloading" | "activating" => ServiceStatus::Running,
        "inactive" | "deactivating" | "failed" => ServiceStatus::Stopped,
        _ => {
            let err_lower = stderr.to_ascii_lowercase();
            if err_lower.contains("not loaded") || err_lower.contains("not-found") {
                return ServiceStatus::NotInstalled;
            }
            if !success {
                // Some systemd builds print "unknown" on stdout for a
                // unit that was never installed.
                if s.is_empty() || s == "unknown" {
                    return ServiceStatus::NotInstalled;
                }
            }
            ServiceStatus::Unknown
        }
    }
}

/// Parse macOS `launchctl print gui/<uid>/<label>` output. The agent is
/// "running" when the print succeeds and includes `state = running` (or a
/// non-zero `pid =` line). If the service isn't loaded the stderr carries
/// "Could not find service".
pub fn parse_launchctl_print(stdout: &str, stderr: &str, success: bool) -> ServiceStatus {
    if !success {
        let lower = stderr.to_ascii_lowercase();
        if lower.contains("could not find service") || lower.contains("not loaded") {
            return ServiceStatus::NotInstalled;
        }
        return ServiceStatus::Unknown;
    }
    for line in stdout.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("state") {
            // Value after the `=`. We can't just check `contains("running")`
            // because "not running" contains "running"; match the trimmed
            // token after the equals sign instead.
            let val = rest.split('=').nth(1).map(|v| v.trim()).unwrap_or("");
            if val == "running" {
                return ServiceStatus::Running;
            }
            return ServiceStatus::Stopped;
        }
        if let Some(rest) = t.strip_prefix("pid") {
            // pid = NNNN — non-zero means a process is alive
            let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u32>() {
                if n > 0 {
                    return ServiceStatus::Running;
                }
            }
        }
    }
    ServiceStatus::Stopped
}

/// Test double — returns a programmable status.
pub struct MockServiceQuery {
    response: parking_lot::Mutex<ServiceStatus>,
}

impl MockServiceQuery {
    pub fn new(initial: ServiceStatus) -> Self {
        Self {
            response: parking_lot::Mutex::new(initial),
        }
    }
    pub fn set(&self, next: ServiceStatus) {
        *self.response.lock() = next;
    }
}

impl ServiceQuery for MockServiceQuery {
    fn status(&self) -> ServiceStatus {
        *self.response.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Windows: sc query parser -----------------------------------------

    #[test]
    fn parse_sc_query_recognises_running_state() {
        let fixture = "\r\nSERVICE_NAME: StavrDaemon\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r\n";
        assert_eq!(parse_sc_query(fixture), ServiceStatus::Running);
    }

    #[test]
    fn parse_sc_query_recognises_stopped_state() {
        let fixture = "SERVICE_NAME: StavrDaemon\n        STATE              : 1  STOPPED\n";
        assert_eq!(parse_sc_query(fixture), ServiceStatus::Stopped);
    }

    #[test]
    fn parse_sc_query_recognises_pending_states_as_stopped() {
        // STOP_PENDING / START_PENDING / PAUSED are all "not currently
        // serving requests" — tray surfaces them as not-running.
        for s in &["STOP_PENDING", "START_PENDING", "PAUSED"] {
            let fixture = format!("STATE : 3  {s}\n");
            assert_eq!(parse_sc_query(&fixture), ServiceStatus::Stopped, "{s}");
        }
    }

    #[test]
    fn parse_sc_query_recognises_missing_service() {
        let fixture = "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n";
        assert_eq!(parse_sc_query(fixture), ServiceStatus::NotInstalled);
    }

    #[test]
    fn parse_sc_query_unknown_for_garbage() {
        assert_eq!(parse_sc_query(""), ServiceStatus::Unknown);
        assert_eq!(parse_sc_query("unrecognised output"), ServiceStatus::Unknown);
    }

    // ---- Linux: systemctl is-active parser --------------------------------

    #[test]
    fn parse_systemctl_is_active_recognises_active() {
        assert_eq!(
            parse_systemctl_is_active("active\n", "", true),
            ServiceStatus::Running
        );
        assert_eq!(
            parse_systemctl_is_active("activating\n", "", false),
            ServiceStatus::Running
        );
    }

    #[test]
    fn parse_systemctl_is_active_recognises_inactive() {
        assert_eq!(
            parse_systemctl_is_active("inactive\n", "", false),
            ServiceStatus::Stopped
        );
        assert_eq!(
            parse_systemctl_is_active("failed\n", "", false),
            ServiceStatus::Stopped
        );
    }

    #[test]
    fn parse_systemctl_is_active_recognises_missing_unit() {
        assert_eq!(
            parse_systemctl_is_active(
                "unknown\n",
                "Failed to query stavr.service: Unit stavr.service not loaded.\n",
                false,
            ),
            ServiceStatus::NotInstalled,
        );
        assert_eq!(
            parse_systemctl_is_active("", "Unit not-found\n", false),
            ServiceStatus::NotInstalled
        );
    }

    // ---- macOS: launchctl print parser ------------------------------------

    #[test]
    fn parse_launchctl_print_recognises_running() {
        let fixture = "com.stavr.daemon = {\n        active count = 1\n        state = running\n        pid = 12345\n};\n";
        assert_eq!(
            parse_launchctl_print(fixture, "", true),
            ServiceStatus::Running
        );
    }

    #[test]
    fn parse_launchctl_print_recognises_pid_running_without_state_line() {
        // Some launchctl versions omit "state = running" when on-demand
        // services are alive; fall back to pid > 0.
        let fixture = "com.stavr.daemon = {\n        pid = 4242\n        last exit code = 0\n};\n";
        assert_eq!(
            parse_launchctl_print(fixture, "", true),
            ServiceStatus::Running
        );
    }

    #[test]
    fn parse_launchctl_print_recognises_stopped_state() {
        let fixture = "com.stavr.daemon = {\n        state = not running\n};\n";
        assert_eq!(
            parse_launchctl_print(fixture, "", true),
            ServiceStatus::Stopped
        );
    }

    #[test]
    fn parse_launchctl_print_recognises_not_loaded() {
        assert_eq!(
            parse_launchctl_print("", "Could not find service \"com.stavr.daemon\"\n", false),
            ServiceStatus::NotInstalled,
        );
    }

    #[test]
    fn parse_launchctl_print_unknown_on_nonzero_without_classification() {
        assert_eq!(
            parse_launchctl_print("", "permission denied\n", false),
            ServiceStatus::Unknown
        );
    }

    // ---- Mock ----------------------------------------------------------

    #[test]
    fn mock_service_query_returns_programmed_status() {
        let q = MockServiceQuery::new(ServiceStatus::Running);
        assert_eq!(q.status(), ServiceStatus::Running);
        q.set(ServiceStatus::Stopped);
        assert_eq!(q.status(), ServiceStatus::Stopped);
    }
}
