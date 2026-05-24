//! Health monitor — probes `/healthz`, records the outcome on the state
//! machine, stops there.
//!
//! Phase 1 of the operator-companion refactor
//! (`proposed/governor-observe-only-bom.md`): the OS-native StavrDaemon service
//! (WinSW / systemd / launchd) is the sole supervisor for the daemon. The
//! Governor only observes — it has no code path that can restart the daemon on
//! its own. The legacy `Supervisor` / `restart.rs` / `port_check.rs` modules
//! were deleted in the same commit as this rewrite.
//!
//! Module name stays `supervisor` for now so the import surface in `main.rs`
//! and tests doesn't churn unnecessarily — the type that lives here is
//! `HealthMonitor`, which is what callers should reach for.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use thiserror::Error;

use crate::state::{ProbeOutcome, StateChange, StateMachine, SETTLE_WINDOW};

/// How often the monitor polls `/healthz` in production.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Default health-probe target — daemon HTTP server listens on 7777.
pub const DEFAULT_HEALTH_URL: &str = "http://127.0.0.1:7777/healthz";

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("http error: {0}")]
    Http(String),
}

/// Health-check abstraction. Production is a thin `ureq` GET; tests use
/// `MockProbe`.
pub trait HealthProbe: Send + Sync {
    fn probe(&self) -> ProbeOutcome;
}

/// Production probe via `ureq`. Short timeouts so the loop never blocks
/// longer than `POLL_INTERVAL`.
pub struct HttpProbe {
    pub url: String,
}

impl HttpProbe {
    pub fn new(url: impl Into<String>) -> Self {
        Self { url: url.into() }
    }
}

impl HealthProbe for HttpProbe {
    fn probe(&self) -> ProbeOutcome {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(1))
            .timeout_write(Duration::from_secs(1))
            .build();
        match agent.get(&self.url).call() {
            Ok(resp) if (200..300).contains(&resp.status()) => ProbeOutcome::Ok,
            Ok(_) => ProbeOutcome::Unhealthy,
            Err(ureq::Error::Status(_, _)) => ProbeOutcome::Unhealthy,
            Err(_) => ProbeOutcome::Unreachable,
        }
    }
}

/// Test double — returns a programmable sequence of outcomes.
pub struct MockProbe {
    sequence: Mutex<std::collections::VecDeque<ProbeOutcome>>,
    fallback: ProbeOutcome,
}

impl MockProbe {
    pub fn new(sequence: Vec<ProbeOutcome>, fallback: ProbeOutcome) -> Self {
        Self {
            sequence: Mutex::new(sequence.into_iter().collect()),
            fallback,
        }
    }

    pub fn always(outcome: ProbeOutcome) -> Self {
        Self::new(Vec::new(), outcome)
    }
}

impl HealthProbe for MockProbe {
    fn probe(&self) -> ProbeOutcome {
        self.sequence.lock().pop_front().unwrap_or(self.fallback)
    }
}

/// Clock abstraction. Production uses `std::time::Instant`; tests can step
/// a fake clock forward to exercise time-based transitions.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// Fixed clock for tests — advance manually via `set` or `advance`.
pub struct FakeClock {
    inner: Mutex<Instant>,
}
impl FakeClock {
    pub fn new(start: Instant) -> Self {
        Self {
            inner: Mutex::new(start),
        }
    }
    pub fn advance(&self, by: Duration) {
        let mut guard = self.inner.lock();
        *guard += by;
    }
    pub fn set(&self, at: Instant) {
        let mut guard = self.inner.lock();
        *guard = at;
    }
}
impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *self.inner.lock()
    }
}

/// Result of one monitor tick. Restart fields are gone; only the state
/// transition survives.
#[derive(Debug, Default, PartialEq)]
pub struct TickResult {
    pub state_change: Option<StateChange>,
}

/// Health monitor — probes the daemon, records outcomes on the state
/// machine, never restarts. Lives off the main thread; the OS service is
/// the only thing that can bounce the daemon.
pub struct HealthMonitor {
    state: Arc<Mutex<StateMachine>>,
    probe: Arc<dyn HealthProbe>,
    clock: Arc<dyn Clock>,
}

impl HealthMonitor {
    pub fn new(probe: Arc<dyn HealthProbe>, clock: Arc<dyn Clock>) -> Self {
        Self::with_settle_window(probe, clock, SETTLE_WINDOW)
    }

