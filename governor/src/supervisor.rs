//! Supervisor loop — glues the state machine to the health probe and the
//! restarter. The production loop runs every `POLL_INTERVAL` and:
//!   1. Issues an HTTP GET to `/healthz`
//!   2. Records the outcome on the state machine
//!   3. If state is `Down` and not operator-held, triggers a restart
//!
//! Trait abstractions (`HealthProbe`, `Restarter`, `Clock`) make every step
//! injectable for tests. `tick()` is the unit of behavior — `run_forever`
//! just calls `tick()` in a thread loop.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use thiserror::Error;

use crate::restart::{RestartError, Restarter};
use crate::state::{DaemonState, ProbeOutcome, StateChange, StateMachine};

/// How often the supervisor polls `/healthz` in production. Tests can drive
/// `tick()` synchronously and ignore this.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Default health-probe target — Engine's HTTP server listens on 7777.
pub const DEFAULT_HEALTH_URL: &str = "http://127.0.0.1:7777/healthz";

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("http error: {0}")]
    Http(String),
}

/// Health-check abstraction. Production is a thin ureq GET; tests use
/// `MockProbe`.
pub trait HealthProbe: Send + Sync {
    fn probe(&self) -> ProbeOutcome;
}

/// Production probe via `ureq`. Short timeouts so the loop never blocks
/// longer than POLL_INTERVAL.
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
    /// Outcome to repeat once the queued sequence is exhausted.
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

/// Fixed clock for tests — advance manually via `set`.
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

/// Result of one supervisor `tick`. Useful as a return value so tests can
/// assert on what happened that iteration without scraping logs.
#[derive(Debug, Default, PartialEq)]
pub struct TickResult {
    pub state_change: Option<StateChange>,
    pub restart_attempted: bool,
    pub restart_result: Option<Result<(), String>>,
}

/// The Governor's supervision orchestrator. Owns the state machine and the
/// injected probe/restarter/clock. Tray and Tauri concerns live elsewhere.
pub struct Supervisor {
    state: Arc<Mutex<StateMachine>>,
    probe: Arc<dyn HealthProbe>,
    restarter: Arc<dyn Restarter>,
    clock: Arc<dyn Clock>,
}

impl Supervisor {
    pub fn new(
        probe: Arc<dyn HealthProbe>,
        restarter: Arc<dyn Restarter>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let start = clock.now();
        Self {
            state: Arc::new(Mutex::new(StateMachine::new(start))),
            probe,
            restarter,
            clock,
        }
    }

    /// Shared handle to the state machine. The tray module (P3) reads from
    /// this to drive icon swapping; the operator-action paths (P5) write to
    /// it via `pause` / `reset`.
    pub fn state(&self) -> Arc<Mutex<StateMachine>> {
        self.state.clone()
    }

    /// One iteration of the supervision loop. Returns what happened.
    pub fn tick(&self) -> TickResult {
        let outcome = self.probe.probe();
        let now = self.clock.now();

        let mut result = TickResult::default();
        {
            let mut sm = self.state.lock();
            result.state_change = sm.record_probe(outcome, now);
        }

        // Decide whether to restart. We do this OUTSIDE the lock-on-state
        // because restarter.restart() can block on subprocess I/O and we
        // don't want to hold the state lock across that.
        let should_restart = {
            let sm = self.state.lock();
            sm.state() == DaemonState::Down && !sm.state().is_operator_held()
        };

        if should_restart {
            // start_restart transitions to Restarting (or GiveUp if too many
            // attempts in window). If GiveUp, we don't actually invoke the
            // restarter.
            let transition = {
                let mut sm = self.state.lock();
                sm.start_restart(now)
            };
            if let Some(change) = transition {
                // Replace the probe-derived change with the restart-trigger one;
                // tests usually care about the latter when it occurs.
                result.state_change = Some(change.clone());
                if change.to == DaemonState::Restarting {
                    result.restart_attempted = true;
                    let r = self
                        .restarter
                        .restart()
                        .map_err(|e: RestartError| e.to_string());
                    let mut sm = self.state.lock();
                    sm.advance_backoff();
                    result.restart_result = Some(r);
                }
            }
        }

        result
    }

