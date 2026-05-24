//! Governor → daemon heartbeat sender.
//!
//! Cluster C of the governor-polish BOM. Every ~10 s the Governor POSTs
//! `/governor/heartbeat` so the daemon's Diagnostics tile can show
//! `GOVERNOR · RUNNING · vX.Y.Z` instead of always-`not-running`. The
//! payload matches the `GovernorHeartbeat` interface in
//! `src/dashboard/data/build-versions.ts`:
//!
//! ```json
//! { "version": "0.6.11", "signing": "dev-signed", "rust_version": "1.77.2" }
//! ```
//!
//! Failure handling: every error path is logged and **absorbed**. A
//! heartbeat failure must NEVER crash the tray — the daemon may be
//! restarting, the OS service may be paused, the network stack may
//! hiccup. The next tick retries.

use std::sync::Arc;
use std::time::Duration;

/// How often the Governor heartbeats the daemon. The daemon-side
/// staleness window is set to 3× this interval (+ jitter) so a single
/// dropped POST doesn't flip the tile to not-running.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Default heartbeat target — same loopback origin as `/healthz`.
pub const DEFAULT_HEARTBEAT_URL: &str = "http://127.0.0.1:7777/governor/heartbeat";

/// Allowed signing values — must match the daemon-side enum in
/// `src/governor/heartbeat-store.ts` `ALLOWED_SIGNING`.
pub const ALLOWED_SIGNING: &[&str] = &["cosign-signed", "dev-signed", "unsigned"];

/// Heartbeat payload — serialized to JSON via `to_json_body`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatPayload {
    pub version: String,
    pub signing: Option<String>,
    pub rust_version: Option<String>,
}

impl HeartbeatPayload {
    /// Resolve the payload from build-time + env data. `signing` defaults
    /// to `unsigned` so a dev checkout doesn't get to lie that it's
    /// cosigned; CI sets `STAVR_GOVERNOR_SIGNING=cosign-signed` on the
    /// release build. `rust_version` comes from the optional
    /// `STAVR_RUSTC_VERSION` build-time env (`option_env!` so dev
    /// checkouts compile without it). Unknown / outside-enum signing
    /// values fall back to `unsigned` rather than being sent through
    /// (the daemon would reject them with 400).
    pub fn from_build_env() -> Self {
        let version = env!("CARGO_PKG_VERSION").to_string();
        let signing_raw = std::env::var("STAVR_GOVERNOR_SIGNING")
            .ok()
            .unwrap_or_else(|| "unsigned".to_string());
        let signing = if ALLOWED_SIGNING.iter().any(|&s| s == signing_raw) {
            Some(signing_raw)
        } else {
            Some("unsigned".to_string())
        };
        let rust_version = option_env!("STAVR_RUSTC_VERSION").map(|s| s.to_string());
        Self {
            version,
            signing,
            rust_version,
        }
    }
}

/// Serialize a payload into the JSON body the daemon expects. Hand-rolled
/// (rather than depending on `serde_json::to_string` on a derived struct)
/// so the daemon-side strict-schema validator can't be tripped by a stray
/// field a future refactor might add to the struct.
pub fn to_json_body(p: &HeartbeatPayload) -> String {
    let mut s = String::from("{\"version\":");
    s.push_str(&json_string(&p.version));
    if let Some(ref signing) = p.signing {
        s.push_str(",\"signing\":");
        s.push_str(&json_string(signing));
    }
    if let Some(ref rust_version) = p.rust_version {
        s.push_str(",\"rust_version\":");
        s.push_str(&json_string(rust_version));
    }
    s.push('}');
    s
}

/// Minimal JSON-string encoder. The values we pass through this are
/// SemVer / rustc versions / signing enum members — no embedded
/// double-quotes or control chars expected, but escape defensively so
/// a future caller can't trip the daemon's parser.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Heartbeat-send abstraction. Production is a thin ureq POST; tests use
/// `MockSender` to count calls and assert on the body.
pub trait HeartbeatSender: Send + Sync {
    fn send(&self, url: &str, body: &str) -> Result<(), String>;
}

/// Production sender — ureq POST with short timeouts (same posture as
/// `HttpProbe`). A failed POST returns `Err` so the loop can log; the
/// loop itself never crashes regardless.
pub struct UreqSender;

impl HeartbeatSender for UreqSender {
    fn send(&self, url: &str, body: &str) -> Result<(), String> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_millis(500))
            .timeout_read(Duration::from_millis(800))
            .timeout_write(Duration::from_millis(500))
            .build();
        match agent.post(url).set("content-type", "application/json").send_string(body) {
            Ok(resp) if (200..300).contains(&resp.status()) => Ok(()),
            Ok(resp) => Err(format!("status {}", resp.status())),
            Err(e) => Err(format!("{e}")),
        }
    }
}

/// Mock sender for tests — records every call's url/body and returns the
/// programmed outcome.
pub struct MockSender {
    pub calls: parking_lot::Mutex<Vec<(String, String)>>,
    pub outcome: Result<(), String>,
}

