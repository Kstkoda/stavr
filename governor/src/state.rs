//! Governor state machine.
//!
//! Pure data — no I/O, no Tauri, no threads. The supervisor module turns
//! probe results + clock ticks into state transitions by calling these
//! methods. This separation is what lets the state machine be exhaustively
//! unit-tested without spinning up a daemon or a Tauri runtime.
//!
//! BOM P2 spec:
//! - 5s health-poll cadence
//! - 3 consecutive failures (or 30s without a successful response) → `Down`
//! - On `Down`: trigger restart via PM2 with 1,2,4,8,16,32,60s exponential
//!   backoff (capped at 60s); after 5 restart attempts in any 5-minute window
//!   → `GiveUp`
//! - `StoppedManually` and `GiveUp` are operator-cleared (tray menu in P5)

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The states the Governor tracks for the daemon it supervises.
///
/// Variant order matters: `Default::default()` returns `Unknown`, which is
/// the correct pre-probe state before the first health check returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DaemonState {
    /// No probe has returned yet (initial state, or after Governor restart).
    #[default]
    Unknown,
    /// `/healthz` returned 200 within the last 10s.
    Healthy,
    /// `/healthz` returned non-200 OR last successful probe 10–30s ago.
    Degraded,
    /// No successful probe in >30s, or connection refused. Triggers restart.
    Down,
    /// PM2 restart in progress; suppresses further restart attempts until
    /// either the next health probe succeeds or the restart subprocess exits
    /// with failure.
    Restarting,
    /// Operator explicitly paused via tray menu (P5). Governor will not
    /// auto-restart while in this state.
    StoppedManually,
    /// More than 5 restart attempts in the last 5 minutes. Governor stops
    /// auto-restarting and shows red tray + operator-action-required toast.
    /// Cleared via the tray menu "Reset & Restart" item.
    GiveUp,
}

impl DaemonState {
    /// True if the operator must explicitly intervene to clear this state.
    /// Used by the supervisor loop to decide whether a probe failure should
    /// initiate a restart cascade.
    pub fn is_operator_held(self) -> bool {
        matches!(self, DaemonState::StoppedManually | DaemonState::GiveUp)
    }
}

/// A state transition, returned by `StateMachine::record_probe` and friends
/// so the supervisor loop can react (log, swap tray icon, fire toast).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateChange {
    pub from: DaemonState,
    pub to: DaemonState,
}

/// Outcome of one health probe attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// 2xx response, daemon is healthy.
    Ok,
    /// Reached the daemon but it returned non-2xx — daemon is alive but
    /// degraded.
    Unhealthy,
    /// Connection refused / timeout / DNS error — daemon may be down.
    Unreachable,
}

/// Backoff schedule for restart attempts, in seconds. Caps at 60s thereafter
/// (handled by `next_backoff_secs`).
pub const BACKOFF_SCHEDULE: [u64; 7] = [1, 2, 4, 8, 16, 32, 60];

/// Maximum restart attempts allowed in `GIVEUP_WINDOW` before transitioning
/// to `GiveUp` (BOM Hard rule #5).
pub const GIVEUP_THRESHOLD: usize = 5;

/// Sliding window for the `GIVEUP_THRESHOLD` counter.
pub const GIVEUP_WINDOW: Duration = Duration::from_secs(300);

/// After this many consecutive `Unreachable` probes, transition to `Down`.
pub const UNREACHABLE_TO_DOWN: u32 = 3;

/// Duration since last successful probe at which `Healthy` → `Degraded`.
pub const HEALTHY_TO_DEGRADED: Duration = Duration::from_secs(10);

/// Duration since last successful probe at which `Degraded` → `Down`.
pub const DEGRADED_TO_DOWN: Duration = Duration::from_secs(30);

/// Settle window after a fresh boot or restart during which the supervisor
/// will NOT promote the daemon to `Down`, even if probes are coming back
/// `Unreachable`. The daemon's normal cold-boot takes ~40s (the operator
/// observed 21:08:24 second-restart at +74s from a previous start in the
/// 2026-05-17 smoke test); 60s gives generous headroom without making
/// genuine outages slow to detect. Once the daemon has been `Healthy`
/// once after the most-recent boot/restart, the settle window no longer
/// applies — subsequent outages flip to `Down` per the normal rules.
///
/// Fix BOM v0.6.5 PR #34 amendment P3.
pub const SETTLE_WINDOW: Duration = Duration::from_secs(60);

