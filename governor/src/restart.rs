//! PM2 restart invoker.
//!
//! MVP path: shell out to `pm2 start ecosystem.config.cjs`. PM2 itself is the
//! actual process supervisor; Governor's job in v0.6.5 is to call PM2 when
//! the daemon is down, not to replace it (replacement is the v1.1+ scope per
//! ADR-040 / BOM line 67).
//!
//! Trait-abstracted so the supervisor can be unit-tested without spawning
//! real PM2 subprocesses.
//!
//! Bug fix (v0.6.5 PR #34 amendment P2): on Windows, `pm2 stop` does NOT
//! reliably terminate the underlying Node process — the daemon Node can
//! stay alive, holding port 7777, after PM2 reports it stopped. The next
//! `pm2 start` then refuses with "daemon already running (pid N on port
//! 7777)". `OrphanAwareRestarter` wraps a base `Restarter` and, on a
//! restart failure, probes port 7777 (or whatever port is configured) —
//! if a PID is listening, the orphan Node gets `taskkill /F`'d (or
//! `kill -9` on Unix) and the restart is retried.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use thiserror::Error;

use crate::port_check::PortChecker;

#[derive(Debug, Error)]
pub enum RestartError {
    #[error("failed to spawn pm2: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("pm2 exited with status {0}")]
    NonZeroExit(i32),
    #[error("pm2 not found on PATH — install with `npm i -g pm2`")]
    NotFound,
    /// Even after killing an orphan PID `max_iterations` times, the restart
    /// kept failing. Operator must intervene (something other than a Node
    /// orphan is holding the port).
    #[error("orphan-kill loop exhausted after {iterations} attempts on port {port} (last pid was {last_pid:?})")]
    OrphanKillExhausted {
        iterations: u32,
        port: u16,
        last_pid: Option<u32>,
    },
    /// Killing the orphan process itself failed (e.g., taskkill returned
    /// non-zero, kill -9 hit EPERM). The orphan is unkillable by Governor —
    /// operator intervention required.
    #[error("failed to kill orphan pid {pid}: {source}")]
    OrphanKillFailed {
        pid: u32,
        #[source]
        source: std::io::Error,
    },
}

/// Restart abstraction. Implementations: `Pm2Restarter` for production,
/// `MockRestarter` for tests.
pub trait Restarter: Send + Sync {
    /// Attempt to restart the daemon. Returns Ok if the restart subprocess
    /// returned success; the supervisor still has to wait for the next
    /// probe to confirm the daemon is actually healthy.
    fn restart(&self) -> Result<(), RestartError>;
}

/// Production implementation: shells out to PM2.
pub struct Pm2Restarter {
    /// Path to the PM2 ecosystem config (typically the repo's
    /// `ecosystem.config.cjs`). Resolved at construction time so the
    /// supervisor doesn't need to know the project layout.
    pub ecosystem_path: PathBuf,
    /// PM2 process name to manage. Defaults to "stavr" per the existing
    /// ecosystem config.
    pub process_name: String,
}

impl Pm2Restarter {
    pub fn new(ecosystem_path: PathBuf) -> Self {
        Self {
            ecosystem_path,
            process_name: "stavr".to_string(),
        }
    }
}

impl Restarter for Pm2Restarter {
    fn restart(&self) -> Result<(), RestartError> {
        // We use `pm2 start <ecosystem>` because it's idempotent: PM2 will
        // bring up the named process if it's not already running, and will
        // reload it if it is. `pm2 restart <name>` would fail when the
        // daemon entry has been deleted (which is the post-crash state in
        // some PM2-dump-corruption scenarios we've observed).
        //
        // CLAUDE.md note: `pm2 restart --update-env` does NOT reload
        // ecosystem.config.cjs — using `pm2 start ecosystem.config.cjs`
        // here gives us correct env reload semantics for free.
        let status = Command::new("pm2")
            .arg("start")
            .arg(&self.ecosystem_path)
            .arg("--only")
            .arg(&self.process_name)
            .status()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    RestartError::NotFound
                } else {
                    RestartError::Spawn(e)
                }
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(RestartError::NonZeroExit(status.code().unwrap_or(-1)))
        }
    }
}

/// Test double — counts invocations and returns a programmable result.
pub struct MockRestarter {
    invocations: AtomicU32,
    /// If true, restart() returns Ok. Otherwise NonZeroExit(1).
    pub succeed: bool,
}

