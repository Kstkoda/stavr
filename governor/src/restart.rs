//! Restart invokers.
//!
//! Two production implementations:
//!   - `Pm2Restarter` — shells out to `pm2 start ecosystem.config.cjs`.
//!     The dev-path supervisor: PM2 is the actual process manager and
//!     Governor calls into it when the daemon is down.
//!   - `SidecarRestarter` — launches the daemon SEA bundled by the Tauri
//!     installer (Phase 4 of family-mode-phase-2). Activates in installed
//!     mode; no PM2, no `npm install`. Governor is the supervisor.
//!
//! Trait-abstracted so the supervisor can be unit-tested without spawning
//! real subprocesses. `main.rs` chooses between the two at startup based
//! on whether a bundled sidecar binary is present.
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
    #[error("failed to spawn restart subprocess: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("restart subprocess exited with status {0}")]
    NonZeroExit(i32),
    #[error("pm2 not found on PATH — install with `npm i -g pm2`")]
    NotFound,
    /// SidecarRestarter could not find the bundled daemon binary at the
    /// configured path. Typically means main.rs's resolver flipped to
    /// sidecar mode based on env var or stale fixture, but the installer
    /// hadn't placed the binary yet.
    #[error("daemon sidecar binary missing at {path}")]
    SidecarMissing { path: PathBuf },
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

/// Production implementation for installed mode: launches the daemon
/// SEA that the Tauri installer placed alongside the Governor binary.
/// No PM2, no `npm install`, no `ecosystem.config.cjs` — Governor is the
/// only process the operator interacts with.
///
/// Wraps `std::process::Command::spawn()` against the bundled binary and
/// immediately detaches: the daemon continues running after the `Child`
/// handle is dropped. Confirmation of readiness is the supervisor's
/// next health-probe tick, same as the PM2 path.
///
/// Wrap with `OrphanAwareRestarter` for parity with the PM2 path on
/// Windows (where a previous Node may still hold port 7777 after a
/// crash — see ProcessKiller below).
pub struct SidecarRestarter {
    /// Absolute path to the bundled daemon binary. main.rs resolves this
    /// via `STAVR_DAEMON_SIDECAR_PATH` env var or
    /// `<exe-dir>/binaries/stavr-daemon[EXE_SUFFIX]`.
    pub binary_path: PathBuf,
    /// CLI args passed to the daemon. Mirrors `npm run start` which runs
    /// `dist/cli.js daemon start`. Customizable so tests can target a
    /// no-op binary.
    pub args: Vec<String>,
}

impl SidecarRestarter {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            binary_path,
            args: vec!["daemon".to_string(), "start".to_string()],
        }
    }

    /// Constructor for tests that need a specific argv (e.g. point at a
    /// system `true`/`cmd /c exit` to exercise the spawn path).
    pub fn with_args(binary_path: PathBuf, args: Vec<String>) -> Self {
        Self { binary_path, args }
    }
}

impl Restarter for SidecarRestarter {
    fn restart(&self) -> Result<(), RestartError> {
        if !self.binary_path.exists() {
            return Err(RestartError::SidecarMissing {
                path: self.binary_path.clone(),
            });
        }
        let child = Command::new(&self.binary_path)
            .args(&self.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    RestartError::SidecarMissing {
                        path: self.binary_path.clone(),
                    }
                } else {
                    RestartError::Spawn(e)
                }
            })?;
        // Detach: drop the `Child` so the subprocess is not waited on.
        // The daemon is long-lived; readiness is signalled via the
        // supervisor's HTTP health probe on the next tick.
        log::info!("sidecar restart: spawned pid {}", child.id());
        drop(child);
        Ok(())
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

    // ---- Phase 4: SidecarRestarter ---------------------------------------

    #[test]
    fn sidecar_restarter_defaults_to_daemon_start_args() {
        let r = SidecarRestarter::new(PathBuf::from("/nonexistent/stavr-daemon"));
        assert_eq!(r.args, vec!["daemon".to_string(), "start".to_string()]);
    }

    #[test]
    fn sidecar_restarter_returns_sidecar_missing_for_absent_path() {
        // The resolver in main.rs only constructs SidecarRestarter when
        // the path exists, but a race between resolver and restart (e.g.
        // uninstall while Governor is running, or an env-var override
        // pointing at a stale path) must surface a clear, actionable
        // error — not a generic Spawn(ENOENT).
        let path = PathBuf::from("/this/path/does/not/exist/stavr-daemon");
        let r = SidecarRestarter::new(path.clone());
        let err = r.restart().unwrap_err();
        match err {
            RestartError::SidecarMissing { path: p } => assert_eq!(p, path),
            other => panic!("expected SidecarMissing, got {other:?}"),
        }
    }

    /// Round-trip sanity: spawn a no-op system binary and confirm the
    /// detached spawn returns Ok. We use `true` (Unix) / `cmd.exe /c exit`
    /// (Windows) which exit immediately — proves the spawn path works
    /// without depending on a stavR-specific binary.
    #[test]
    #[cfg(unix)]
    fn sidecar_restarter_spawns_existing_binary_on_unix() {
        // `/usr/bin/true` exists on both Linux and macOS (`/bin/true`
        // is Linux-only); exits 0 immediately.
        let r = SidecarRestarter::with_args(PathBuf::from("/usr/bin/true"), vec![]);
        r.restart().expect("spawn of /usr/bin/true should succeed");
    }

    #[test]
    #[cfg(windows)]
    fn sidecar_restarter_spawns_existing_binary_on_windows() {
        // cmd.exe ships with every Windows install. `/c exit` exits 0.
        let cmd = PathBuf::from("C:\\Windows\\System32\\cmd.exe");
        let r = SidecarRestarter::with_args(
            cmd,
            vec!["/c".to_string(), "exit".to_string()],
        );
        r.restart().expect("spawn of cmd.exe should succeed");
    }

    /// The wrapper should be a drop-in `Arc<dyn Restarter>` so the
    /// Supervisor can hold it without knowing about the sidecar path
    /// (mirror of the OrphanAwareRestarter trait-object test).
    #[test]
    fn sidecar_restarter_implements_restarter_trait() {
        let r: Arc<dyn Restarter> =
            Arc::new(SidecarRestarter::new(PathBuf::from("/nonexistent")));
        // Reaching this line confirms the trait bound holds at compile
        // time; calling restart() is the SidecarMissing-error path which
        // we already test above.
        let _ = r.restart();
    }
}
