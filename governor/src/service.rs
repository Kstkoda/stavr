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

/// Windows process-creation flag — spawn the child *without* allocating a
/// console window. Without it, the 1 Hz `sc query StavrDaemon` service
/// poll (and the operator-triggered restart/upgrade shell-outs) flash a
/// console window on the operator's desktop every tick. See the
/// `windows_subprocesses_suppress_console_window` anchor test.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `CommandExt::creation_flags` lives behind this Windows-only trait.
#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

/// Outcome of a service-control action (`restart`, `upgrade`).
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("failed to spawn control subprocess: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("control subprocess exited with status {0}")]
    NonZeroExit(i32),
    #[error("control tool not found on PATH ({0})")]
    NotFound(&'static str),
    #[error("upgrade script not found at {0}")]
    UpgradeScriptMissing(std::path::PathBuf),
    /// governor-polish Cluster D (PR #77 security review): the public
    /// `SystemServiceController.name` failed the defensive whitelist
    /// BEFORE being interpolated into a PowerShell command string.
    /// `pub name: String` was flagged as "fragile for a future caller";
    /// this gate keeps the format!() argument inside a known-safe
    /// character set.
    #[error("invalid service name: {0:?}")]
    InvalidName(String),
    /// governor-polish Cluster D (PR #77 security review): the upgrade
    /// script path failed the defensive whitelist before being passed
    /// through to `Start-Process -FilePath powershell`. The existing
    /// single-quote-doubling escape protects the PowerShell parser, but
    /// the whitelist adds defence in depth against an operator who
    /// points `STAVR_UPGRADE_SCRIPT` at something pathological.
    #[error("invalid upgrade script path: {0}")]
    InvalidScriptPath(std::path::PathBuf),
}

/// Defensive whitelist on `SystemServiceController.name`. The string is
/// interpolated into a PowerShell command on Windows
/// (`Restart-Service -Name {name} -Force`), so the allowed set is
/// deliberately narrow: alphanum + `.`, `_`, `-`. Real service ids
/// already match — Windows `StavrDaemon`, systemd `stavr.service`,
/// launchd `com.stavr.daemon`.
pub fn validate_service_name(name: &str) -> Result<(), ServiceError> {
    if name.is_empty() || name.len() > 64 {
        return Err(ServiceError::InvalidName(name.to_string()));
    }
    let ok = name.bytes().all(|b| {
        b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-'
    });
    if !ok {
        return Err(ServiceError::InvalidName(name.to_string()));
    }
    Ok(())
}

/// Defensive whitelist on the upgrade-script path. Permissive enough for
/// real Windows install paths (drive letters + `Program Files`-style
/// spaces) but rejects anything that could break PowerShell quoting:
/// `'`, `"`, `;`, `&`, `|`, `$`, backtick, parens, redirection chars,
/// newlines.
pub fn validate_script_path(p: &std::path::Path) -> Result<(), ServiceError> {
    let s = match p.to_str() {
        Some(s) => s,
        None => return Err(ServiceError::InvalidScriptPath(p.to_path_buf())),
    };
    if s.is_empty() || s.len() > 512 {
        return Err(ServiceError::InvalidScriptPath(p.to_path_buf()));
    }
    let ok = s.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '.' | '_' | '-' | '/' | '\\' | ':' | ' ' | '~' | '(' | ')')
    });
    // We allow `(` and `)` because Windows ships `C:\Program Files (x86)\…`
    // by default; PowerShell single-quote escaping (already in place in
    // `spawn_upgrade_windows`) handles them. Reject the rest — semicolons,
    // pipes, ampersands, dollar signs, backticks, quotes, redirection,
    // newlines.
    if !ok {
        return Err(ServiceError::InvalidScriptPath(p.to_path_buf()));
    }
    Ok(())
}

/// Operator-triggered service control. Phase 4 of the operator-companion
/// refactor: the Governor delegates restart / upgrade to the OS init
/// system + a hardened upgrade script — it never spawns or kills the
/// daemon directly. Nothing fires unless the operator clicks; this is
/// not a supervision loop.
pub trait ServiceController: Send + Sync {
    /// Restart the OS-native service. Returns when the control tool has
    /// exited; confirmation of the daemon's readiness is the next
    /// `/healthz` tick (the watcher will repaint the pip).
    fn restart(&self) -> Result<(), ServiceError>;
}

