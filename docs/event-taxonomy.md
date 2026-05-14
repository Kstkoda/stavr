# Stavr event taxonomy

Switch is an event bus. Every tool that mutates state, every decision, every
worker lifecycle transition lands in the events table and fans out to
subscribers as MCP `notifications/event/published`. This document is the
machine-and-human-readable contract.

The Zod source of truth lives in [`src/event-types.ts`](../src/event-types.ts).
The catalogue generator does **not** re-derive this file — it is hand-written.
When the source changes, update this file in the same PR.

## Envelope

Every event has the same envelope:

| Field | Type | Notes |
|---|---|---|
| `kind` | string (`EventKind`) | One of the values listed below. |
| `at` | ISO-8601 datetime | When the event was produced. Set by the emitter, not the broker. |
| `correlation_id` | string \| undefined | Optional. Threads request → response → late-response, or a decision through a gated tool call. |
| `tenant_id` | string \| undefined | Optional. Reserved for multi-tenant deployments; not used by current callers. |
| `source_agent` | string | Who emitted it. Conventional values: `cc`, `co`, `cowork`, `cowork-user`, `cowork-user-relayed`, `switch-default`, `switch-startup-sweep`, `user-direct`. |
| `payload` | object | Kind-specific. Validated against the Zod schema for `kind` (see [`validatePayloadForKind`](../src/event-types.ts)). |

The broker assigns `id` (event id) and `persisted_at` after the write.

## Subscriber model

`subscribe_to_events` lets a session declare which `kind`s it wants. The broker
fans out matching events as MCP notifications. `since_event_id` replays missed
events to recover from disconnects. Subscriptions are session-scoped — when the
MCP session disconnects, the broker drops them.

`get_events` is a pull-based alternative for batch / cron-style consumers.

---

## Core lifecycle events

### `session_started`

- **Fires when:** Cowork opens a new CC session (handoff written).
- **Payload schema:** [`SessionStartedPayload`](../src/event-types.ts).
- **Carries correlation_id?** No — this is the root of a session.
- **Typical subscribers:** Cowork dashboard, audit log.

### `phase_started` / `phase_completed`

- **Fires when:** The CC worker enters/leaves a numbered phase of a multi-step
  task.
- **Payload schema:** [`PhaseStartedPayload`](../src/event-types.ts) /
  [`PhaseCompletedPayload`](../src/event-types.ts).
- **Carries correlation_id?** Optional. Used to group phases under a session.
- **Typical subscribers:** Cowork progress UI.

### `file_written`

- **Fires when:** CC writes (or rewrites) a tracked file.
- **Payload:** `path`, `lines_added`, `lines_removed`.
- **Carries correlation_id?** Optional.
- **Typical subscribers:** progress UI, file-diff watchers.

### `command_run`

- **Fires when:** CC ran a shell command (`npm test`, `tsc`, …).
- **Payload:** `command`, `exit_code`, `duration_ms`.
- **Typical subscribers:** verification dashboards.

### `verification`

- **Fires when:** A check completed (e.g. tests, typecheck, build).
- **Payload:** `check`, `status: pass|fail`, optional `detail`.
- **Typical subscribers:** CI mirror, status badges.

### `commit_pushed` / `pr_opened`

- **Fires when:** A commit is pushed / a PR is created.
- **Payload (`pr_opened`):** `url`, `title`.
- **Carries correlation_id?** Yes for `pr_opened` — the `correlation_id` from
  the gated decision that approved the create.
- **Typical subscribers:** PR-watcher bots, dashboards.

### `progress`

- **Fires when:** Free-form progress signal.
- **Payload:** `message: string`.
- **Use sparingly** — prefer typed kinds where one exists.

### `error`

- **Fires when:** A worker hits a recoverable or fatal error.
- **Payload:** `message`, optional `stack`, `recoverable: boolean`,
  `attempted_recovery?`.
- **Typical subscribers:** Cowork error log, alerting.

### `checkpoint`

- **Fires when:** A worker pauses with state worth resuming from.
- **Payload:** `branch`, `last_commit_sha`, `files_dirty[]`, `next_step`.

### `session_ended`