impl MockRestarter {
    pub fn new(succeed: bool) -> Self {
        Self {
            invocations: AtomicU32::new(0),
            succeed,
        }
    }

    pub fn call_count(&self) -> u32 {
        self.invocations.load(Ordering::SeqCst)
    }
}

impl Restarter for MockRestarter {
    fn restart(&self) -> Result<(), RestartError> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
        if self.succeed {
            Ok(())
        } else {
            Err(RestartError::NonZeroExit(1))
        }
    }
}

/// Forcibly terminate a process by PID. Production calls the platform's
/// hard-kill (`taskkill /F /PID` on Windows; `kill -9` on Unix) — SIGTERM
/// is deliberately NOT used because the whole point of P2 is that SIGTERM
/// already failed (PM2's stop sends SIGTERM and the Node process didn't
/// exit; that's how we ended up with the orphan in the first place).
pub trait ProcessKiller: Send + Sync {
    fn kill(&self, pid: u32) -> std::io::Result<()>;
}

/// Production implementation — shells out to `taskkill` (Windows) or
/// `kill` (Unix). Both ship with the OS; no new deps.
pub struct SystemKiller;

impl ProcessKiller for SystemKiller {
    fn kill(&self, pid: u32) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            let status = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .status()?;
            if !status.success() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("taskkill /F /PID {pid} exited {}", status.code().unwrap_or(-1)),
                ));
            }
            Ok(())
        }
        #[cfg(unix)]
        {
            let status = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()?;
            if !status.success() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("kill -9 {pid} exited {}", status.code().unwrap_or(-1)),
                ));
            }
            Ok(())
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "process kill not implemented for this platform",
            ))
        }
    }
}

/// Test double — records every PID it was asked to kill and returns a
/// programmable result. `should_succeed` flips Ok / Err for the EPERM-style
/// path where the kill itself fails.
pub struct MockKiller {
    pub kills: parking_lot::Mutex<Vec<u32>>,
    pub should_succeed: bool,
}

impl MockKiller {
    pub fn new(should_succeed: bool) -> Self {
        Self {
            kills: parking_lot::Mutex::new(Vec::new()),
            should_succeed,
        }
    }
    pub fn killed(&self) -> Vec<u32> {
        self.kills.lock().clone()
    }
}

impl ProcessKiller for MockKiller {
    fn kill(&self, pid: u32) -> std::io::Result<()> {
        self.kills.lock().push(pid);
        if self.should_succeed {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "mock killer programmed to fail",
            ))
        }
    }
}

/// Orphan-aware restart driver. Calls `restarter.restart()`; on failure,
/// probes `port_checker` — if a PID is listening, asks `killer` to
/// terminate it and retries (up to `max_iterations`). On a clean port,
/// the original failure is returned (no orphan — something else is wrong).
///
/// Returns Ok(pid_killed_count) so callers can log how many orphans had
/// to be cleaned up (telemetry value for the v0.6.5 PR #2 dashboard).
pub fn restart_with_orphan_kill(
    restarter: &dyn Restarter,
    port_checker: &dyn PortChecker,
    killer: &dyn ProcessKiller,
    port: u16,
    max_iterations: u32,
) -> Result<u32, RestartError> {
    let mut iteration: u32 = 0;
    let mut killed: u32 = 0;
    let mut last_pid: Option<u32>;
    loop {
        iteration += 1;
        match restarter.restart() {
            Ok(()) => return Ok(killed),
            Err(original) => {
                // Probe the port. If clean, this isn't an orphan scenario —
                // surface the original error so the operator sees the real
                // reason (e.g., RestartError::NotFound from missing PM2).
                let Some(pid) = port_checker.pid_listening_on(port) else {
                    return Err(original);
                };
                last_pid = Some(pid);
                if let Err(e) = killer.kill(pid) {
                    return Err(RestartError::OrphanKillFailed { pid, source: e });
                }
                killed = killed.saturating_add(1);
                if iteration >= max_iterations {
                    return Err(RestartError::OrphanKillExhausted {
                        iterations: iteration,
                        port,
                        last_pid,
                    });
                }
                // loop continues — next restart() should succeed once the
                // orphan releases the port.
            }
        }
    }
}