/// Production controller — shells out to the platform's init system
/// (`Restart-Service`, `systemctl --user restart`, `launchctl
/// kickstart -k`). Windows uses `Start-Process -Verb RunAs` for the
/// elevation prompt — failures from a cancelled UAC dialog surface as
/// `ServiceError::NonZeroExit`.
pub struct SystemServiceController {
    pub name: String,
}

impl SystemServiceController {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
        }
    }
}

impl Default for SystemServiceController {
    fn default() -> Self {
        Self::new(DEFAULT_SERVICE_NAME)
    }
}

impl ServiceController for SystemServiceController {
    fn restart(&self) -> Result<(), ServiceError> {
        // governor-polish Cluster D — defensive whitelist BEFORE the
        // name reaches a `format!()` into PowerShell. PR #77 security
        // review called `pub name: String` "fragile for a future caller";
        // this gate makes the fragility a 400 rather than a code-exec.
        validate_service_name(&self.name)?;
        #[cfg(windows)]
        {
            return restart_windows(&self.name);
        }
        #[cfg(target_os = "linux")]
        {
            return restart_linux(&self.name);
        }
        #[cfg(target_os = "macos")]
        {
            return restart_macos(&self.name);
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = &self.name;
            Err(ServiceError::NotFound("unsupported platform"))
        }
    }
}

#[cfg(windows)]
fn restart_windows(name: &str) -> Result<(), ServiceError> {
    // Restart-Service requires admin. Drive the elevation via PowerShell's
    // Start-Process -Verb RunAs — Windows pops the UAC prompt, the operator
    // confirms, and the inner command runs elevated. We -Wait so the
    // ServiceError reflects the inner command's exit code rather than the
    // launcher's success in *spawning* an elevated child.
    let inner = format!("Restart-Service -Name {name} -Force");
    let ps_cmd = format!(
        "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-Command','{inner}' -Verb RunAs -Wait -PassThru | ForEach-Object {{ exit $_.ExitCode }}"
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ServiceError::NotFound("powershell")
            } else {
                ServiceError::Spawn(e)
            }
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(ServiceError::NonZeroExit(status.code().unwrap_or(-1)))
    }
}

#[cfg(target_os = "linux")]
fn restart_linux(name: &str) -> Result<(), ServiceError> {
    let status = std::process::Command::new("systemctl")
        .args(["--user", "restart", name])
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ServiceError::NotFound("systemctl")
            } else {
                ServiceError::Spawn(e)
            }
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(ServiceError::NonZeroExit(status.code().unwrap_or(-1)))
    }
}

#[cfg(target_os = "macos")]
fn restart_macos(name: &str) -> Result<(), ServiceError> {
    let uid = current_uid().ok_or(ServiceError::NotFound("id -u"))?;
    let target = format!("gui/{}/{}", uid, name);
    let status = std::process::Command::new("launchctl")
        .args(["kickstart", "-k", &target])
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ServiceError::NotFound("launchctl")
            } else {
                ServiceError::Spawn(e)
            }
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(ServiceError::NonZeroExit(status.code().unwrap_or(-1)))
    }
}

/// Mock controller — records every call; configurable success/failure.
pub struct MockServiceController {
    pub calls: parking_lot::Mutex<u32>,
    pub succeed: bool,
}

impl MockServiceController {
    pub fn new(succeed: bool) -> Self {
        Self {
            calls: parking_lot::Mutex::new(0),
            succeed,
        }
    }
    pub fn call_count(&self) -> u32 {
        *self.calls.lock()
    }
}

impl ServiceController for MockServiceController {
    fn restart(&self) -> Result<(), ServiceError> {
        *self.calls.lock() += 1;
        if self.succeed {
            Ok(())
        } else {
            Err(ServiceError::NonZeroExit(1))
        }
    }
}

/// Resolve the upgrade script path. The Windows installer drops it under
/// the repo's `bin/` directory; operators running from a checkout use the
/// same path. `STAVR_UPGRADE_SCRIPT` overrides for advanced layouts.
pub fn resolve_upgrade_script() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("STAVR_UPGRADE_SCRIPT") {
        return std::path::PathBuf::from(p);
    }
    let (rel_name, _) = upgrade_script_name();
    std::env::current_dir()
        .map(|d| d.join("bin").join(rel_name))
        .unwrap_or_else(|_| std::path::PathBuf::from(format!("bin/{rel_name}")))
}