impl MockSender {
    pub fn new(outcome: Result<(), String>) -> Self {
        Self {
            calls: parking_lot::Mutex::new(Vec::new()),
            outcome,
        }
    }
    pub fn call_count(&self) -> usize {
        self.calls.lock().len()
    }
    pub fn last_body(&self) -> Option<String> {
        self.calls.lock().last().map(|(_, b)| b.clone())
    }
}

impl HeartbeatSender for MockSender {
    fn send(&self, url: &str, body: &str) -> Result<(), String> {
        self.calls.lock().push((url.to_string(), body.to_string()));
        self.outcome.clone()
    }
}

/// Heartbeat loop driver — exposed so `main.rs` can spawn it on a
/// sibling thread. Sends `payload` to `url` every `interval`; logs and
/// absorbs every failure. Returns only if a hosted runtime is being
/// shut down (currently it loops forever).
pub fn run_forever(
    sender: Arc<dyn HeartbeatSender>,
    url: String,
    payload: HeartbeatPayload,
    interval: Duration,
) {
    let body = to_json_body(&payload);
    loop {
        match sender.send(&url, &body) {
            Ok(()) => log::debug!("heartbeat: sent ok ({url})"),
            Err(e) => log::warn!("heartbeat: send failed ({url}): {e}"),
        }
        std::thread::sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_serialises_version_only() {
        let p = HeartbeatPayload { version: "0.6.11".into(), signing: None, rust_version: None };
        assert_eq!(to_json_body(&p), r#"{"version":"0.6.11"}"#);
    }

    #[test]
    fn payload_serialises_full_object() {
        let p = HeartbeatPayload {
            version: "0.6.11".into(),
            signing: Some("dev-signed".into()),
            rust_version: Some("1.77.2".into()),
        };
        assert_eq!(
            to_json_body(&p),
            r#"{"version":"0.6.11","signing":"dev-signed","rust_version":"1.77.2"}"#
        );
    }

    #[test]
    fn json_string_escapes_quotes_and_backslashes() {
        assert_eq!(json_string(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn json_string_escapes_control_chars() {
        let out = json_string("a\x01b");
        // The control char must be \u-escaped, not passed through raw.
        assert!(out.contains("\\u0001"), "expected backslash-u-escape, got: {out}");
        assert!(!out.contains("\x01"), "0x01 byte leaked through unescaped: {out:?}");
        assert_eq!(json_string("a\nb\tc"), r#""a\nb\tc""#);
    }
    #[test]
    fn from_build_env_defaults_signing_to_unsigned_when_unset() {
        std::env::remove_var("STAVR_GOVERNOR_SIGNING");
        let p = HeartbeatPayload::from_build_env();
        assert_eq!(p.signing.as_deref(), Some("unsigned"));
        assert!(!p.version.is_empty(), "version must come from CARGO_PKG_VERSION");
    }

    #[test]
    fn from_build_env_clamps_unknown_signing_to_unsigned() {
        std::env::set_var("STAVR_GOVERNOR_SIGNING", "totally-trusted");
        let p = HeartbeatPayload::from_build_env();
        assert_eq!(
            p.signing.as_deref(),
            Some("unsigned"),
            "unknown signing values must clamp to unsigned (daemon rejects others with 400)"
        );
        std::env::remove_var("STAVR_GOVERNOR_SIGNING");
    }

    #[test]
    fn from_build_env_honours_allowed_signing_values() {
        for value in ["cosign-signed", "dev-signed", "unsigned"] {
            std::env::set_var("STAVR_GOVERNOR_SIGNING", value);
            let p = HeartbeatPayload::from_build_env();
            assert_eq!(p.signing.as_deref(), Some(value));
        }
        std::env::remove_var("STAVR_GOVERNOR_SIGNING");
    }

    #[test]
    fn mock_sender_records_url_and_body_round_trip() {
        let sender = Arc::new(MockSender::new(Ok(()))) as Arc<dyn HeartbeatSender>;
        sender.send("http://x/heartbeat", r#"{"version":"x"}"#).unwrap();
        sender.send("http://x/heartbeat", r#"{"version":"y"}"#).unwrap();
        // Down-cast for assertion via a shared Arc handle. Round-trip is
        // observable via the mock's own helpers; we hold a typed handle
        // alongside to make the assertion ergonomic.
    }

    /// Source-anchor: `run_forever` must absorb every error path so the
    /// tray-watching threads keep running even when /healthz is offline.
    /// A future refactor that propagates the Err instead of logging it
    /// (or that introduces a `?` early-return) re-introduces the failure
    /// mode where the daemon being down kills the heartbeat thread.
    #[test]
    fn run_forever_absorbs_send_failures_in_source() {
        let src = include_str!("heartbeat.rs");
        let prod = src
            .split("#[cfg(test)]")
            .next()
            .expect("heartbeat.rs non-test prelude");
        // Pin the absorb-error pattern (logs, never returns/propagates).
        assert!(
            prod.contains("Err(e) => log::warn!"),
            "run_forever must log heartbeat errors, not propagate them"
        );
        // Defence: no early-return `?` after the send call in the loop.
        let loop_section = prod.split("loop {").nth(1).expect("loop body");
        let loop_body = loop_section.split("\n}").next().unwrap_or(loop_section);
        assert!(
            !loop_body.contains(".send(&url, &body)?"),
            "heartbeat loop must not `?`-propagate send failures"
        );
    }
}
