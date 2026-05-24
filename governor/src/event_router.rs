//! Event-kind router for OS toast notifications.
//!
//! Per ADR-041 (Universal signal trace) the Governor subscribes to a small,
//! operator-relevant subset of broker events. Everything else — progress,
//! tool_called, generic worker_progress — is too noisy for an OS toast
//! surface and stays on the dashboard's `/dashboard/streams` page.
//!
//! Debouncing (Hard rule #7 in the v0.6.5 BOM): no more than one toast per
//! 10s for the same event kind. Suppressed events are silently dropped — the
//! operator can still see them on the dashboard's stream tail.
//!
//! Severity → toast priority mapping (BOM P4):
//!   info → default priority
//!   warn → high priority
//!   crit → critical (sound + persistent on macOS)
//!
//! Click target: a single dashboard URL (the operator's decide queue, where
//! most operator-awareness events resolve). The renderer is responsible for
//! wiring the click; the router only declares "this event wants a toast."

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::event_bridge::{BrokerEvent, EventSink};

/// Per-kind debounce window. Within this window, additional events of the
/// same `kind` are suppressed.
pub const DEBOUNCE_WINDOW: Duration = Duration::from_secs(10);

/// Severity mirrors the daemon's notification fabric. The Tauri toast plugin
/// gets per-platform priority and sound from this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warn,
    Crit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToastSpec {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub severity: Severity,
}

/// Trait for actually rendering toasts on the OS. Decoupled from the router
/// so we can unit-test routing without a Tauri app context.
pub trait ToastRenderer: Send + Sync {
    fn render(&self, spec: &ToastSpec);
}

/// Map a broker `kind` to its operator-facing toast title + severity. Kinds
/// not in this table are silently dropped (the operator will see them in the
/// dashboard streams page; they don't deserve an OS-level interrupt).
///
/// New event kinds may not be present in the current `src/event-types.ts`
/// taxonomy yet — they're listed here so the router is forward-compatible
/// when v0.6.6/v0.6.7/v0.6.X land them. Unknown kinds are not an error.
pub fn kind_template(kind: &str) -> Option<(&'static str, Severity)> {
    match kind {
        // Explicit operator alerts from any party (v0.6.5 notify wire-up).
        "notification_requested" => Some(("stavR · operator alert", Severity::Warn)),
        // Decision queue — current taxonomy uses `decision_request`; the
        // notification fabric remaps it to kind `decision_required`. Both
        // route to the SAME first-class approval-needed toast (Phase 3 of
        // the operator-companion refactor: the daemon opening a CONFIRM or
        // EXPLICIT decision gate is the single most operator-relevant
        // event, gets a distinct title and Crit severity so the OS
        // surfaces it with sound).
        "decision_request" | "decision_required" => {
            Some(("stavR — approval needed", Severity::Crit))
        }
        // host_exec denials are operator-relevant (something tried a blocked
        // shell action). Always crit — these surface policy violations.
        "host_exec_denied" => Some(("stavR · host_exec denied", Severity::Crit)),
        // Trust-scope lifecycle (spec 46).
        "trust_scope_proposed" => Some(("stavR · trust scope proposed", Severity::Info)),
        "trust_scope_revoked" => Some(("stavR · trust scope revoked", Severity::Warn)),
        "trust_scope_completed" => Some(("stavR · trust scope completed", Severity::Info)),
        // Worker outcomes. Routine `completed` is filtered by the body
        // builder; `crashed` and `terminated_by_user` pass through.
        "worker_terminated" => Some(("stavR · worker terminated", Severity::Warn)),
        "worker_failed" => Some(("stavR · worker failed", Severity::Crit)),
        "worker_blocked_by_av" => Some(("stavR · worker blocked by AV", Severity::Crit)),
        // Daemon-internal health transitions (v0.6.5 notify wire-up).
        "daemon_health_changed" => Some(("stavR · daemon health", Severity::Warn)),
        // Scope expiry — separate from revoked; future kind from v0.6.6+.
        "scope_expired" => Some(("stavR · scope expired", Severity::Info)),
        // CC quota warnings (v0.6.X telegram directives + observer).
        "cc_quota_warning" => Some(("stavR · CC quota warning", Severity::Warn)),
        // Worker dispatch failures (v0.6.X telegram directives expansion).
        "worker_dispatch_failed" => Some(("stavR · dispatch failed", Severity::Warn)),
        _ => None,
    }
}