/// Pure state machine. Construction takes the "now" timestamp so tests can
/// inject a deterministic start. All mutating methods take `now` for the
/// same reason — there is no internal clock.
#[derive(Debug)]
pub struct StateMachine {
    state: DaemonState,
    consecutive_unreachable: u32,
    last_probe: Option<Instant>,
    last_ok_probe: Option<Instant>,
    last_change: Instant,
    /// Restart-attempt timestamps within the last `GIVEUP_WINDOW`, oldest first.
    restart_attempts: VecDeque<Instant>,
    /// Index into `BACKOFF_SCHEDULE` for the next scheduled restart. Resets to
    /// 0 once the daemon becomes Healthy again.
    backoff_step: usize,
    /// When the supervisor itself booted. Cold-start reference for the
    /// settle window — if the daemon has never been `Healthy` yet, we
    /// measure "how long has it been starting?" from this point.
    boot_at: Instant,
    /// When `start_restart` last fired. The settle window resets here so
    /// every restart cycle gets fresh post-restart boot time before Down
    /// can kick in. `None` until the first restart attempt.
    last_restart_started_at: Option<Instant>,
    /// The most-recent transition INTO Healthy. Used to decide whether a
    /// future Unreachable probe should defer Down (post-cold-boot) or
    /// promote to Down (the daemon has already proven it can come up,
    /// so we trust the regular Degraded → Down detection).
    last_healthy_at: Option<Instant>,
    /// Settle-window duration override. Production uses `SETTLE_WINDOW`;
    /// tests can tighten or widen via `with_settle_window` to keep the
    /// suite fast and deterministic.
    settle_window: Duration,
}

impl StateMachine {
    pub fn new(now: Instant) -> Self {
        Self {
            state: DaemonState::Unknown,
            consecutive_unreachable: 0,
            last_probe: None,
            last_ok_probe: None,
            last_change: now,
            restart_attempts: VecDeque::new(),
            backoff_step: 0,
            boot_at: now,
            last_restart_started_at: None,
            last_healthy_at: None,
            settle_window: SETTLE_WINDOW,
        }
    }

    /// Builder-style settle-window override — tests use this to shrink the
    /// window from 60s to a few simulated seconds without losing realism.
    pub fn with_settle_window(mut self, window: Duration) -> Self {
        self.settle_window = window;
        self
    }

    pub fn settle_window(&self) -> Duration {
        self.settle_window
    }

    /// Most-recent moment we'd expect the daemon to be cold-booting. The
    /// settle window is measured from here.
    fn settle_reference(&self) -> Instant {
        self.last_restart_started_at
            .map(|r| r.max(self.boot_at))
            .unwrap_or(self.boot_at)
    }

    /// True if we should defer `Down` for now because we're still inside
    /// the settle window after a fresh boot or restart AND the daemon
    /// hasn't proven itself Healthy since that reference point.
    fn in_settle_window(&self, now: Instant) -> bool {
        // If the daemon has been Healthy since the last boot/restart, the
        // settle window is over — outages flip to Down per normal rules.
        if let Some(h) = self.last_healthy_at {
            if h >= self.settle_reference() {
                return false;
            }
        }
        now.saturating_duration_since(self.settle_reference()) < self.settle_window
    }

    /// Seconds we are into the settle window, or `None` if the window has
    /// closed (daemon was Healthy after the reference moment) or expired.
    /// Used by the tray tooltip to surface "Starting · 45s into settle
    /// window" so the operator can see that Governor is patiently waiting
    /// rather than flapping.
    pub fn settle_seconds_in(&self, now: Instant) -> Option<u64> {
        if !self.in_settle_window(now) {
            return None;
        }
        Some(
            now.saturating_duration_since(self.settle_reference())
                .as_secs(),
        )
    }

    pub fn state(&self) -> DaemonState {
        self.state
    }

    pub fn last_probe(&self) -> Option<Instant> {
        self.last_probe
    }

    pub fn last_ok_probe(&self) -> Option<Instant> {
        self.last_ok_probe
    }