/// `Restarter` adapter that applies the orphan-kill flow on every restart.
/// Wraps a base restarter (typically `Pm2Restarter`) with the port probe
/// and process killer. Plug into `Supervisor::new` instead of the raw
/// `Pm2Restarter` to get the new behavior end-to-end.
pub struct OrphanAwareRestarter {
    pub inner: Arc<dyn Restarter>,
    pub port_checker: Arc<dyn PortChecker>,
    pub killer: Arc<dyn ProcessKiller>,
    pub port: u16,
    pub max_iterations: u32,
}

impl OrphanAwareRestarter {
    /// Default `max_iterations` per the v0.6.5 fix BOM (P2): three tries.
    /// Two would be enough for the observed scenario; three gives one
    /// extra safety hop if a SECOND orphan rears up after the first kill.
    pub const DEFAULT_MAX_ITERATIONS: u32 = 3;
    /// Engine daemon's loopback port.
    pub const DEFAULT_DAEMON_PORT: u16 = 7777;

    pub fn new(
        inner: Arc<dyn Restarter>,
        port_checker: Arc<dyn PortChecker>,
        killer: Arc<dyn ProcessKiller>,
    ) -> Self {
        Self {
            inner,
            port_checker,
            killer,
            port: Self::DEFAULT_DAEMON_PORT,
            max_iterations: Self::DEFAULT_MAX_ITERATIONS,
        }
    }
}

