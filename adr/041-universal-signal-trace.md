# ADR-041 — Universal signal trace with explicit privacy boundary

**Status:** Proposed
**Date:** 2026-05-17
**Related:** ADR-030 (event retention), ADR-031 (observability), ADR-035 (federation), ADR-036 (audit integrity), ADR-040 (three-process architecture), memory `project_stavr_team_repositioning_decision.md`

## Context

stavR's current audit posture covers the operator-facing decisions, scope grants, and worker outcomes. It does NOT consistently capture:

1. **LLM calls** — every prompt our Steward sends to Anthropic/OpenAI/Ollama, every response back. Today these vanish into model-provider logs the operator can't access. The prompt body is the *evidence of what we instructed our model to do*; without it, retroactive analysis ("why did Steward pick strategy X?") is impossible.

2. **DB instructions** — every SQL statement our daemon issues against `runestone.db` (writes especially; selected reads too). Without these, we can't reconstruct exactly what changed in our own state — only that something did.

3. **MCP traffic** — inbound calls from Cowork-Claude, CC, federated peers; outbound calls our daemon makes to MCP servers (bricks, GitHub, etc.). These are the wire protocol of stavR's interaction with the outside world; today they're partially logged in pino but not in the events table.

4. **Worker lifecycle granularity** — start/complete are logged, but progress steps in between are spotty.

5. **Federated peer A2A traffic** — doesn't exist yet (ADR-035 in design); when it lands, must be logged from day one.

The team-direction repositioning (memory `project_stavr_team_repositioning_decision.md`) raises the audit bar from "personal-tool best-effort" to "operator-or-small-team verifiable record." Universal signal trace is the foundation that makes the v0.8 audit dashboard (and the team-mode cryptographic attribution from ADR-036) genuinely complete.