    pub fn with_settle_window(
        probe: Arc<dyn HealthProbe>,
        clock: Arc<dyn Clock>,
        settle_window: Duration,
    ) -> Self {
        let start = clock.now();
        Self {
            state: Arc::new(Mutex::new(
                StateMachine::new(start).with_settle_window(settle_window),
            )),
            probe,
            clock,
        }
    }

    /// Shared handle to the state machine. The tray watcher reads from this
    /// to drive icon swapping and tooltip rendering.
    pub fn state(&self) -> Arc<Mutex<StateMachine>> {
        self.state.clone()
    }

    /// One iteration of the monitor loop. Probes, records, returns what
    /// happened. No restart, no operator-action wiring.
    pub fn tick(&self) -> TickResult {
        let outcome = self.probe.probe();
        let now = self.clock.now();
        let change = {
            let mut sm = self.state.lock();
            sm.record_probe(outcome, now)
        };
        TickResult {
            state_change: change,
        }
    }

    /// Production loop — never returns. Spawn from a background thread.
    pub fn run_forever(&self) {
        log::info!("health monitor: starting poll loop ({:?})", POLL_INTERVAL);
        loop {
            let result = self.tick();
            if let Some(change) = &result.state_change {
                log::info!(
                    "health monitor: {:?} → {:?}",
                    change.from,
                    change.to
                );
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DaemonState;

    fn build(probe: MockProbe, clock: FakeClock) -> HealthMonitor {
        // Tests freeze the FakeClock, so a 60-second production settle
        // window would suppress every Down transition. Use a 0-duration
        // window for the same shape as the pre-settle behavior; the
        // dedicated settle-window test below opts back into a real window.
        HealthMonitor::with_settle_window(
            Arc::new(probe),
            Arc::new(clock) as Arc<dyn Clock>,
            Duration::from_secs(0),
        )
    }

    #[test]
    fn ok_probe_transitions_state_to_healthy() {
        let now = Instant::now();
        let mon = build(MockProbe::always(ProbeOutcome::Ok), FakeClock::new(now));
        let res = mon.tick();
        assert_eq!(res.state_change.map(|c| c.to), Some(DaemonState::Healthy));
        assert_eq!(mon.state().lock().state(), DaemonState::Healthy);
    }

    #[test]
    fn three_unreachable_probes_advance_to_down_without_restarting() {
        // The state machine still moves Healthy → Degraded → Down on a
        // streak; what the monitor must *not* do is trigger a restart in
        // response — the WinSW / systemd / launchd service owns recovery.
        let now = Instant::now();
        let probe = MockProbe::new(
            vec![
                ProbeOutcome::Ok,
                ProbeOutcome::Unreachable,
                ProbeOutcome::Unreachable,
                ProbeOutcome::Unreachable,
            ],
            ProbeOutcome::Unreachable,
        );
        let mon = build(probe, FakeClock::new(now));
        for _ in 0..4 {
            mon.tick();
        }
        assert_eq!(mon.state().lock().state(), DaemonState::Down);
    }

    #[test]
    fn settle_window_defers_down_during_cold_boot() {
        // Sanity: the settle-window plumbing still applies. With a non-zero
        // settle window and a frozen clock, Unreachable probes can't promote
        // to Down because no wall-clock time has elapsed since "boot".
        let now = Instant::now();
        let mon = HealthMonitor::with_settle_window(
            Arc::new(MockProbe::always(ProbeOutcome::Unreachable)),
            Arc::new(FakeClock::new(now)) as Arc<dyn Clock>,
            Duration::from_secs(60),
        );
        for _ in 0..10 {
            mon.tick();
        }
        assert_ne!(mon.state().lock().state(), DaemonState::Down);
    }

    /// Hard invariant: this crate must not link any restart capability into
    /// the `supervisor` module. Anchor checks for the deleted call sites so
    /// a future refactor can't quietly bring auto-restart back.
    #[test]
    fn no_restart_surface_in_supervisor_module() {
        let src = include_str!("supervisor.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("supervisor.rs should have a non-test prelude");
        for forbidden in [
            "Restarter",
            "MockRestarter",
            "Pm2Restarter",
            "SidecarRestarter",
            "OrphanAwareRestarter",
            "force_restart",
            "start_restart",
            "fn pause",
        ] {
            assert!(
                !prod.contains(forbidden),
                "supervisor.rs prod code must not mention {forbidden:?} after Phase 1 desupervision"
            );
        }
    }
}
