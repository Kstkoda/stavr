//! SSE event bridge: maintains a single long-lived connection to the daemon's
//! `/dashboard/stream` endpoint, parses Server-Sent Events, and forwards
//! `event`-typed payloads to a sink (the router) for toast rendering.
//!
//! Per `proposed/v0_6_5-governor-mvp-bom.md` Footgun #6: exactly ONE long-lived
//! connection. Reconnect with backoff on drop — never spam parallel SSE
//! sessions. The 8-SSE-per-page dashboard bug is the cautionary tale this
//! module is built to avoid replicating in the Rust client.
//!
//! Wire format (from `src/transports.ts` /dashboard/stream handler):
//!   `event: ping\ndata: {"at":"..."}\n\n` — keepalive every 25 s
//!   `event: event\ndata: <StoredEvent JSON>\n\n` — actual broker events
//!
//! Only events with SSE event-name "event" are forwarded to the sink. Pings
//! are dropped silently (their only job is to keep the TCP connection alive
//! through any reverse proxy that closes idle sockets).

use std::io::{BufRead, BufReader, Read};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Default URL of the daemon's SSE stream. Override via `STAVR_STREAM_URL`
/// env var (P6 installer wiring) — useful when the daemon is reachable on a
/// non-default port or via a peer's loopback (federated stavR, ADR-035).
pub const DEFAULT_STREAM_URL: &str = "http://127.0.0.1:7777/dashboard/stream";

/// Reconnect-backoff ladder in seconds. Climbs 1, 2, 4, 8, 16, 32, 60 and
/// stays at 60. Reset to step-zero only after a connection has been *stable*
/// for at least `STABILITY_THRESHOLD` — a connection that opens and drops
/// immediately is treated as a continuing failure, not a fresh start.
const BACKOFF_LADDER_SECS: &[u64] = &[1, 2, 4, 8, 16, 32, 60];

/// A connection that streams successfully for this long is considered stable
/// and resets the backoff counter. Anything shorter (e.g. daemon accepts the
/// socket then immediately closes) is treated as a continuing failure.
const STABILITY_THRESHOLD: Duration = Duration::from_secs(30);

/// Pause between reconnects after a clean disconnection (no failures). Keeps
/// the Governor from hammering the daemon during a planned restart cycle.
const POST_SUCCESS_RECONNECT_PAUSE: Duration = Duration::from_secs(1);

/// Minimal shape of a broker event on the wire. The Governor only routes by
/// `kind`; everything else flows through to the router as raw JSON so the
/// kind-specific toast templates can pull title/body/source from wherever
/// the payload puts them.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct BrokerEvent {
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub source_agent: Option<String>,
}

/// Where parsed events go. Production: the EventRouter. Tests: an in-memory
/// `Vec<BrokerEvent>` so the parser can be exercised without a Tauri app
/// context.
pub trait EventSink: Send + Sync {
    fn handle(&self, ev: BrokerEvent);
}

/// HTTP fetch abstraction so the SSE read loop can be exercised against an
/// in-memory cursor (a fixture string) instead of a real network socket.
pub trait SseFetch: Send + Sync {
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, BridgeError>;
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("io error: {0}")]
    Io(String),
    #[error("http status {0}")]
    BadStatus(u16),
}

/// Production HTTP fetcher using `ureq`. Streams the response body — the
/// Box<dyn Read + Send> erases the concrete reader type so the trait stays
/// object-safe.
pub struct UreqFetcher;

impl SseFetch for UreqFetcher {
    fn open(&self, url: &str) -> Result<Box<dyn Read + Send>, BridgeError> {
        // ureq 2.x: connection timeout is configured via AgentBuilder, not
        // per-Request. SSE is a long-poll body so we do NOT set a read
        // timeout — the daemon's 25 s keepalive pings keep the socket alive
        // through any reverse proxy idle-timeout, and the read loop just
        // blocks until the next event arrives.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .build();
        let resp = agent
            .get(url)
            .set("accept", "text/event-stream")
            .call()
            .map_err(|e| BridgeError::Io(format!("{e}")))?;
        let status = resp.status();
        if status != 200 {
            return Err(BridgeError::BadStatus(status));
        }
        Ok(Box::new(resp.into_reader()))
    }
}