But "log everything" has tensions: volume (DB queries are 1000s/sec), storage (LLM bodies are 10-100KB each), privacy (prompts contain operator-sensitive context), and federation (each operator's internal universe should stay private to them).

## Decision

Adopt **universal signal trace within an explicit privacy boundary**. Every signal that flowed through, or was directed by, *our universe* gets correlation_id-tracked and fully logged. Signals belonging to *another universe* (a peer stavR's internal state) are never replicated to us, even if we have technical access.

### The privacy boundary: "our universe"

**Our universe** (log fully, including bodies where applicable):
- Operator actions (dashboard clicks, PowerShell sessions touching our daemon, MCP tool calls from operator-controlled clients)
- Our Steward's outbound LLM calls (prompt + response bodies)
- Our Cowork-Claude / CC dispatches that we initiated
- Our worker outputs and intermediate progress events
- **Inbound instructions to our Steward, regardless of source** — operator, MCP client, federated peer asking us for help, dashboard action. All recorded as "instructions in" because they directed our behavior.
- Our daemon's DB instructions (full SQL text + bound parameters + caller correlation_id)
- Our outbound MCP calls to bricks (prompt-like payloads sent to MCP servers we use)
- Federated peer requests we received (the inbound side from peer X is in our universe — it's an instruction we received and acted on)
- Our responses sent back to federated peers (in our universe — we generated them)

**NOT our universe** (never log, never fetch, never display):
- A federated peer's internal LLM prompts/responses on their machine
- A peer's local Steward planning decisions
- A peer's DB queries
- A peer's worker outputs that didn't cross to us
- Anything that influenced a peer's behavior but didn't influence ours
- A peer's federation logs about OTHER peers

**The principle**: each stavR's universe owns its own audit fence. Cross-boundary interactions get recorded at BOTH endpoints from their respective vantage. Internal processing stays local to whichever party owns it.

### Per-signal-type capture policy

| Signal | Event kind | Body capture | Retention default | Sampling |
|---|---|---|---|---|
| Operator action (decision, scope grant) | `decision_*`, `scope_*` | full | 90 days | none |
| Our LLM call outbound | `llm_call_initiated` + `llm_call_completed` | metadata always; **bodies opt-in per runtime** (operator setting in dashboard) | metadata 90d, bodies 7d | none |
| Our LLM call body | stored separately at `~/.stavr/llm-bodies/{event_id}.json` or `llm_call_bodies` table | yes when opt-in | bodies 7d (separate from event metadata) | none |
| Inbound instruction to Steward | `steward_instruction_received` | full body (the instruction IS the evidence) | 90 days | none |
| DB query — write | `db_write` | full SQL + parameters | 30 days | none |
| DB query — slow read (>50ms) | `db_slow_read` | full SQL + parameters | 30 days | none |
| DB query — fast read | NOT logged individually | n/a | aggregate window only | 1-min windows: count + p50/p95 latency per query-hash |
| DB query — error | `db_error` | full SQL + parameters + error | 90 days | none |
| Host_exec call | `host_exec_initiated` + `host_exec_completed` (already exists) | full args + truncated stdout/stderr | 30 days | none |
| MCP tool call inbound | `mcp_call_inbound` | tool name + args + result; bodies opt-in for large payloads | 30 days | none |
| MCP tool call outbound (to brick) | `mcp_call_outbound` | tool name + args + result | 30 days | none |
| Worker lifecycle | `worker_*` (start/progress/complete/fail) | granular progress payload | 30 days | none |
| Notification dispatched | `notification_dispatched` | metadata + body | 30 days | none |
| Notification request | `notification_requested` (per v0.6.5 BOM) | full payload | 30 days | none |
| Federated peer request inbound (us receiving from peer Y) | `peer_request_received` | full payload (it's an instruction to us) | 90 days | none |
| Federated peer response outbound (us replying to peer Y) | `peer_response_sent` | full payload (we generated it) | 90 days | none |
| Federated peer request outbound (us asking peer Y) | `peer_request_sent` | metadata + our request body (in our universe) | 90 days | none |
| Federated peer response inbound (peer Y's reply to our request) | `peer_response_received` | metadata + their response body (received by us, becomes ours) | 90 days | none |
| Peer's internal processing | NOT LOGGED — outside our universe | n/a | n/a | n/a |

Retention defaults are operator-overridable in `~/.stavr/stavr.yaml`. Bodies have their own retention separate from the event row so metadata can outlive body capture.

### Body capture for LLM calls — privacy-default-off

Operator decision per runtime:
- Dashboard settings page (extends the channel settings panel from PR #33): each LLM runtime gets a "capture bodies" toggle
- Default OFF — only metadata (model, token counts, latency, prompt-fingerprint = sha256 first 16 chars)
- Operator turns ON when investigating something: "capture Anthropic bodies for 24h" — toggle auto-expires
- When ON: prompt + response stored at `~/.stavr/llm-bodies/{event_id}.json` (file-per-call), referenced from event row by file path

**Auto-redaction layer (always-on regardless of capture setting):** before persistence, the body is run through a redactor that masks credit-card-shaped strings, email addresses, US/EU SSN-shaped strings, AWS access keys (`AKIA...`). The redactor is conservative; operator can review redaction rules and add more in `~/.stavr/redaction.yaml`.

### Sampling + aggregation (volume control)

Three classes:
1. **Always-on full logging**: operator actions, LLM calls, DB writes, DB errors, MCP traffic, worker events, notifications, federation events. ~10-1000 events/day at typical operator scale. Negligible storage.
2. **Per-event with sampling**: nothing today. If a category proves too noisy (e.g., MCP calls during heavy CC dispatch), add sampling case-by-case.
3. **Aggregated only**: fast DB reads. Per-1-minute window: count + p50/p95 latency per query-hash. Stored as `db_query_window` event with a payload of the aggregated stats. Operator can drill into "what queries ran in this window?" via the dashboard.

### Correlation ID propagation

All events carry `correlation_id` (TEXT, indexed). Propagation rules:
- Operator action → unique new correlation_id (call it the "root" of a trace)
- All events triggered by that action inherit the same correlation_id, regardless of process boundary (Engine → Steward, Engine → host_exec subprocess, Engine → MCP server, Engine → federated peer)
- Subprocesses receive correlation_id as part of their incoming message and tag their own emitted events with the same ID
- LLM calls inside the Steward inherit the Steward's current correlation_id
- DB queries inside any handler inherit the handler's current correlation_id (via async-local-storage / context tracking)
- Notifications carry their triggering event's correlation_id

This makes the backward walker (per v0.8 BOM P4) work universally: from any event in any kind, walk back to the originating operator action.

## Consequences

**Positive:**
- True "what happened on date X" reconstruction — every signal accounted for
- LLM prompt evidence preserved for the operator (when opted-in) — no more "I have no idea what Steward asked Anthropic to do an hour ago"
- DB state changes audit-able — every write is an event, every error is captured
- Federation has a clean privacy story from day one — no leak of peer-internal state
- Universal correlation_id makes cross-process tracing genuinely possible
- v0.8 dashboard becomes powerful — backward-walk from a notification can chain through LLM calls + DB writes + worker events all the way to the operator's original click
- Foundation for the cryptographic audit attestation in ADR-036 — hash-chained events are more valuable when every signal is an event

**Negative we accept:**
- Storage growth: estimated +100-500MB/month for typical operator usage (mostly LLM bodies when opt-in; DB writes are small SQL strings)
- Retention tier complexity: bodies vs metadata, different policies per kind — operator must understand or accept defaults
- Code surface: every async-local-storage propagation site is a place propagation can break; needs careful test coverage
- LLM body capture is privacy-sensitive even with auto-redaction; operator must understand what opt-in means (banner on the toggle)
- Federation contract becomes more rigid: every cross-boundary message MUST carry its own correlation_id and be logged at the boundary; can't be added later without breaking historical traces
- DB-write logging adds 5-10μs per write; negligible but real

## Alternatives considered

- **Log nothing beyond what we have today** — gives up the team-direction audit bar; can't reconstruct LLM-driven decisions. Reject.
- **Log everything, no privacy boundary** — easier to implement but breaks federation trust (peers won't federate if their prompts leak). Reject.
- **Log everything, capture bodies always** — privacy-hostile for LLM prompts that contain operator's code/data. Operator opt-in is the right primitive.
- **Log all DB queries individually (no sampling)** — at 1000s/sec, table grows unbounded and dashboard becomes useless. Sampling/aggregation is required.
- **Federation logs replicated across all peers (consistent audit)** — strong consistency but breaks privacy boundary. Reject; each universe owns its own log.
- **Use OpenTelemetry traces as the audit log instead of a separate events table** — OTel is for observability/debugging, not operator-facing audit. Different audiences, different needs. Keep them separate; OTel exports of the events table become a side-channel for SIEM integration later.

## Implementation notes (not part of decision)

**Phased rollout** (each phase is a separate BOM dispatched independently after v0.8.0 ships):

| Phase | Work | Estimated CC time | Priority |
|---|---|---|---|
| v0.8.1 | LLM call instrumentation (metadata + opt-in body capture + auto-redaction) | 4-6h | high — most operator-valuable for "why did model X say Y?" |
| v0.8.2 | DB instruction logging (writes always, slow reads, errors; aggregated fast reads) | 4-6h | high — recovers our state-change audit |
| v0.8.3 | MCP traffic instrumentation (inbound + outbound) | 3-5h | medium |
| v0.8.4 | Worker lifecycle expansion (granular progress events) | 2-3h | medium |
| v0.9.x | Federated peer A2A logging (landed with ADR-035 federation work) | 4-6h | tied to federation timeline |

**Correlation ID infrastructure** (precondition for everything else):
- Adopt `AsyncLocalStorage` (Node stdlib) as the propagation primitive
- Wrap top-level event handlers to establish a correlation_id context
- Subprocess IPC passes correlation_id in message envelope
- Test fixture: end-to-end test that one operator action produces N events all sharing the same correlation_id

**LLM body storage**: file-per-call at `~/.stavr/llm-bodies/{yyyy-mm-dd}/{event_id}.json`. Daily directory rotation; 7-day retention enforced by the nightly backup job (ADR-037 — extend that job to also prune LLM bodies older than 7 days).

**Auto-redaction module**: separate `src/redaction/index.ts` module. Stateless function `redact(text: string) → string`. Operator can override rules via `~/.stavr/redaction.yaml`. Default rules from a maintained list (open-source PII regex libraries).

## Acceptance for moving Status to Accepted

This ADR moves to "Accepted" when:
1. AsyncLocalStorage correlation propagation lands and is covered by end-to-end test
2. At least one phase from the rollout table (v0.8.1 LLM instrumentation) is implemented and merged
3. Privacy boundary is enforced in code: a test demonstrates that a federated peer's prompt body cannot be retrieved via any dashboard API or MCP tool from our machine
4. LLM body opt-in toggle exists in the dashboard settings, defaults OFF, includes a warning about prompt content
5. Auto-redaction module redacts at least 5 common PII patterns (verified by test suite)
6. ADR-030 retention is extended to handle body-vs-metadata separate retention windows