impl Restarter for OrphanAwareRestarter {
    fn restart(&self) -> Result<(), RestartError> {
        restart_with_orphan_kill(
            self.inner.as_ref(),
            self.port_checker.as_ref(),
            self.killer.as_ref(),
            self.port,
            self.max_iterations,
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_restarter_counts_invocations() {
        let m = MockRestarter::new(true);
        assert_eq!(m.call_count(), 0);
        m.restart().unwrap();
        m.restart().unwrap();
        assert_eq!(m.call_count(), 2);
    }

    #[test]
    fn mock_restarter_failure_path_returns_nonzero_exit() {
        let m = MockRestarter::new(false);
        let err = m.restart().unwrap_err();
        assert!(matches!(err, RestartError::NonZeroExit(1)));
    }

    #[test]
    fn pm2_restarter_holds_ecosystem_path() {
        let r = Pm2Restarter::new(PathBuf::from("/tmp/ecosystem.config.cjs"));
        assert_eq!(r.process_name, "stavr");
        assert_eq!(
            r.ecosystem_path,
            PathBuf::from("/tmp/ecosystem.config.cjs")
        );
    }

    // ---- P2: orphan-kill flow ---------------------------------------------

    use crate::port_check::MockPortChecker;
    use parking_lot::Mutex;
    use std::collections::VecDeque;

    /// Test-only restarter that returns a programmable Ok/Err sequence so
    /// we can simulate "first call fails, second call succeeds once the
    /// orphan releases the port."
    struct SequenceRestarter {
        results: Mutex<VecDeque<Result<(), RestartError>>>,
        calls: AtomicU32,
    }

    impl SequenceRestarter {
        fn new(seq: Vec<Result<(), RestartError>>) -> Self {
            Self {
                results: Mutex::new(seq.into_iter().collect()),
                calls: AtomicU32::new(0),
            }
        }
        fn call_count(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Restarter for SequenceRestarter {
        fn restart(&self) -> Result<(), RestartError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.results
                .lock()
                .pop_front()
                .unwrap_or(Err(RestartError::NonZeroExit(1)))
        }
    }

    #[test]
    fn restart_with_orphan_kill_returns_ok_when_first_attempt_succeeds() {
        let r = SequenceRestarter::new(vec![Ok(())]);
        let p = MockPortChecker::new(None);
        let k = MockKiller::new(true);
        let killed = restart_with_orphan_kill(&r, &p, &k, 7777, 3).unwrap();
        assert_eq!(killed, 0);
        assert_eq!(r.call_count(), 1);
        assert_eq!(p.call_count(), 0, "port check should not run on clean restart");
        assert!(k.killed().is_empty(), "no kills expected when restart succeeds");
    }

    #[test]
    fn restart_with_orphan_kill_kills_zombie_then_succeeds() {
        // Simulate: first pm2 start fails (port held by orphan); after
        // taskkill the port frees and the second pm2 start succeeds.
        let r = SequenceRestarter::new(vec![
            Err(RestartError::NonZeroExit(1)),
            Ok(()),
        ]);
        let p = MockPortChecker::new(Some(12345));
        let k = MockKiller::new(true);
        let killed = restart_with_orphan_kill(&r, &p, &k, 7777, 3).unwrap();
        assert_eq!(killed, 1, "exactly one orphan should be killed");
        assert_eq!(k.killed(), vec![12345], "the listening PID should be killed");
        assert_eq!(r.call_count(), 2);
    }

    #[test]
    fn restart_with_orphan_kill_returns_original_error_when_port_is_clean() {
        // pm2 start failed but no orphan is on the port — that means the
        // failure is something else (e.g., ecosystem.config.cjs missing).
        // We must surface the ORIGINAL error so the operator sees the real
        // reason, not a misleading "orphan-kill exhausted".
        let r = SequenceRestarter::new(vec![Err(RestartError::NotFound)]);
        let p = MockPortChecker::new(None);
        let k = MockKiller::new(true);
        let err = restart_with_orphan_kill(&r, &p, &k, 7777, 3).unwrap_err();
        assert!(matches!(err, RestartError::NotFound), "got {err:?}");
        assert!(k.killed().is_empty(), "no kill expected on a clean port");
        assert_eq!(r.call_count(), 1);
    }

    #[test]
    fn restart_with_orphan_kill_surfaces_kill_failure() {
        // The kill itself fails (EPERM-style). Surface OrphanKillFailed so
        // the operator knows the orphan exists and Governor cannot remove
        // it — actionable info, not just a generic restart failure.
        let r = SequenceRestarter::new(vec![Err(RestartError::NonZeroExit(1))]);
        let p = MockPortChecker::new(Some(9999));
        let k = MockKiller::new(false);
        let err = restart_with_orphan_kill(&r, &p, &k, 7777, 3).unwrap_err();
        match err {
            RestartError::OrphanKillFailed { pid, .. } => assert_eq!(pid, 9999),
            other => panic!("expected OrphanKillFailed, got {other:?}"),
        }
    }

    #[test]
    fn restart_with_orphan_kill_exhausts_iterations_when_orphan_keeps_respawning() {
        // Pathological: every restart fails, and every probe finds a PID
        // (different zombies, or one that immediately respawns). Governor
        // must bail after max_iterations so we don't spin forever.
        let r = SequenceRestarter::new(vec![
            Err(RestartError::NonZeroExit(1)),
            Err(RestartError::NonZeroExit(1)),
            Err(RestartError::NonZeroExit(1)),
        ]);
        let p = MockPortChecker::new(Some(11111));
        let k = MockKiller::new(true);
        let err = restart_with_orphan_kill(&r, &p, &k, 7777, 3).unwrap_err();
        match err {
            RestartError::OrphanKillExhausted { iterations, port, last_pid } => {
                assert_eq!(iterations, 3);
                assert_eq!(port, 7777);
                assert_eq!(last_pid, Some(11111));
            }
            other => panic!("expected OrphanKillExhausted, got {other:?}"),
        }
        assert_eq!(k.killed().len(), 3, "killer invoked once per iteration");
        assert_eq!(r.call_count(), 3);
    }

    #[test]
    fn orphan_aware_restarter_implements_restarter_trait() {
        // The wrapper should be a drop-in `Arc<dyn Restarter>` so the
        // Supervisor can hold it without knowing about orphan-kill.
        let inner: Arc<dyn Restarter> = Arc::new(MockRestarter::new(true));
        let port_checker: Arc<dyn PortChecker> = Arc::new(MockPortChecker::new(None));
        let killer: Arc<dyn ProcessKiller> = Arc::new(MockKiller::new(true));
        let wrapper = OrphanAwareRestarter::new(inner, port_checker, killer);
        // Implements Restarter? — call `restart()` and confirm.
        let r: &dyn Restarter = &wrapper;
        r.restart().unwrap();
        assert_eq!(wrapper.port, OrphanAwareRestarter::DEFAULT_DAEMON_PORT);
        assert_eq!(
            wrapper.max_iterations,
            OrphanAwareRestarter::DEFAULT_MAX_ITERATIONS
        );
    }

    #[test]
    fn mock_killer_records_pids_in_order() {
        let k = MockKiller::new(true);
        k.kill(11).unwrap();
        k.kill(22).unwrap();
        k.kill(33).unwrap();
        assert_eq!(k.killed(), vec![11, 22, 33]);
    }
}