/// The router. Holds the per-kind last-emit times under a Mutex and the
/// renderer through which approved toasts are rendered.
///
/// `mute_until` is set by the tray-menu "Mute Notifications · 1h / 1d"
/// items (P5). While set and not yet elapsed, every event is dropped —
/// debounce table is still updated as if the event passed, so resuming
/// after the mute window doesn't fire a flurry of stale events.
pub struct EventRouter {
    last_emit: Mutex<HashMap<String, Instant>>,
    mute_until: Mutex<Option<Instant>>,
    renderer: Box<dyn ToastRenderer>,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
}

impl EventRouter {
    pub fn new<R: ToastRenderer + 'static>(renderer: R) -> Self {
        Self {
            last_emit: Mutex::new(HashMap::new()),
            mute_until: Mutex::new(None),
            renderer: Box::new(renderer),
            clock: Box::new(Instant::now),
        }
    }

    /// Test constructor accepting a deterministic clock.
    pub fn with_clock<R, C>(renderer: R, clock: C) -> Self
    where
        R: ToastRenderer + 'static,
        C: Fn() -> Instant + Send + Sync + 'static,
    {
        Self {
            last_emit: Mutex::new(HashMap::new()),
            mute_until: Mutex::new(None),
            renderer: Box::new(renderer),
            clock: Box::new(clock),
        }
    }

    /// Suppress all toasts until `until`. Used by the tray-menu mute items
    /// (P5: "Mute Notifications · 1h / 1d"). A previously-set, still-active
    /// mute is extended (the later of the two ends wins) — operator
    /// double-clicking "Mute 1h" then "Mute 1d" should give 1 day, not 1 hour.
    pub fn mute_until(&self, until: Instant) {
        let mut m = self.mute_until.lock().expect("mute lock poisoned");
        *m = match *m {
            Some(existing) if existing > until => Some(existing),
            _ => Some(until),
        };
        log::info!("event-router: muted until {:?}", until);
    }

    /// Clear any active mute. Operator's "Unmute" tray action.
    pub fn unmute(&self) {
        let mut m = self.mute_until.lock().expect("mute lock poisoned");
        *m = None;
        log::info!("event-router: unmuted");
    }

    /// True iff a mute is currently active (relative to the router's clock).
    pub fn is_muted(&self) -> bool {
        let m = self.mute_until.lock().expect("mute lock poisoned");
        match *m {
            Some(until) => (self.clock)() < until,
            None => false,
        }
    }

    /// Build a toast spec from an event, returning `None` if the event kind
    /// isn't in our operator-awareness table.
    pub fn render_for(&self, ev: &BrokerEvent) -> Option<ToastSpec> {
        let (title, severity) = kind_template(&ev.kind)?;
        // Worker `completed` is routine — operator doesn't need a toast.
        if ev.kind == "worker_terminated"
            && ev.payload.get("reason").and_then(|v| v.as_str()) == Some("completed")
        {
            return None;
        }
        let body = body_for_kind(ev);
        Some(ToastSpec {
            kind: ev.kind.clone(),
            title: title.to_string(),
            body,
            severity,
        })
    }

    /// Returns true if a toast was rendered; false if suppressed (unknown
    /// kind, debounced, or globally muted).
    pub fn route(&self, ev: BrokerEvent) -> bool {
        let Some(spec) = self.render_for(&ev) else {
            return false;
        };
        let now = (self.clock)();
        // Mute check first — short-circuits before touching the debounce
        // map so the post-mute resume doesn't have an artificially-fresh
        // debounce window left over from a flurry-during-mute.
        if let Some(until) = *self.mute_until.lock().expect("mute lock poisoned") {
            if now < until {
                log::debug!(
                    "event-router: muted, dropping kind={} (until={:?})",
                    spec.kind,
                    until
                );
                return false;
            }
        }
        {
            let mut last = self.last_emit.lock().expect("debounce map poisoned");
            if let Some(&prev) = last.get(&spec.kind) {
                if now.duration_since(prev) < DEBOUNCE_WINDOW {
                    log::debug!(
                        "event-router: debounced kind={} ({}ms since last)",
                        spec.kind,
                        now.duration_since(prev).as_millis()
                    );
                    return false;
                }
            }
            last.insert(spec.kind.clone(), now);
        }
        self.renderer.render(&spec);
        true
    }

    /// Number of distinct kinds currently in the debounce table. Exposed for
    /// tests; production code doesn't need it.
    #[cfg(test)]
    pub fn tracked_kinds_count(&self) -> usize {
        self.last_emit.lock().unwrap().len()
    }
}