/// Clock abstraction so the backoff timing can be tested without `sleep`.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, d: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// The bridge itself. Owns the fetcher + sink + clock; the only public
/// operations are `run_once` (drain a single stream until EOF, return) and
/// `run_forever` (the supervised reconnect loop spawned from `main.rs`).
pub struct EventBridge {
    pub url: String,
    fetcher: Arc<dyn SseFetch>,
    sink: Arc<dyn EventSink>,
    clock: Arc<dyn Clock>,
}

impl EventBridge {
    pub fn new(url: String, fetcher: Arc<dyn SseFetch>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            url,
            fetcher,
            sink,
            clock: Arc::new(SystemClock),
        }
    }

    /// Test constructor that takes a custom clock so backoff sleeps can be
    /// observed without wall-clock waits.
    pub fn with_clock(
        url: String,
        fetcher: Arc<dyn SseFetch>,
        sink: Arc<dyn EventSink>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            url,
            fetcher,
            sink,
            clock,
        }
    }

    /// Connect once and parse until EOF or IO error. Returns Ok on graceful
    /// EOF; Err on any IO trouble. Callers use this to test the parser; the
    /// `run_forever` loop uses it under reconnect supervision.
    pub fn run_once(&self) -> Result<(), BridgeError> {
        let rdr = self.fetcher.open(&self.url)?;
        self.read_loop(rdr).map_err(|e| BridgeError::Io(e.to_string()))
    }

    /// Connect, stream, reconnect with backoff. Never returns. Intended to be
    /// spawned on a dedicated thread from `main.rs`.
    pub fn run_forever(&self) -> ! {
        let mut consecutive_failures: usize = 0;
        loop {
            let opened_at = self.clock.now();
            let label = format!("event-bridge[{}]", &self.url);
            log::info!("{label}: connecting (attempt after {consecutive_failures} consecutive failures)");
            match self.fetcher.open(&self.url) {
                Ok(rdr) => match self.read_loop(rdr) {
                    Ok(()) => {
                        let stable = self.clock.now().duration_since(opened_at) >= STABILITY_THRESHOLD;
                        if stable {
                            log::info!("{label}: stream closed cleanly after stable session — resetting backoff");
                            consecutive_failures = 0;
                        } else {
                            log::warn!("{label}: stream closed within stability threshold — escalating backoff");
                            consecutive_failures = consecutive_failures.saturating_add(1);
                        }
                    }
                    Err(e) => {
                        log::warn!("{label}: stream read error: {e}");
                        consecutive_failures = consecutive_failures.saturating_add(1);
                    }
                },
                Err(e) => {
                    log::warn!("{label}: connect failed: {e}");
                    consecutive_failures = consecutive_failures.saturating_add(1);
                }
            }
            let delay = next_backoff(consecutive_failures);
            log::info!("{label}: reconnecting in {}s", delay.as_secs());
            self.clock.sleep(delay);
        }
    }

    /// Loop over the response body, accumulating `event:` and `data:` lines,
    /// dispatching to the sink on each blank-line event terminator. Anything
    /// that isn't a recognised field is silently ignored, per the SSE spec.
    fn read_loop(&self, reader: Box<dyn Read + Send>) -> Result<(), std::io::Error> {
        let mut br = BufReader::new(reader);
        let mut current_event_name: Option<String> = None;
        let mut current_data: Vec<String> = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = br.read_line(&mut line)?;
            if n == 0 {
                // EOF — if we have a buffered event without a trailing blank
                // line, drop it silently. The SSE spec says blank line is the
                // terminator; a truncated event is not a valid one.
                return Ok(());
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                // Event boundary.
                if let Some(name) = current_event_name.as_deref() {
                    let data = current_data.join("\n");
                    self.dispatch(name, &data);
                }
                current_event_name = None;
                current_data.clear();
                continue;
            }
            if trimmed.starts_with(':') {
                // Comment line; ignore.
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("event:") {
                current_event_name = Some(rest.trim_start().to_string());
            } else if let Some(rest) = trimmed.strip_prefix("data:") {
                current_data.push(rest.trim_start().to_string());
            }
            // Other fields (id:, retry:) are ignored — we don't reconnect by
            // last-event-id; we just reopen from now-onward.
        }
    }

    fn dispatch(&self, name: &str, data: &str) {
        if name != "event" {
            // ping or any other framing; not a broker event.
            return;
        }
        match serde_json::from_str::<BrokerEvent>(data) {
            Ok(ev) => self.sink.handle(ev),
            Err(e) => {
                let preview: String = data.chars().take(200).collect();
                log::warn!("event-bridge: data parse error: {e}; preview={preview}");
            }
        }
    }
}