/// Per-platform upgrade script name + the launcher used to invoke it.
#[cfg(windows)]
pub fn upgrade_script_name() -> (&'static str, &'static str) {
    ("upgrade-daemon.ps1", "powershell")
}
#[cfg(not(windows))]
pub fn upgrade_script_name() -> (&'static str, &'static str) {
    ("upgrade-daemon.sh", "bash")
}

/// Invoke the upgrade script. The script enforces the rollback contract:
/// on any failure between `git pull` and the post-restart health check
/// the daemon is reset to the pre-upgrade commit and the service is
/// restarted before the script exits non-zero.
///
/// **Elevation**: the script calls `Stop-Service` / `Start-Service` (or
/// `systemctl --user` / `launchctl`). On Windows that requires admin, so
/// this function spawns the script through `Start-Process -Verb RunAs`
/// — same elevation pattern as `restart_windows`, one UAC prompt per
/// click. Linux + macOS use the user-level `--user` / `gui/<uid>` paths
/// already and need no elevation. Diagnostic output from the elevated
/// PowerShell console is transient; the toast on completion is the
/// operator's at-a-glance status, and the script can be re-run manually
/// from an elevated terminal for full output.
///
/// Spawn-and-detach: the returned `Child` is consumed by the caller,
/// which `wait()`s in its own thread so the tray can repaint a
/// "upgrading…" tooltip while the script runs.
pub fn spawn_upgrade(
    script: &std::path::Path,
) -> Result<std::process::Child, ServiceError> {
    // governor-polish Cluster D — whitelist the script path BEFORE the
    // exists() check + spawn. STAVR_UPGRADE_SCRIPT is operator-controlled
    // (the env override path in `resolve_upgrade_script`); the existing
    // single-quote-doubling escape in `spawn_upgrade_windows` handles the
    // PowerShell parser, but a hostile-looking path should fail fast
    // rather than land in a shell command line at all.
    validate_script_path(script)?;
    if !script.exists() {
        return Err(ServiceError::UpgradeScriptMissing(script.to_path_buf()));
    }
    #[cfg(windows)]
    {
        return spawn_upgrade_windows(script);
    }
    #[cfg(not(windows))]
    {
        let (_, launcher) = upgrade_script_name();
        std::process::Command::new(launcher)
            .arg(script)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ServiceError::NotFound(launcher)
                } else {
                    ServiceError::Spawn(e)
                }
            })
    }
}