    /// Total uptime computed against the most recent transition INTO Healthy.
    /// Returns None unless currently Healthy.
    pub fn uptime(&self, now: Instant) -> Option<Duration> {
        if self.state == DaemonState::Healthy {
            Some(now.saturating_duration_since(self.last_change))
        } else {
            None
        }
    }

    /// Duration the machine has been in its current state. Used for tooltip
    /// rendering in P3.
    pub fn time_in_state(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_change)
    }

    fn transition(&mut self, to: DaemonState, now: Instant) -> Option<StateChange> {
        if self.state == to {
            return None;
        }
        let change = StateChange {
            from: self.state,
            to,
        };
        self.state = to;
        self.last_change = now;
        if to == DaemonState::Healthy {
            self.consecutive_unreachable = 0;
            self.backoff_step = 0;
            // Record the settle-window exit point — subsequent outages
            // skip the settle deferment because the daemon has proven it
            // can come up.
            self.last_healthy_at = Some(now);
        }
        Some(change)
    }

    /// Record the result of a health probe. Returns Some(change) if the
    /// state transitioned as a result.
    pub fn record_probe(&mut self, outcome: ProbeOutcome, now: Instant) -> Option<StateChange> {
        self.last_probe = Some(now);

        if self.state.is_operator_held() {
            // Operator-held states ignore probes — operator must clear.
            return None;
        }

        match outcome {
            ProbeOutcome::Ok => {
                self.consecutive_unreachable = 0;
                self.last_ok_probe = Some(now);
                self.transition(DaemonState::Healthy, now)
            }
            ProbeOutcome::Unhealthy => {
                self.consecutive_unreachable = 0;
                self.transition(DaemonState::Degraded, now)
            }
            ProbeOutcome::Unreachable => {
                self.consecutive_unreachable =
                    self.consecutive_unreachable.saturating_add(1);
                // Two routes to Down: (a) N consecutive unreachable probes,
                // (b) more than DEGRADED_TO_DOWN since last good probe.
                let stale = self
                    .last_ok_probe
                    .map(|t| now.saturating_duration_since(t) > DEGRADED_TO_DOWN)
                    .unwrap_or(self.consecutive_unreachable >= UNREACHABLE_TO_DOWN);
                let promote_to_down =
                    self.consecutive_unreachable >= UNREACHABLE_TO_DOWN || stale;
                // Fix BOM P3: do NOT promote to Down while we're still
                // inside the settle window after a fresh boot or restart
                // (and the daemon has never been Healthy since). The 40s
                // cold-boot was being mistakenly read as a crash before
                // this gate landed.
                if promote_to_down && !self.in_settle_window(now) {
                    self.transition(DaemonState::Down, now)
                } else {
                    self.transition(DaemonState::Degraded, now)
                }
            }
        }
    }

    /// Mark a restart attempt as starting. Prunes the `GIVEUP_WINDOW` and
    /// transitions to `Restarting`. Returns the transition if any.
    ///
    /// If this attempt would be the (GIVEUP_THRESHOLD + 1)th within the
    /// window, transitions to `GiveUp` instead and returns that change —
    /// callers MUST NOT actually invoke the restarter when GiveUp is hit.
    pub fn start_restart(&mut self, now: Instant) -> Option<StateChange> {
        self.prune_attempts(now);
        if self.restart_attempts.len() >= GIVEUP_THRESHOLD {
            return self.transition(DaemonState::GiveUp, now);
        }
        self.restart_attempts.push_back(now);
        // Settle window resets on every fresh restart attempt — the daemon
        // is now in its cold-boot window again, so post-restart probes
        // should not flap to Down until the window expires.
        self.last_restart_started_at = Some(now);
        self.transition(DaemonState::Restarting, now)
    }

    /// Advance the backoff step after a restart attempt finishes (regardless
    /// of whether the daemon actually came back yet). Capped at the last
    /// schedule slot (60s).
    pub fn advance_backoff(&mut self) {
        if self.backoff_step + 1 < BACKOFF_SCHEDULE.len() {
            self.backoff_step += 1;
        }
    }

    /// Duration the supervisor should wait BEFORE the next restart attempt
    /// from the current state. The first attempt uses index 0 (1 second).
    pub fn next_backoff(&self) -> Duration {
        let secs = BACKOFF_SCHEDULE
            .get(self.backoff_step)
            .copied()
            .unwrap_or(60);
        Duration::from_secs(secs)
    }

    /// Drop restart-attempt timestamps older than `GIVEUP_WINDOW`.
    fn prune_attempts(&mut self, now: Instant) {
        while let Some(&front) = self.restart_attempts.front() {
            if now.saturating_duration_since(front) > GIVEUP_WINDOW {
                self.restart_attempts.pop_front();
            } else {
                break;
            }
        }
    }

    /// Operator pause (tray menu, P5). Suppresses further restarts.
    pub fn pause(&mut self, now: Instant) -> Option<StateChange> {
        self.transition(DaemonState::StoppedManually, now)
    }

    /// Operator clears GiveUp / pause and authorizes another restart attempt.
    /// Equivalent to a fresh boot: the GiveUp counter is cleared and the
    /// settle window starts over so the next batch of unreachable probes
    /// doesn't immediately trip Down again.
    pub fn reset(&mut self, now: Instant) -> Option<StateChange> {
        self.restart_attempts.clear();
        self.backoff_step = 0;
        self.consecutive_unreachable = 0;
        self.boot_at = now;
        self.last_restart_started_at = None;
        self.last_healthy_at = None;
        self.transition(DaemonState::Unknown, now)
    }

    /// Current restart-attempt counter inside the window. For tooltip text.
    pub fn restart_attempts_in_window(&self) -> usize {
        self.restart_attempts.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, offset_secs: u64) -> Instant {
        base + Duration::from_secs(offset_secs)
    }

    #[test]
    fn initial_state_is_unknown() {
        let now = Instant::now();
        let sm = StateMachine::new(now);
        assert_eq!(sm.state(), DaemonState::Unknown);
        assert!(sm.last_probe().is_none());
        assert!(sm.uptime(now).is_none());
    }

    #[test]
    fn ok_probe_transitions_unknown_to_healthy() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        let change = sm.record_probe(ProbeOutcome::Ok, at(now, 5));
        assert_eq!(
            change,
            Some(StateChange {
                from: DaemonState::Unknown,
                to: DaemonState::Healthy
            })
        );
        assert_eq!(sm.state(), DaemonState::Healthy);
        assert!(sm.uptime(at(now, 5)).is_some());
    }

    #[test]
    fn three_consecutive_unreachable_probes_become_down() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        sm.record_probe(ProbeOutcome::Ok, at(now, 0));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 5));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 10));
        let change = sm.record_probe(ProbeOutcome::Unreachable, at(now, 15));
        assert_eq!(
            change,
            Some(StateChange {
                from: DaemonState::Degraded,
                to: DaemonState::Down
            })
        );
        assert_eq!(sm.state(), DaemonState::Down);
    }

    #[test]
    fn unhealthy_probe_transitions_to_degraded() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        sm.record_probe(ProbeOutcome::Ok, at(now, 0));
        let change = sm.record_probe(ProbeOutcome::Unhealthy, at(now, 5));
        assert_eq!(
            change,
            Some(StateChange {
                from: DaemonState::Healthy,
                to: DaemonState::Degraded
            })
        );
    }

    #[test]
    fn ok_probe_after_unreachable_clears_streak() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        sm.record_probe(ProbeOutcome::Ok, at(now, 0));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 5));
        sm.record_probe(ProbeOutcome::Ok, at(now, 10));
        assert_eq!(sm.state(), DaemonState::Healthy);
        // streak reset means next 3 unreachable won't immediately flip to Down
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 15));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 20));
        assert_eq!(sm.state(), DaemonState::Degraded);
    }

    #[test]
    fn backoff_schedule_advances_then_caps_at_sixty() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        assert_eq!(sm.next_backoff(), Duration::from_secs(1));
        sm.advance_backoff();
        assert_eq!(sm.next_backoff(), Duration::from_secs(2));
        sm.advance_backoff();
        assert_eq!(sm.next_backoff(), Duration::from_secs(4));
        // Walk to the end of the schedule
        for _ in 0..20 {
            sm.advance_backoff();
        }
        assert_eq!(sm.next_backoff(), Duration::from_secs(60));
    }

    #[test]
    fn five_restart_attempts_in_window_triggers_giveup() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        for i in 0..5 {
            sm.start_restart(at(now, i * 10));
            // simulate restart finishing but daemon still down: we just call
            // start_restart again
        }
        // sixth attempt should transition to GiveUp instead of Restarting
        let change = sm.start_restart(at(now, 60));
        assert_eq!(sm.state(), DaemonState::GiveUp);
        assert_eq!(
            change,
            Some(StateChange {
                from: DaemonState::Restarting,
                to: DaemonState::GiveUp
            })
        );
    }

    #[test]
    fn old_restart_attempts_drop_out_of_window() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        for i in 0..5 {
            sm.start_restart(at(now, i * 10));
        }
        // After 5 attempts the SM is in Restarting. A 6th attempt before
        // the window prunes would flip to GiveUp.
        // 6 minutes later — window pruned, restart still allowed (stays
        // in Restarting; no transition because state already matches).
        sm.start_restart(at(now, 60 + 300 + 1));
        assert_eq!(sm.state(), DaemonState::Restarting);
        // Most of the old attempts pruned; at most 1 within the new window.
        assert!(
            sm.restart_attempts_in_window() < GIVEUP_THRESHOLD,
            "window did not prune; len = {}",
            sm.restart_attempts_in_window()
        );
    }

    #[test]
    fn operator_held_states_ignore_probes() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        sm.pause(now);
        assert_eq!(sm.state(), DaemonState::StoppedManually);
        let change = sm.record_probe(ProbeOutcome::Ok, at(now, 5));
        // probe noted but no transition
        assert!(change.is_none());
        assert_eq!(sm.state(), DaemonState::StoppedManually);
    }

    #[test]
    fn reset_clears_giveup_and_returns_to_unknown() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        for i in 0..6 {
            sm.start_restart(at(now, i * 10));
        }
        assert_eq!(sm.state(), DaemonState::GiveUp);
        sm.reset(at(now, 1000));
        assert_eq!(sm.state(), DaemonState::Unknown);
        assert_eq!(sm.restart_attempts_in_window(), 0);
        assert_eq!(sm.next_backoff(), Duration::from_secs(1));
    }

    #[test]
    fn stale_last_ok_probe_transitions_to_down_without_three_failures() {
        // Even with only 1 unreachable probe, if the last successful one is
        // older than DEGRADED_TO_DOWN we go straight to Down.
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        sm.record_probe(ProbeOutcome::Ok, at(now, 0));
        let change = sm.record_probe(ProbeOutcome::Unreachable, at(now, 35));
        assert_eq!(
            change,
            Some(StateChange {
                from: DaemonState::Healthy,
                to: DaemonState::Down
            })
        );
    }

    // ---- P3: settle window (Fix BOM v0.6.5 PR #34 amendment) -------------

    /// Cold-boot scenario: supervisor just started, daemon takes 50s to
    /// come up. The historical bug: 3 unreachable probes (~15s in) → Down
    /// → flap-restart of a healthy-but-starting daemon. With the settle
    /// window, the SM must stay in Degraded until the window expires.
    #[test]
    fn cold_boot_stays_degraded_within_settle_window() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        // Five unreachable probes during cold boot, all within the 60s
        // settle window.
        for sec in [5, 10, 15, 20, 25] {
            sm.record_probe(ProbeOutcome::Unreachable, at(now, sec));
        }
        assert_eq!(
            sm.state(),
            DaemonState::Degraded,
            "must NOT promote to Down during cold-boot settle window"
        );
        // Settle counter exposed for tooltip
        assert_eq!(sm.settle_seconds_in(at(now, 45)), Some(45));
    }

    /// Daemon takes 90s — past the 60s settle window. After the window
    /// expires, normal Down detection MUST kick in.
    #[test]
    fn cold_boot_promotes_to_down_after_settle_window_expires() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        // Probe at 65s — outside the 60s settle window
        let change = sm.record_probe(ProbeOutcome::Unreachable, at(now, 65));
        // Three failures via stale-last-ok path: last_ok_probe is None and
        // consecutive_unreachable starts at 1, but stale = (no last_ok_probe
        // ⇒ depends on consecutive_unreachable). Need 3 failures for that
        // branch; force 3 within the post-settle window.
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 66));
        let final_change = sm.record_probe(ProbeOutcome::Unreachable, at(now, 67));
        // Either of the latter two should have flipped to Down
        let final_state = sm.state();
        assert_eq!(final_state, DaemonState::Down);
        // First probe inside the settle deferral: change either None or
        // Unknown→Degraded.
        let _ = change;
        let _ = final_change;
    }

    /// After the daemon was Healthy ONCE, the settle window no longer
    /// applies — subsequent outages flip to Down per normal rules without
    /// waiting 60s.
    #[test]
    fn once_healthy_disables_settle_window_for_subsequent_outages() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        // Daemon comes up at 5s
        sm.record_probe(ProbeOutcome::Ok, at(now, 5));
        assert_eq!(sm.state(), DaemonState::Healthy);
        // Now three unreachable probes 6-8s in — would have been deferred
        // pre-fix, but settle window has already closed via last_healthy_at.
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 6));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 7));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 36));
        // The third probe at 36s has DEGRADED_TO_DOWN=30s elapsed since
        // last_ok at 5s → stale branch fires → Down.
        assert_eq!(sm.state(), DaemonState::Down);
    }

    /// Post-restart scenario: daemon was Healthy, then we restart (state
    /// reset to Restarting). The daemon takes ~40s to come up again. The
    /// settle window resets at restart time so the post-restart probes do
    /// not trip Down within the window.
    #[test]
    fn restart_resets_settle_window() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        // Day 1: daemon healthy at 5s
        sm.record_probe(ProbeOutcome::Ok, at(now, 5));
        // Operator restarts at 100s
        sm.start_restart(at(now, 100));
        assert_eq!(sm.state(), DaemonState::Restarting);
        // Probes at 105-130s come back unreachable (40s cold boot in
        // progress). With the post-restart settle window in effect, no
        // Down transition.
        for sec in [105, 110, 115, 120, 125, 130] {
            sm.record_probe(ProbeOutcome::Unreachable, at(now, sec));
        }
        assert_ne!(
            sm.state(),
            DaemonState::Down,
            "post-restart settle window must defer Down during cold-boot"
        );
        // settle_seconds_in is measured from the restart (100s), not boot.
        let into = sm.settle_seconds_in(at(now, 130));
        assert_eq!(into, Some(30));
    }

    /// Settle counter is None outside the window.
    #[test]
    fn settle_seconds_in_returns_none_after_window_expires() {
        let now = Instant::now();
        let sm = StateMachine::new(now);
        assert_eq!(sm.settle_seconds_in(at(now, 30)), Some(30));
        // At 61s, the 60s window has closed.
        assert_eq!(sm.settle_seconds_in(at(now, 61)), None);
    }

    /// Reset resurrects the settle window — operator-triggered "Reset &
    /// Restart" from GiveUp must give the daemon a fresh cold-boot grace
    /// period.
    #[test]
    fn reset_restores_settle_window_for_operator_recovery() {
        let now = Instant::now();
        let mut sm = StateMachine::new(now);
        // 5 attempts fill the window without flipping; the 6th transitions
        // to GiveUp per existing semantics.
        for sec in [0, 10, 20, 30, 40, 50] {
            sm.start_restart(at(now, sec));
        }
        assert_eq!(sm.state(), DaemonState::GiveUp);
        // Operator clicks Reset & Restart at 1000s
        sm.reset(at(now, 1000));
        assert_eq!(sm.state(), DaemonState::Unknown);
        // Now within 60s of the reset, settle window is active again
        assert!(sm.settle_seconds_in(at(now, 1030)).is_some());
        // And probes don't flap to Down within the settle period
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 1010));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 1020));
        sm.record_probe(ProbeOutcome::Unreachable, at(now, 1030));
        assert_ne!(sm.state(), DaemonState::Down);
    }

    /// Custom settle-window override for tests/embedded tunings.
    #[test]
    fn with_settle_window_overrides_default() {
        let now = Instant::now();
        let sm = StateMachine::new(now).with_settle_window(Duration::from_secs(5));
        assert_eq!(sm.settle_window(), Duration::from_secs(5));
        assert_eq!(sm.settle_seconds_in(at(now, 3)), Some(3));
        assert_eq!(sm.settle_seconds_in(at(now, 6)), None);
    }
}