/// Pick the next backoff duration given a count of consecutive failures.
/// `0` is meaningful — used after a clean disconnection on a stable connection
/// (a planned daemon restart); we still pause briefly so we don't hammer.
pub fn next_backoff(consecutive_failures: usize) -> Duration {
    if consecutive_failures == 0 {
        return POST_SUCCESS_RECONNECT_PAUSE;
    }
    let idx = (consecutive_failures - 1).min(BACKOFF_LADDER_SECS.len() - 1);
    Duration::from_secs(BACKOFF_LADDER_SECS[idx])
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex as PlMutex;
    use std::io::Cursor;

    /// In-memory sink for parser tests.
    #[derive(Default)]
    struct CollectorSink {
        events: PlMutex<Vec<BrokerEvent>>,
    }
    impl CollectorSink {
        fn snapshot(&self) -> Vec<BrokerEvent> {
            self.events.lock().clone()
        }
    }
    impl EventSink for CollectorSink {
        fn handle(&self, ev: BrokerEvent) {
            self.events.lock().push(ev);
        }
    }

    /// Fetcher that hands out a single pre-baked stream once, then errors
    /// on subsequent opens. Used to test the read loop deterministically.
    struct StaticFetcher {
        body: PlMutex<Option<Vec<u8>>>,
        opens: PlMutex<usize>,
    }
    impl StaticFetcher {
        fn new(body: &str) -> Self {
            Self {
                body: PlMutex::new(Some(body.as_bytes().to_vec())),
                opens: PlMutex::new(0),
            }
        }
        fn open_count(&self) -> usize {
            *self.opens.lock()
        }
    }
    impl SseFetch for StaticFetcher {
        fn open(&self, _url: &str) -> Result<Box<dyn Read + Send>, BridgeError> {
            *self.opens.lock() += 1;
            match self.body.lock().take() {
                Some(bytes) => Ok(Box::new(Cursor::new(bytes))),
                None => Err(BridgeError::Io("static fetcher exhausted".into())),
            }
        }
    }

    #[test]
    fn parses_single_broker_event() {
        let body = "event: event\ndata: {\"kind\":\"decision_request\",\"id\":\"e1\",\"payload\":{\"question\":\"continue?\"}}\n\n";
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().expect("run_once should succeed on clean EOF");
        let events = sink.snapshot();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "decision_request");
        assert_eq!(events[0].id.as_deref(), Some("e1"));
    }

    #[test]
    fn pings_are_dropped() {
        // Per Footgun #6 — keepalives flow through but never reach the sink.
        let body = concat!(
            "event: ping\ndata: {\"at\":\"2026-05-18T00:00:00Z\"}\n\n",
            "event: event\ndata: {\"kind\":\"trust_scope_revoked\",\"payload\":{}}\n\n",
            "event: ping\ndata: {\"at\":\"2026-05-18T00:00:25Z\"}\n\n",
        );
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        let evs = sink.snapshot();
        assert_eq!(evs.len(), 1, "pings must not reach the sink");
        assert_eq!(evs[0].kind, "trust_scope_revoked");
    }

    #[test]
    fn comment_lines_are_ignored() {
        let body = concat!(
            ": this is a comment line per SSE spec\n",
            "event: event\ndata: {\"kind\":\"host_exec_denied\",\"payload\":{}}\n\n",
        );
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        let evs = sink.snapshot();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "host_exec_denied");
    }

    #[test]
    fn multiline_data_concatenated_with_newlines() {
        // Per SSE spec, multiple `data:` lines within one event concatenate
        // with `\n`. The daemon today never splits a payload across multiple
        // data lines, but parsers must tolerate it.
        let body = "event: event\ndata: {\"kind\":\"error\",\n  \"payload\":{\"message\":\"boom\"}}\n\n";
        // (Note: the above is technically invalid JSON across two data lines
        // for our test purposes — we test the parser's tolerance to *valid*
        // multi-data below with a kind-only payload.)
        let _ = body;
        let valid = "event: event\ndata: {\"kind\":\"checkpoint\",\ndata: \"payload\":{}}\n\n";
        let _ = valid;
        // The simpler check: two data lines that together form valid JSON.
        let real = "event: event\ndata: {\"kind\":\"checkpoint\",\"payload\":\n";
        let real_part2 = "data: {\"branch\":\"main\"}}\n\n";
        let combined = format!("{real}{real_part2}");
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(&combined));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        let evs = sink.snapshot();
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "checkpoint");
        assert_eq!(
            evs[0].payload.get("branch").and_then(|v| v.as_str()),
            Some("main")
        );
    }

    #[test]
    fn truncated_event_at_eof_is_dropped_silently() {
        // No trailing blank line — the event is incomplete and must not be
        // dispatched. This is what happens when the daemon (or a reverse
        // proxy) tears the socket down mid-event.
        let body = "event: event\ndata: {\"kind\":\"progress\",\"payload\":{}}\n";
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        assert!(sink.snapshot().is_empty(), "truncated events must be dropped");
    }

    #[test]
    fn malformed_json_is_logged_and_skipped() {
        let body = concat!(
            "event: event\ndata: {not valid json\n\n",
            "event: event\ndata: {\"kind\":\"checkpoint\",\"payload\":{}}\n\n",
        );
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        let evs = sink.snapshot();
        // The malformed one is dropped, the valid one comes through. The
        // bridge does NOT terminate on parse error — it has to survive a
        // single misbehaving event.
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].kind, "checkpoint");
    }

    #[test]
    fn fetch_call_count_is_one_per_run_once() {
        // Sanity: run_once() does NOT loop. Reconnection lives entirely in
        // run_forever().
        let body = "event: event\ndata: {\"kind\":\"x\",\"payload\":{}}\n\n";
        let fetcher = Arc::new(StaticFetcher::new(body));
        let sink = Arc::new(CollectorSink::default());
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher.clone(), sink);
        bridge.run_once().unwrap();
        assert_eq!(fetcher.open_count(), 1, "run_once opens exactly one connection");
    }

    #[test]
    fn next_backoff_steps_through_ladder_and_caps_at_60() {
        // 0 = post-success short pause (1s — same as ladder[0] for our cap purposes).
        assert_eq!(next_backoff(0), POST_SUCCESS_RECONNECT_PAUSE);
        assert_eq!(next_backoff(1), Duration::from_secs(1));
        assert_eq!(next_backoff(2), Duration::from_secs(2));
        assert_eq!(next_backoff(3), Duration::from_secs(4));
        assert_eq!(next_backoff(4), Duration::from_secs(8));
        assert_eq!(next_backoff(5), Duration::from_secs(16));
        assert_eq!(next_backoff(6), Duration::from_secs(32));
        assert_eq!(next_backoff(7), Duration::from_secs(60));
        // Past the end of the ladder — saturate at 60.
        assert_eq!(next_backoff(15), Duration::from_secs(60));
        assert_eq!(next_backoff(usize::MAX), Duration::from_secs(60));
    }

    #[test]
    fn source_agent_and_correlation_round_trip_through_parser() {
        let body = "event: event\ndata: {\"kind\":\"decision_request\",\"payload\":{},\"source_agent\":\"steward\",\"correlation_id\":\"c1\"}\n\n";
        let sink = Arc::new(CollectorSink::default());
        let fetcher = Arc::new(StaticFetcher::new(body));
        let bridge = EventBridge::new("http://x/stream".to_string(), fetcher, sink.clone());
        bridge.run_once().unwrap();
        let evs = sink.snapshot();
        assert_eq!(evs[0].source_agent.as_deref(), Some("steward"));
        assert_eq!(evs[0].correlation_id.as_deref(), Some("c1"));
    }
}