    /// Production loop — never returns. Spawn from a background thread.
    pub fn run_forever(&self) {
        log::info!("supervisor: starting poll loop ({:?})", POLL_INTERVAL);
        loop {
            let result = self.tick();
            if let Some(change) = &result.state_change {
                log::info!(
                    "supervisor: {:?} → {:?}",
                    change.from,
                    change.to
                );
            }
            if let Some(r) = &result.restart_result {
                match r {
                    Ok(_) => log::info!("supervisor: pm2 restart returned ok"),
                    Err(e) => log::warn!("supervisor: pm2 restart failed: {e}"),
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::restart::MockRestarter;
    use crate::state::DaemonState;
    use std::time::Instant;

    fn build(
        probe: MockProbe,
        restarter: MockRestarter,
        clock: FakeClock,
    ) -> (Supervisor, Arc<MockRestarter>) {
        let r = Arc::new(restarter);
        let sup = Supervisor::new(
            Arc::new(probe),
            r.clone() as Arc<dyn Restarter>,
            Arc::new(clock) as Arc<dyn Clock>,
        );
        (sup, r)
    }

    #[test]
    fn tick_with_ok_probe_results_in_healthy() {
        let now = Instant::now();
        let probe = MockProbe::always(ProbeOutcome::Ok);
        let restarter = MockRestarter::new(true);
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        let res = sup.tick();
        assert_eq!(
            res.state_change.map(|c| c.to),
            Some(DaemonState::Healthy)
        );
        assert!(!res.restart_attempted);
        assert_eq!(r.call_count(), 0);
    }

    #[test]
    fn three_unreachable_ticks_trigger_restart() {
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
        let restarter = MockRestarter::new(true);
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        sup.tick();
        assert_eq!(r.call_count(), 0);
        sup.tick();
        sup.tick();
        // After the third unreachable tick the SM is Down and the tick
        // logic invokes the restarter in the same iteration.
        sup.tick();
        assert_eq!(r.call_count(), 1);
    }

    #[test]
    fn restart_attempts_advance_backoff() {
        let now = Instant::now();
        // Always unreachable
        let probe = MockProbe::always(ProbeOutcome::Unreachable);
        let restarter = MockRestarter::new(false); // restart subprocess fails
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        // First three ticks accumulate failures and trigger first restart
        sup.tick();
        sup.tick();
        sup.tick();
        assert_eq!(r.call_count(), 1);
        let backoff_after_one = sup.state().lock().next_backoff();
        assert_eq!(backoff_after_one, Duration::from_secs(2));

        sup.tick();
        assert_eq!(r.call_count(), 2);
        let backoff_after_two = sup.state().lock().next_backoff();
        assert_eq!(backoff_after_two, Duration::from_secs(4));
    }

    #[test]
    fn giveup_after_five_attempts_in_window() {
        let now = Instant::now();
        let probe = MockProbe::always(ProbeOutcome::Unreachable);
        let restarter = MockRestarter::new(false);
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        // Force 5 restart attempts. Each tick that finds Down does one.
        // The first 3 ticks push the SM to Down; subsequent ticks restart.
        for _ in 0..3 {
            sup.tick();
        }
        // 1 attempt made; do 4 more
        for _ in 0..4 {
            sup.tick();
        }
        // 5 attempts so far. The next tick that would have been the 6th
        // restart transitions to GiveUp instead.
        sup.tick();
        let final_state = sup.state().lock().state();
        assert_eq!(final_state, DaemonState::GiveUp);
        assert_eq!(r.call_count(), 5);
    }

    #[test]
    fn paused_state_suppresses_restart() {
        let now = Instant::now();
        let probe = MockProbe::always(ProbeOutcome::Unreachable);
        let restarter = MockRestarter::new(true);
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        {
            let sm = sup.state();
            sm.lock().pause(now);
        }
        for _ in 0..5 {
            sup.tick();
        }
        assert_eq!(
            sup.state().lock().state(),
            DaemonState::StoppedManually
        );
        assert_eq!(r.call_count(), 0);
    }

    #[test]
    fn reset_clears_giveup_and_allows_restart_again() {
        let now = Instant::now();
        let probe = MockProbe::always(ProbeOutcome::Unreachable);
        let restarter = MockRestarter::new(false);
        let clock = FakeClock::new(now);
        let (sup, r) = build(probe, restarter, clock);

        for _ in 0..8 {
            sup.tick();
        }
        assert_eq!(sup.state().lock().state(), DaemonState::GiveUp);
        let attempts_before = r.call_count();

        {
            let sm = sup.state();
            sm.lock().reset(now);
        }
        // After reset, the next batch of unreachable ticks should attempt
        // a new restart.
        for _ in 0..4 {
            sup.tick();
        }
        assert!(
            r.call_count() > attempts_before,
            "reset should allow new restart attempts; before={}, after={}",
            attempts_before,
            r.call_count()
        );
    }
}