- **Fires when:** A CC session terminates.
- **Payload:** `reason: 'completed'|'errored'|'killed'|'rate-limited'`,
  `summary`, `pr_urls[]`.

---

## Decisions

Decisions are bidirectional: a tool opens one with `await_decision` and a
human/automation closes it with `respond_to_decision`. All three events share
the same `correlation_id` (the decision id).

### `decision_request`

- **Fires when:** `await_decision` opens a new decision.
- **Payload:** `question`, `options[]`, optional `default_option_id`,
  `deadline_seconds`.
- **Carries correlation_id?** Yes — the decision id.
- **Typical subscribers:** Cowork (renders the prompt), notification bots.

### `decision_response`

- **Fires when:** `respond_to_decision` resolves a decision, _or_
  `await_decision` falls back to `switch-default` on timeout.
- **Payload:** `chosen_option_id`, optional `reason`, `responder`.
- **Carries correlation_id?** Yes.
- **Typical subscribers:** the gated tool call waiting on the decision.

### `decision_late_response`

- **Fires when:** A `respond_to_decision` arrives after the decision already
  closed (e.g. via switch-default fallback), or after Switch restart for an
  expired decision.
- **Payload:** `chosen_option_id`, optional `reason`, `responder`,
  optional `fallback_was`.
- **Carries correlation_id?** Yes.
- **Note:** Does **not** override the original close. Logged for audit only.

---

## Worker orchestration (spec 42)

All worker events carry the worker `id` in their payload. `correlation_id` is
typically the spawning gated-decision id (when the spawner is CONFIRM tier).

### `worker_spawned`

- **Fires when:** A worker starts (after any CONFIRM gate).
- **Payload:** `id`, `name`, `type`, `cwd`, optional `pid`, `metadata`.
- **Typical subscribers:** Cowork orchestrator, dashboards.

### `worker_progress`

