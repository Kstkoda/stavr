//! PM2 restart invoker.
//!
//! MVP path: shell out to `pm2 start ecosystem.config.cjs`. PM2 itself is the
//! actual process supervisor; Governor's job in v0.6.5 is to call PM2 when
//! the daemon is down, not to replace it (replacement is the v1.1+ scope per
//! ADR-040 / BOM line 67).
//!
//! Trait-abstracted so the supervisor can be unit-tested without spawning
//! real PM2 subprocesses.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum RestartError {
    #[error("failed to spawn pm2: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("pm2 exited with status {0}")]
    NonZeroExit(i32),
    #[error("pm2 not found on PATH — install with `npm i -g pm2`")]
    NotFound,
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
}
