//! Cross-platform "which PID is listening on this TCP port?" probe.
//!
//! Windows `pm2 stop` (and the operator's manual stops) routinely leak the
//! underlying Node process: PM2's bookkeeping says "stopped" but the Node
//! daemon is still alive, still holding port 7777. The next `pm2 start`
//! then refuses with "daemon already running (pid N on port 7777)" because
//! PM2 sees something bound to the port. The Governor needs to detect this
//! scenario and `taskkill /F` the orphan so the next restart attempt
//! succeeds. This module is the detection half; `restart::ProcessKiller`
//! is the kill half.
//!
//! Bug context: 2026-05-17 21:00 GST smoke test (v0.6.5 PR #34 amendment P2).
//!
//! Design notes:
//! - Production implementation shells out to the platform's standard tool
//!   (`netstat`/`lsof`/`ss`) — no new dependencies. PIDs come back as
//!   plain `u32`, which is the form `taskkill` / `kill -9` consume.
//! - The parsers are pulled out as public free functions and unit-tested
//!   with fixture strings on every platform, so a Linux CI run can still
//!   validate the Windows `netstat` parser.
//! - `PortChecker` trait + `SystemPortChecker` impl give us injection points
//!   for the orphan-kill flow tests.

#[cfg(any(windows, unix))]
use std::process::Command;

/// PID-listening-on-port probe. Production implementation shells out to
/// platform-specific tooling; tests inject a deterministic fake.
pub trait PortChecker: Send + Sync {
    /// Return `Some(pid)` if a process holds the listening end of `port`
    /// on the loopback (127.0.0.1) or wildcard interface. `None` if the
    /// port is free or detection isn't supported on this platform.
    fn pid_listening_on(&self, port: u16) -> Option<u32>;
}

/// Production probe — invokes the platform's bundled tool.
pub struct SystemPortChecker;

impl PortChecker for SystemPortChecker {
    fn pid_listening_on(&self, port: u16) -> Option<u32> {
        #[cfg(windows)]
        {
            return windows_pid(port);
        }
        #[cfg(target_os = "linux")]
        {
            return linux_pid(port);
        }
        #[cfg(target_os = "macos")]
        {
            return macos_pid(port);
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = port; // suppress unused-var warning on bare-metal builds
            None
        }
    }
}