- **Fires when:** A worker reports user-facing progress.
- **Payload:** `id`, `message`, optional `detail`.
- **Note:** For high-volume per-line output (e.g. CC stream-json), see
  [Stream-JSON sub-taxonomy](#stream-json-sub-taxonomy-cc-workers) below.

### `worker_metadata_changed`

- **Fires when:** A worker mutates its metadata bag (e.g. `pr_url`,
  `commit_sha`, run-state hints).
- **Payload:** `id`, `patch: Record<string, unknown>`. The patch is shallow-merged.

### `worker_activity`

- **Fires when:** Heartbeat — proves the worker is alive even when it has
  nothing concrete to report. Powers the staleness watchdog (spec 44).
- **Payload:** `id`, optional `detail`.

### `worker_dispatch_request`

- **Fires when:** Another agent calls `worker_dispatch` to send an instruction.
- **Payload:** `target_worker_id`, `message_id`, `body`.
- **Carries correlation_id?** Optional — set by the dispatching caller.

### `worker_terminated`

- **Fires when:** A worker exits (gracefully or otherwise).
- **Payload:** `id`, `reason: 'completed'|'crashed'|'terminated_by_user'`,
  optional `exit_code`.

### `worker_error`

- **Fires when:** A worker reports a recoverable or fatal error of its own.
- **Payload:** `id`, `message`, `recoverable: boolean`.

---

## Trust scopes (spec 46)

Trust scopes pre-authorize matching tool calls so CONFIRM-tier work can run
without a per-action `await_decision`. Every grant/revoke/extend lands here.

### `trust_scope_proposed`

- **Fires when:** `trust_scope_propose` is called. Logged but not active.
- **Payload:** full scope envelope (title, description, allowed/forbidden
  actions, reporting cadence, expiry).

### `trust_scope_granted`

- **Fires when:** `trust_scope_grant` is approved.
- **Payload:** `scope_id`, `title`, `granted_by`, `granted_at`, `expires_at`,
  optional `expires_after_actions`.
- **Carries correlation_id?** Yes — the gated decision id.

### `trust_scope_revoked`

- **Fires when:** `trust_scope_revoke` (no gate — escape hatch) or
  store sweep retires an expired scope.
- **Payload:** `scope_id`, `revoked_by`, optional `reason`.

### `trust_scope_extended`

- **Fires when:** `trust_scope_extend` is approved.
- **Payload:** `scope_id`, optional `new_expires_at`, optional
  `new_expires_after_actions`, `extended_by`.

### `trust_scope_progress`

- **Fires when:** The trust-scope reporter (configured by `reporting.cadence`)
  fires.
- **Payload:** `scope_id`, `actions_executed`, optional `expires_after_actions`,
  `expires_at`, `cadence`, optional `message`.

### `trust_scope_completed`

- **Fires when:** A scope hits its action cap, wall-clock expiry, or revoke.
- **Payload:** `scope_id`, `reason: 'action_cap_reached'|'expired'|'revoked'`,
  `actions_executed`, `completed_at`.

### `trust_scope_action_authorized`

- **Fires when:** A CONFIRM-tier tool call matched an active scope and ran
  without a decision gate.
- **Payload:** `scope_id`, `tool`, `args`.
- **Typical subscribers:** audit pipeline. Every autonomous action lands here.

---

## Stream-JSON sub-taxonomy (CC workers)

Claude Code emits a structured `--output-format=stream-json` stream when run
non-interactively. Stavr's contract for surfacing this output:

- The CC worker process forwards each parsed line through a dedicated event
  `worker_log` (kind reserved; emit shape below). The `worker_progress` event
  remains the "user-facing summary" channel; `worker_log` is the raw stream.
- One Stavr event per stream-json record. The `payload.format` field is
  `'stream-json'` so subscribers can dispatch on it.
- The original CC record is preserved verbatim under `payload.event`. Stavr
  does not lossy-transform it.

```ts
// Carrier payload (reserved — emit only from CC-class workers):
{
  id: string,                    // worker id
  format: 'stream-json',
  event: {
    // Pass-through of the CC stream-json record. Examples:
    type: 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'user',
    // … plus whatever fields the CC record carried.
  },
}
```

Subscribers reconstruct higher-level views by filtering on `event.type`:

| `event.type` | Meaning |
|---|---|
| `system` | Session init / model selection / warning from the CC runtime. |
| `assistant` | A text or thinking turn from the model. |
| `tool_use` | The model invoked a tool. Includes `name`, `input`. |
| `tool_result` | The harness returned a tool result. Includes `is_error`, `content`. |
| `user` | A synthetic user turn (e.g. compaction summary, tool result wrapper). |
| `result` | End-of-conversation summary record (cost, usage, duration). |

This mirroring is the canonical CC↔Switch event contract: any future stream
format CC introduces should land here under a different `payload.format` value,
not by inventing parallel kinds.

### `worker_log` (reserved)

- **Status:** reserved — schema documented; emit-site lives in
  `src/workers/cc.ts` and ships in Wave C.
- **Payload:** see above. `format` is currently always `'stream-json'`.
- **Carries correlation_id?** Yes — the worker spawn correlation id.
- **Typical subscribers:** dashboards that render CC turns,
  per-tool-use audit, cost meters.

---

## Reserved / proposed (not yet emitted)

These kinds are reserved by adjacent specs. They are **not** in the
`EventKind` enum today; consumers should accept-but-ignore unknown kinds.

### `worker_stuck` (spec 47)

- **Fires when:** The watchdog notices a worker has been silent past its
  stuck-threshold (no `worker_progress` / `worker_activity` / `worker_log`).
- **Proposed payload:**

  ```ts
  {
    id: string,
    last_activity_at: string,
    silent_for_ms: number,
    threshold_ms: number,
    suggested_action: 'nudge' | 'dispatch' | 'terminate',
  }
  ```

- **Typical subscribers:** Cowork orchestrator (auto-nudge), Slack/email alerts.

---

## Adding a new event kind

1. Add the string to `EventKind` in [`src/event-types.ts`](../src/event-types.ts).
2. Add a Zod payload schema (or skip if `payload: z.unknown()` is OK).
3. Register it in `validatePayloadForKind` so `emit_event` rejects bad
   payloads at the broker.
4. Document it in this file under the appropriate section.
5. If a tool emits it, mention it in that tool's card (`docs/tool-cards/`).