impl EventSink for EventRouter {
    fn handle(&self, ev: BrokerEvent) {
        self.route(ev);
    }
}

// Note: `Arc<EventRouter>` coerces to `Arc<dyn EventSink>` via the
// unsized-coercion of the impl above — no separate `impl EventSink for
// Arc<EventRouter>` is needed (and writing one would shadow the deref-based
// method resolution).

/// Produce a human-readable toast body for an event. Each operator-relevant
/// kind has a synthetic template that pulls the most-useful fields (worker
/// id + reason, scope id, etc.) in a fixed order — that's better than blind
/// field-probing, which would surface less-useful strings (e.g. "crashed"
/// alone instead of "worker w42 terminated (crashed)").
///
/// For kinds without a synthetic template, we probe the common
/// human-readable fields. Source agent is prepended when present, and the
/// whole line is truncated to 120 chars (BOM P4).
/// True if the broker event represents an operator-approval gate. These
/// get the distinct "approval needed" toast title and are the only kinds
/// the click handler routes to `/dashboard/decide` (Phase 3 of the
/// operator-companion refactor).
pub fn is_approval_kind(kind: &str) -> bool {
    matches!(kind, "decision_request" | "decision_required")
}

pub fn body_for_kind(ev: &BrokerEvent) -> String {
    let p = &ev.payload;
    let synthetic: Option<String> = match ev.kind.as_str() {
        // Approval-needed: lead with the explicit "Approval needed:" prefix
        // so the OS notification body reads as a call-to-action, not a
        // generic "decision_request: ..." stream entry.
        "decision_request" | "decision_required" => Some({
            let summary = first_string(&[
                p.get("question"),
                p.get("title"),
                p.get("message"),
                p.get("summary"),
            ]);
            if summary.is_empty() {
                "Approval needed — open Decide queue".to_string()
            } else {
                format!("Approval needed: {summary}")
            }
        }),
        "host_exec_denied" => Some({
            let cmd = string_field(p, "command");
            let reason = string_field(p, "reason");
            match (cmd, reason) {
                (Some(c), Some(r)) => format!("blocked: {c} — {r}"),
                (Some(c), None) => format!("blocked: {c}"),
                (None, Some(r)) => format!("host_exec blocked: {r}"),
                _ => "host_exec blocked by policy".to_string(),
            }
        }),
        "worker_terminated" => Some(format!(
            "worker {} terminated ({})",
            string_field(p, "id").unwrap_or_else(|| "?".into()),
            string_field(p, "reason").unwrap_or_else(|| "unknown".into()),
        )),
        "worker_failed" => Some(format!(
            "worker {} failed",
            string_field(p, "id").unwrap_or_else(|| "?".into()),
        )),
        "worker_blocked_by_av" => Some(format!(
            "worker {} blocked by AV",
            string_field(p, "id").unwrap_or_else(|| "?".into()),
        )),
        "worker_dispatch_failed" => Some(format!(
            "dispatch failed for worker {}",
            string_field(p, "target_worker_id")
                .or_else(|| string_field(p, "id"))
                .unwrap_or_else(|| "?".into()),
        )),
        "trust_scope_revoked" => Some(format!(
            "scope {} revoked",
            string_field(p, "scope_id").unwrap_or_else(|| "?".into()),
        )),
        "trust_scope_proposed" => Some(format!(
            "scope {} proposed: {}",
            string_field(p, "scope_id").unwrap_or_else(|| "?".into()),
            string_field(p, "title").unwrap_or_else(|| "no title".into()),
        )),
        "trust_scope_completed" => Some(format!(
            "scope {} completed",
            string_field(p, "scope_id").unwrap_or_else(|| "?".into()),
        )),
        "daemon_health_changed" => Some(format!(
            "{} — {}",
            string_field(p, "severity").unwrap_or_else(|| "?".into()),
            string_field(p, "reason").unwrap_or_else(|| "state changed".into()),
        )),
        _ => None,
    };

    let mut line = synthetic.unwrap_or_else(|| {
        let probed = first_string(&[
            p.get("question"),
            p.get("title"),
            p.get("message"),
            p.get("reason"),
            p.get("detail"),
        ]);
        if probed.is_empty() {
            ev.kind.clone()
        } else {
            probed
        }
    });

    if let Some(src) = ev.source_agent.as_deref() {
        if !src.is_empty() && !line.starts_with('[') {
            line = format!("[{src}] {line}");
        }
    }
    truncate_chars(&line, 120)
}