#[cfg(windows)]
fn windows_pid(port: u16) -> Option<u32> {
    // `netstat -ano` is shipped with every Windows install; no extra deps.
    let out = Command::new("netstat").args(["-ano", "-p", "tcp"]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    parse_netstat_ano(&s, port)
}

#[cfg(target_os = "linux")]
fn linux_pid(port: u16) -> Option<u32> {
    // Try ss first (typically faster, always present on systemd distros).
    if let Ok(out) = Command::new("ss").args(["-tlnp"]).output() {
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(pid) = parse_ss_tlnp(&s, port) {
            return Some(pid);
        }
    }
    // Fallback: lsof -i :PORT -t prints just the PID(s)
    if let Ok(out) = Command::new("lsof").args(["-i", &format!(":{port}"), "-t"]).output() {
        let s = String::from_utf8_lossy(&out.stdout);
        return parse_lsof_t(&s);
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_pid(port: u16) -> Option<u32> {
    // macOS ships lsof; `lsof -i :PORT -t` returns one PID per line.
    let out = Command::new("lsof").args(["-i", &format!(":{port}"), "-t"]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    parse_lsof_t(&s)
}

/// Parse `netstat -ano` output for a TCP LISTENING entry on `port`.
///
/// Typical Windows line shape (whitespace-padded columns):
///
/// ```text
///   Proto  Local Address          Foreign Address        State           PID
///   TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       12345
/// ```
///
/// IPv6 form: `TCP    [::1]:7777   [::]:0   LISTENING   12345`. The trick
/// is that the address column may also contain an IPv6 literal in
/// brackets, so we walk from the right end of the second column to find
/// the `:port` suffix.
pub fn parse_netstat_ano(output: &str, port: u16) -> Option<u32> {
    let want = port.to_string();
    for line in output.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("TCP") {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        // expect at least: TCP, local, foreign, STATE, PID
        if cols.len() < 5 {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let local = cols[1];
        // last ":" splits port from address (works for v4 and bracketed v6)
        let port_part = local.rsplit(':').next()?;
        if port_part == want {
            return cols[4].parse().ok();
        }
    }
    None
}

/// Parse `lsof -i :PORT -t` output. The `-t` switch prints terse PID-only
/// output, one PID per line. We take the first.
pub fn parse_lsof_t(output: &str) -> Option<u32> {
    output
        .lines()
        .find_map(|l| l.trim().parse::<u32>().ok())
}

/// Parse Linux `ss -tlnp` output for a LISTEN entry on `port`.
///
/// Typical line:
///
/// ```text
/// LISTEN 0 511 127.0.0.1:7777 0.0.0.0:* users:(("node",pid=12345,fd=23))
/// ```
///
/// Multiple `pid=N` substrings can appear if the listener has multiple
/// fds — we take the first; orphan-kill semantics are based on owning PID
/// which is consistent across fds.
pub fn parse_ss_tlnp(output: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    for line in output.lines() {
        if !line.trim_start().starts_with("LISTEN") {
            continue;
        }
        let has_port = line
            .split_whitespace()
            .any(|tok| tok.ends_with(&suffix));
        if !has_port {
            continue;
        }
        if let Some(idx) = line.find("pid=") {
            let rest = &line[idx + 4..];
            let pid_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            return pid_str.parse().ok();
        }
    }
    None
}

/// Test double — returns a programmable PID (or None).
pub struct MockPortChecker {
    response: parking_lot::Mutex<Option<u32>>,
    pub calls: std::sync::atomic::AtomicU32,
}

impl MockPortChecker {
    pub fn new(initial: Option<u32>) -> Self {
        Self {
            response: parking_lot::Mutex::new(initial),
            calls: std::sync::atomic::AtomicU32::new(0),
        }
    }
    /// Programmatically swap the next-call response — used to simulate
    /// "port held by zombie, then cleared after kill".
    pub fn set(&self, next: Option<u32>) {
        *self.response.lock() = next;
    }
    pub fn call_count(&self) -> u32 {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl PortChecker for MockPortChecker {
    fn pid_listening_on(&self, _port: u16) -> Option<u32> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.response.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Windows: netstat -ano parser -------------------------------------

    #[test]
    fn parse_netstat_ano_finds_listening_pid_ipv4() {
        let fixture = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4\r\n  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       12345\r\n  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       9876\r\n";
        assert_eq!(parse_netstat_ano(fixture, 7777), Some(12345));
        assert_eq!(parse_netstat_ano(fixture, 5037), Some(9876));
        assert_eq!(parse_netstat_ano(fixture, 6000), None);
    }

    #[test]
    fn parse_netstat_ano_skips_non_listening_rows() {
        let fixture = "  TCP    127.0.0.1:7777   192.168.1.10:55512   ESTABLISHED   12345\r\n  TCP    127.0.0.1:7777   0.0.0.0:0   LISTENING   99999\r\n";
        // The ESTABLISHED row must NOT win — we only orphan-kill the listener.
        assert_eq!(parse_netstat_ano(fixture, 7777), Some(99999));
    }

    #[test]
    fn parse_netstat_ano_handles_ipv6_listener() {
        let fixture = "  TCP    [::1]:7777                                   [::]:0                              LISTENING       54321\r\n";
        assert_eq!(parse_netstat_ano(fixture, 7777), Some(54321));
    }

    #[test]
    fn parse_netstat_ano_returns_none_for_empty() {
        assert_eq!(parse_netstat_ano("", 7777), None);
    }

    // ---- macOS / Linux fallback: lsof -t parser ---------------------------

    #[test]
    fn parse_lsof_t_takes_first_pid() {
        assert_eq!(parse_lsof_t("12345\n"), Some(12345));
        assert_eq!(parse_lsof_t("12345\n67890\n"), Some(12345));
        assert_eq!(parse_lsof_t(""), None);
        assert_eq!(parse_lsof_t("\n"), None);
    }

    // ---- Linux: ss -tlnp parser -------------------------------------------

    #[test]
    fn parse_ss_tlnp_extracts_pid_for_listener() {
        let fixture = "State    Recv-Q Send-Q Local Address:Port   Peer Address:Port   Process\nLISTEN   0      511    127.0.0.1:7777       0.0.0.0:*           users:((\"node\",pid=12345,fd=23))\nLISTEN   0      128    0.0.0.0:22           0.0.0.0:*           users:((\"sshd\",pid=901,fd=3))\n";
        assert_eq!(parse_ss_tlnp(fixture, 7777), Some(12345));
        assert_eq!(parse_ss_tlnp(fixture, 22), Some(901));
        assert_eq!(parse_ss_tlnp(fixture, 9999), None);
    }

    #[test]
    fn parse_ss_tlnp_handles_ipv6_bracketed_address() {
        let fixture = "LISTEN   0      511   [::1]:7777   [::]:*   users:((\"node\",pid=12345,fd=23))\n";
        assert_eq!(parse_ss_tlnp(fixture, 7777), Some(12345));
    }

    #[test]
    fn parse_ss_tlnp_returns_none_when_no_pid_attached() {
        // ss without `-p` won't expose pid=; the parser should noop, not crash.
        let fixture = "LISTEN   0      511   127.0.0.1:7777   0.0.0.0:*\n";
        assert_eq!(parse_ss_tlnp(fixture, 7777), None);
    }

    // ---- Mock checker -----------------------------------------------------

    #[test]
    fn mock_port_checker_returns_programmed_pid_and_counts() {
        let m = MockPortChecker::new(Some(42));
        assert_eq!(m.pid_listening_on(7777), Some(42));
        assert_eq!(m.pid_listening_on(7777), Some(42));
        assert_eq!(m.call_count(), 2);
        m.set(None);
        assert_eq!(m.pid_listening_on(7777), None);
        assert_eq!(m.call_count(), 3);
    }
}