#[cfg(windows)]
fn spawn_upgrade_windows(script: &std::path::Path) -> Result<std::process::Child, ServiceError> {
    // Same shape as restart_windows: an outer PowerShell drives
    // `Start-Process -Verb RunAs` against an inner PowerShell that
    // actually runs the .ps1. -Wait + -PassThru | ForEach-Object exits
    // the outer with the inner's exit code, so `Child::wait().status`
    // carries the script's verdict (0 / 2 / 3 / 4 per the script
    // contract). Cancelling the UAC prompt surfaces as a non-zero exit.
    //
    // Single-quote-escape the script path for PowerShell: single quotes
    // preserve everything literally; embedded single quotes double up.
    let script_str = script.to_string_lossy();
    let escaped = script_str.replace('\'', "''");
    let inner_args =
        format!("'-NoProfile','-ExecutionPolicy','Bypass','-File','{escaped}'");
    let ps_cmd = format!(
        "Start-Process -FilePath powershell -ArgumentList {inner_args} -Verb RunAs -Wait -PassThru | ForEach-Object {{ exit $_.ExitCode }}"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ServiceError::NotFound("powershell")
            } else {
                ServiceError::Spawn(e)
            }
        })
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
    let out = match Command::new("sc")
        .args(["query", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
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

    // ---- Phase 4: ServiceController + upgrade plumbing -----------------

    #[test]
    fn mock_controller_records_restart_calls() {
        let c = MockServiceController::new(true);
        assert_eq!(c.call_count(), 0);
        c.restart().expect("mock controller programmed to succeed");
        c.restart().unwrap();
        assert_eq!(c.call_count(), 2);
    }

    #[test]
    fn mock_controller_failure_path_returns_nonzero_exit() {
        let c = MockServiceController::new(false);
        let err = c.restart().unwrap_err();
        assert!(matches!(err, ServiceError::NonZeroExit(1)), "got {err:?}");
    }

    #[test]
    fn upgrade_script_resolver_honours_env_override() {
        std::env::set_var(
            "STAVR_UPGRADE_SCRIPT",
            "/tmp/custom/upgrade-daemon.script",
        );
        assert_eq!(
            resolve_upgrade_script(),
            std::path::PathBuf::from("/tmp/custom/upgrade-daemon.script")
        );
        std::env::remove_var("STAVR_UPGRADE_SCRIPT");
        let fallback = resolve_upgrade_script();
        let s = fallback.to_string_lossy();
        let (expected_name, _) = upgrade_script_name();
        assert!(
            s.ends_with(expected_name)
                || s.ends_with(&format!("/{expected_name}"))
                || s.ends_with(&format!("\\{expected_name}")),
            "default upgrade-script path should end with {expected_name}; got {s}"
        );
    }

    #[test]
    fn spawn_upgrade_returns_upgrade_script_missing_for_absent_path() {
        let path = std::path::PathBuf::from("/nonexistent/upgrade-daemon.script");
        let err = spawn_upgrade(&path).unwrap_err();
        match err {
            ServiceError::UpgradeScriptMissing(p) => assert_eq!(p, path),
            other => panic!("expected UpgradeScriptMissing, got {other:?}"),
        }
    }

    /// Phase 4 cluster A — the upgrade flow on Windows MUST elevate via
    /// `Start-Process -Verb RunAs` because the script calls
    /// Stop-Service / Start-Service, both of which require admin.
    /// Anchor the elevation pattern in the source so a future refactor
    /// can't silently drop the UAC prompt and re-introduce the
    /// "upgrade always exits 3 on Windows" failure mode.
    #[test]
    fn spawn_upgrade_on_windows_uses_runas_elevation() {
        let src = include_str!("service.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("service.rs should have a non-test prelude");
        // Match the Windows-only fn explicitly so we don't confuse with
        // restart_windows (which uses the same pattern by design).
        assert!(
            prod.contains("fn spawn_upgrade_windows"),
            "spawn_upgrade_windows() must exist as the Windows elevation branch"
        );
        // The elevated invocation pattern.
        let after = prod
            .split("fn spawn_upgrade_windows")
            .nth(1)
            .expect("spawn_upgrade_windows source");
        let body = after
            .split("\n#[cfg(")
            .next()
            .unwrap_or(after)
            .split("\nfn ")
            .next()
            .unwrap_or(after);
        assert!(
            body.contains("-Verb RunAs"),
            "spawn_upgrade_windows must run the script via Start-Process -Verb RunAs"
        );
        assert!(
            body.contains("Start-Process"),
            "spawn_upgrade_windows must use Start-Process to elevate"
        );
    }

    #[test]
    fn upgrade_script_name_matches_platform() {
        let (name, launcher) = upgrade_script_name();
        if cfg!(windows) {
            assert_eq!(name, "upgrade-daemon.ps1");
            assert_eq!(launcher, "powershell");
        } else {
            assert_eq!(name, "upgrade-daemon.sh");
            assert_eq!(launcher, "bash");
        }
    }

    // ---- Cluster D: defensive whitelists ----

    /// `validate_service_name` accepts every real service id we ship
    /// (Windows / systemd / launchd). A future operator-supplied name
    /// must clear the same gate before reaching `format!()`.
    #[test]
    fn validate_service_name_accepts_real_service_ids() {
        for ok in [
            "StavrDaemon",      // Windows
            "stavr.service",    // systemd
            "com.stavr.daemon", // launchd
            "stavr_daemon",     // hypothetical underscore variant
            "stavr-daemon-2",   // hypothetical hyphen variant
        ] {
            assert!(validate_service_name(ok).is_ok(), "rejected real id: {ok}");
        }
    }

    /// Every char outside `[A-Za-z0-9._-]` must be rejected. Each entry
    /// here corresponds to a real PowerShell metacharacter — the
    /// whitelist's job is to refuse them all up front.
    #[test]
    fn validate_service_name_rejects_shell_metacharacters() {
        for bad in [
            "Stavr;Stop-Computer",
            "Stavr Daemon",       // space
            "Stavr|tee",
            "Stavr&calc",
            "Stavr$evil",
            "Stavr`whoami`",
            "Stavr'OR'1=1",
            "Stavr\"injection\"",
            "Stavr(bad)",
            "Stavr<redirect",
            "Stavr>redirect",
            "Stavr\nnewline",
            "",                   // empty
            &"a".repeat(65),     // oversized
        ] {
            assert!(
                validate_service_name(bad).is_err(),
                "whitelist incorrectly accepted {bad:?}"
            );
        }
    }

    /// `validate_script_path` accepts realistic Windows + Unix install
    /// paths. Spaces (Program Files), parens (Program Files (x86)),
    /// drive letters and both path separators must all pass.
    #[test]
    fn validate_script_path_accepts_realistic_install_paths() {
        for ok in [
            r"C:\Users\op\stavr\bin\upgrade-daemon.ps1",
            r"C:\Program Files\stavR\bin\upgrade-daemon.ps1",
            r"C:\Program Files (x86)\stavR\bin\upgrade-daemon.ps1",
            "/home/op/stavr/bin/upgrade-daemon.sh",
            "/opt/stavR/bin/upgrade-daemon.sh",
            "/Users/op/Library/Application Support/stavR/upgrade-daemon.sh",
        ] {
            let p = std::path::PathBuf::from(ok);
            assert!(validate_script_path(&p).is_ok(), "rejected real path: {ok}");
        }
    }

    /// Hostile script paths — every chararacter outside the whitelist
    /// must be refused before the path is interpolated into a
    /// PowerShell command line.
    #[test]
    fn validate_script_path_rejects_shell_metacharacters() {
        for bad in [
            r"C:\foo'; Stop-Computer; '\bar",
            r"C:\foo;calc",
            r"C:\foo|tee",
            r"C:\foo$evil",
            r"C:\foo`whoami`",
            r"C:\foo&calc",
            "C:\\foo\\bar\\baz\"", // embedded double-quote
            "/tmp/foo\nrm -rf /",
            "",
        ] {
            let p = std::path::PathBuf::from(bad);
            assert!(
                validate_script_path(&p).is_err(),
                "whitelist incorrectly accepted hostile path: {bad:?}"
            );
        }
    }

    /// SystemServiceController::restart MUST run the whitelist on
    /// `self.name` before doing anything else. A
    /// hostile-name-but-real-controller call returns `InvalidName`
    /// without ever shelling out.
    #[test]
    fn restart_refuses_hostile_service_name() {
        let bad = SystemServiceController::new("Stavr; Stop-Computer");
        let err = bad.restart().unwrap_err();
        assert!(
            matches!(err, ServiceError::InvalidName(_)),
            "expected InvalidName, got {err:?}"
        );
    }

    /// spawn_upgrade MUST run the whitelist on the script path before
    /// even checking existence — a hostile path doesn't get to touch
    /// the filesystem.
    #[test]
    fn spawn_upgrade_refuses_hostile_script_path() {
        let bad = std::path::PathBuf::from(r"C:\foo'; calc; '\upgrade.ps1");
        let err = spawn_upgrade(&bad).unwrap_err();
        assert!(
            matches!(err, ServiceError::InvalidScriptPath(_)),
            "expected InvalidScriptPath, got {err:?}"
        );
    }

    /// Regression anchor: every Windows subprocess in this module must be
    /// spawned with `CREATE_NO_WINDOW`. The 1 Hz `sc query StavrDaemon`
    /// service poll runs in the background — without the flag it flashes a
    /// console window on the operator's desktop every tick ("the Governor
    /// spawns windows"). A future refactor adding a Windows `Command`
    /// without the flag re-introduces the bug; this scan catches it.
    ///
    /// Pure source scan — runs on every platform's CI, same pattern as
    /// `spawn_upgrade_on_windows_uses_runas_elevation`.
    #[test]
    fn windows_subprocesses_suppress_console_window() {
        let src = include_str!("service.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("service.rs non-test prelude");
        assert!(
            prod.contains("const CREATE_NO_WINDOW"),
            "service.rs must define the CREATE_NO_WINDOW flag"
        );
        assert!(
            prod.contains("use std::os::windows::process::CommandExt"),
            "service.rs must import CommandExt so creation_flags() resolves"
        );
        // The three Windows shell-outs — `sc query` (poll), the restart
        // PowerShell, the upgrade PowerShell — must each carry the flag.
        let flagged = prod.matches(".creation_flags(CREATE_NO_WINDOW)").count();
        assert!(
            flagged >= 3,
            "expected >=3 .creation_flags(CREATE_NO_WINDOW) calls \
             (sc query + restart + upgrade); found {flagged}"
        );
    }
}