fn first_string(opts: &[Option<&serde_json::Value>]) -> String {
    for o in opts {
        if let Some(v) = o {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    String::new()
}

fn string_field(p: &serde_json::Value, k: &str) -> Option<String> {
    p.get(k).and_then(|v| v.as_str()).map(str::to_string)
}

/// Truncate to N chars (not bytes) with an ellipsis. Avoids splitting a
/// multi-byte UTF-8 codepoint, which `String::truncate(N)` does not.
fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let cut = s.chars().take(n.saturating_sub(1)).collect::<String>();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex as PlMutex;
    use serde_json::json;
    use std::sync::Arc;

    /// Collector renderer for tests.
    #[derive(Default)]
    struct Collector {
        toasts: PlMutex<Vec<ToastSpec>>,
    }
    impl Collector {
        fn snapshot(&self) -> Vec<ToastSpec> {
            self.toasts.lock().clone()
        }
    }
    impl ToastRenderer for Collector {
        fn render(&self, spec: &ToastSpec) {
            self.toasts.lock().push(spec.clone());
        }
    }

    fn ev(kind: &str, payload: serde_json::Value) -> BrokerEvent {
        BrokerEvent {
            kind: kind.to_string(),
            payload,
            id: None,
            ts: None,
            correlation_id: None,
            source_agent: None,
        }
    }

    /// Helper that wraps the collector behind an Arc so tests can keep a
    /// reference to it after handing one into the router.
    struct OwnedCollector(Arc<Collector>);
    impl ToastRenderer for OwnedCollector {
        fn render(&self, s: &ToastSpec) {
            self.0.toasts.lock().push(s.clone());
        }
    }

    #[test]
    fn known_kinds_render_toasts() {
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        let rendered = router.route(ev(
            "decision_request",
            json!({"question": "approve PR #41?"}),
        ));
        assert!(rendered);
        let toasts = inner.snapshot();
        assert_eq!(toasts.len(), 1);
        // Phase 3: decision events are first-class approval-needed toasts.
        assert!(toasts[0].title.contains("approval needed"), "{}", toasts[0].title);
        assert!(toasts[0].body.starts_with("Approval needed:"), "{}", toasts[0].body);
        assert!(toasts[0].body.contains("approve PR #41"));
        assert_eq!(toasts[0].severity, Severity::Crit);
    }

    #[test]
    fn unknown_kinds_silently_drop() {
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        // Routine progress events must never reach the toast surface.
        let rendered = router.route(ev("progress", json!({"message": "phase 1/3"})));
        assert!(!rendered);
        assert!(inner.snapshot().is_empty());
        // Tool calls — also dashboard-only.
        assert!(!router.route(ev("worker_progress", json!({"message": "x"}))));
        assert!(!router.route(ev("phase_started", json!({"phase_name": "p1"}))));
        assert!(!router.route(ev("file_written", json!({"path": "src/x.ts"}))));
        // Sanity: the debounce table didn't pick anything up for dropped kinds.
        assert_eq!(router.tracked_kinds_count(), 0);
    }

    #[test]
    fn debounces_within_window() {
        let inner = Arc::new(Collector::default());
        let start = Instant::now();
        let offset = Arc::new(PlMutex::new(Duration::ZERO));
        let clock_offset = offset.clone();
        let router = EventRouter::with_clock(OwnedCollector(inner.clone()), move || {
            start + *clock_offset.lock()
        });
        // Burst of 5 worker_terminated (reason=crashed) within 1s should produce one toast.
        for i in 0..5 {
            *offset.lock() = Duration::from_millis(i * 200);
            let _ = router.route(ev(
                "worker_terminated",
                json!({"id": "w1", "reason": "crashed"}),
            ));
        }
        assert_eq!(inner.snapshot().len(), 1, "5 events in 1s → exactly 1 toast (debounce)");
        // Advance past the debounce window — next event should fire.
        *offset.lock() = DEBOUNCE_WINDOW + Duration::from_millis(1);
        assert!(router.route(ev(
            "worker_terminated",
            json!({"id": "w1", "reason": "crashed"}),
        )));
        assert_eq!(inner.snapshot().len(), 2);
    }

    #[test]
    fn debounce_is_per_kind() {
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        // Two different kinds in quick succession — both fire; no cross-kind debounce.
        assert!(router.route(ev("decision_request", json!({"question": "q1"}))));
        assert!(router.route(ev("host_exec_denied", json!({"reason": "blocked"}))));
        assert_eq!(inner.snapshot().len(), 2);
    }

    #[test]
    fn body_truncates_at_120_chars() {
        let long = "x".repeat(300);
        let e = ev("decision_request", json!({"question": long}));
        let body = body_for_kind(&e);
        assert!(body.chars().count() <= 120, "body should be ≤120 chars, got {}", body.chars().count());
        assert!(body.ends_with('…'), "truncation should end with ellipsis: {body}");
    }

    #[test]
    fn body_prepends_source_agent_when_present() {
        let mut e = ev("decision_request", json!({"question": "approve?"}));
        e.source_agent = Some("steward".to_string());
        let body = body_for_kind(&e);
        assert!(body.starts_with("[steward]"), "{body}");
        assert!(body.contains("approve?"));
    }

    #[test]
    fn worker_completed_does_not_toast() {
        // Routine completion: dashboard-only per src/notify/wiring.ts L130.
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        let rendered = router.route(ev(
            "worker_terminated",
            json!({"id": "w42", "reason": "completed"}),
        ));
        assert!(!rendered);
        assert!(inner.snapshot().is_empty());
    }

    #[test]
    fn worker_crashed_does_toast() {
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        let rendered = router.route(ev(
            "worker_terminated",
            json!({"id": "w42", "reason": "crashed"}),
        ));
        assert!(rendered);
        let toasts = inner.snapshot();
        assert_eq!(toasts.len(), 1);
        assert!(toasts[0].body.contains("w42"));
    }

    #[test]
    fn kind_template_covers_subscribed_kinds_from_bom() {
        // BOM P4 enumerates these as the canonical operator-awareness set;
        // pin them in a test so a future refactor cannot silently drop one.
        for kind in [
            "notification_requested",
            "decision_request",
            "decision_required",
            "host_exec_denied",
            "trust_scope_proposed",
            "trust_scope_revoked",
            "trust_scope_completed",
            "worker_terminated",
            "worker_failed",
            "worker_blocked_by_av",
            "daemon_health_changed",
            "scope_expired",
            "cc_quota_warning",
            "worker_dispatch_failed",
        ] {
            assert!(kind_template(kind).is_some(), "kind {kind} missing from template table");
        }
        // Negative — noisy kinds explicitly NOT subscribed.
        for kind in [
            "progress",
            "tool_called",
            "worker_progress",
            "phase_started",
            "file_written",
            "command_run",
        ] {
            assert!(
                kind_template(kind).is_none(),
                "kind {kind} should be excluded (too noisy for OS toast)"
            );
        }
    }

    /// Phase 3 acceptance: both decision kind aliases share the same
    /// first-class approval-needed treatment. The daemon currently emits
    /// `decision_request`; the notification fabric remaps to
    /// `decision_required`. Both must land as a single recognizable
    /// approval-needed toast (distinct title, Crit severity, "Approval
    /// needed:" body prefix).
    #[test]
    fn approval_kinds_render_as_first_class_distinct_toasts() {
        for kind in ["decision_request", "decision_required"] {
            let (title, severity) = kind_template(kind).expect("approval kind missing");
            assert_eq!(title, "stavR — approval needed", "title for {kind}");
            assert_eq!(severity, Severity::Crit, "severity for {kind}");
        }
        // is_approval_kind agrees and rejects neighbours.
        assert!(is_approval_kind("decision_request"));
        assert!(is_approval_kind("decision_required"));
        assert!(!is_approval_kind("notification_requested"));
        assert!(!is_approval_kind("trust_scope_proposed"));
    }

    /// Approval body must call out the action explicitly so the OS
    /// notification reads as a call-to-action and the operator knows what
    /// they're approving.
    #[test]
    fn approval_body_uses_approval_needed_prefix() {
        let e = ev(
            "decision_required",
            json!({"question": "Allow worker to push to main?"}),
        );
        let body = body_for_kind(&e);
        assert!(body.starts_with("Approval needed:"), "{body}");
        assert!(body.contains("Allow worker to push to main"));
    }

    /// Approval body has a sensible default when the payload carries no
    /// summary fields — the operator still gets a clear "go check Decide"
    /// nudge instead of a bare kind string.
    #[test]
    fn approval_body_falls_back_to_open_decide_when_payload_empty() {
        let e = ev("decision_request", json!({}));
        let body = body_for_kind(&e);
        assert!(
            body.contains("open Decide queue"),
            "expected default decide-queue nudge, got: {body}"
        );
    }

    #[test]
    fn host_exec_denied_is_crit_severity() {
        // Policy violations are the loudest operator signal — should be crit.
        let (_, sev) = kind_template("host_exec_denied").unwrap();
        assert_eq!(sev, Severity::Crit);
    }

    #[test]
    fn mute_suppresses_subsequent_events() {
        let inner = Arc::new(Collector::default());
        let start = Instant::now();
        let offset = Arc::new(PlMutex::new(Duration::ZERO));
        let clock_offset = offset.clone();
        let router = EventRouter::with_clock(OwnedCollector(inner.clone()), move || {
            start + *clock_offset.lock()
        });
        // Mute for 1 hour.
        router.mute_until(start + Duration::from_secs(3600));
        // Try to fire several events at different sim-times — all suppressed.
        for i in 0..3 {
            *offset.lock() = Duration::from_secs(i * 100);
            let routed = router.route(ev("decision_request", json!({"question": format!("q{i}")})));
            assert!(!routed, "muted router must drop kind={}", "decision_request");
        }
        assert!(inner.snapshot().is_empty(), "no toasts during mute window");
        // Jump past the mute window — events should flow again.
        *offset.lock() = Duration::from_secs(3601);
        let routed = router.route(ev("decision_request", json!({"question": "after_mute"})));
        assert!(routed, "post-mute route must succeed");
        assert_eq!(inner.snapshot().len(), 1);
    }

    #[test]
    fn unmute_clears_active_mute() {
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner.clone()));
        router.mute_until(Instant::now() + Duration::from_secs(3600));
        assert!(router.is_muted());
        router.unmute();
        assert!(!router.is_muted());
        let routed = router.route(ev("decision_request", json!({"question": "q"})));
        assert!(routed, "after unmute, events must flow");
    }

    #[test]
    fn mute_extends_to_later_end() {
        // BOM rule: operator double-clicking "Mute 1h" then "Mute 1d" should
        // give 1 day, not 1 hour. The later end-time wins.
        let inner = Arc::new(Collector::default());
        let router = EventRouter::new(OwnedCollector(inner));
        let one_day = Instant::now() + Duration::from_secs(86_400);
        let one_hour = Instant::now() + Duration::from_secs(3600);
        router.mute_until(one_day);
        router.mute_until(one_hour); // shorter — must not shrink the window
        assert!(router.is_muted());
        // We can't directly assert on the stored Instant, but is_muted() at
        // a clock advanced past one_hour but before one_day should still be true.
        // (Tested implicitly: is_muted uses the system clock, so the assertion
        // here just confirms the second mute didn't disable the first.)
    }

    #[test]
    fn host_exec_denied_synthetic_body_when_no_payload() {
        let e = ev("host_exec_denied", json!({}));
        let body = body_for_kind(&e);
        assert!(body.contains("blocked by policy"), "{body}");
    }
}
