# BOM — MCP long-running primitives for the mcp-call binding

**Status:** queued behind worker-dispatch + claude-execute (sequence: worker-dispatch merges → claude-execute lands → this).
**Sensitivity (per phase):** see headers — admission control + new binding behaviour, high blast radius for any consumer that uses mcp-call.
**Written:** 2026-05-28.

---

## Why this BOM exists

The worker-dispatch BOM ships the `mcp-call` binding as a **short-call shape**: one MCP `tools/call` per dispatch, request/response. That covers the majority of MCP server use cases. It does NOT cover:

1. **Server-directed long-running work** — the MCP server returns a task handle from `tools/call` and the client drives it with `tasks/get` / `tasks/update` / `tasks/cancel`. Standardized in the MCP 2026-07-28 release candidate's Tasks extension. This is the spec-defined replacement for the bespoke `worker_init/step/finalize` pattern that worker-dispatch Phase 3c deletes.
2. **Resource subscriptions** — `resources/subscribe` + `notifications/resources/updated` for push-shaped streams (sensor readings, market prices, alarm states). This is the primary contract `C:\dev\nibe-bridge` (homefleet) standardized on in its Phase 19a v2 MCPSource adapter, and it's the contract any well-behaved MCP IoT/sensor source will expose.
3. **Progress notifications passthrough** — `notifications/progress` from server-side tool calls forwarded as `job_progress` events on the binding handle so the orchestrator sees mid-flight state without polling.

The closed-enum-of-four binding kinds (`'mcp-call' | 'http' | 'process-spawn' | 'cc-session-attach'`) is a hard invariant from the worker-dispatch BOM Phase 1. This BOM **extends mcp-call** — it does NOT introduce a fifth kind.

## Locked decisions

- **No new binding kind.** All three primitives are added as new dispatch modes on the existing `mcp-call` binding. The dispatch params discriminate (`mode: 'oneshot' | 'task' | 'subscribe'`); default `'oneshot'` keeps every existing caller working unchanged.
- **MCP-spec-compliant primitives only.** Tasks per the 2026-07-28 release candidate; resources subscribe per the current spec. No bespoke shapes. No translation layer that lets servers respond in proprietary formats.
- **Sensitivity classification is the consumer's job, not the binding's.** mcp-call passes payloads through verbatim. Sensitivity-aware filtering for federation / sub-actor exposure happens at the stavR chokepoint (per the trust-scope enforcement path) or at the source itself (homefleet's pattern). The binding stays a transport.
- **Backwards-compat is non-negotiable.** Every existing caller of mcp-call must continue to work with no params change. The new modes are additive.
- **homefleet is the canonical consumer-test.** Phase 5's smoke test points mcp-call at a running `elpris-mcp` (Phase 19b v2 of homefleet) and exercises resource-subscribe end-to-end. If homefleet's MCP surface and stavR's mcp-call binding don't talk cleanly, both are wrong.

## Phase 0 — Recon

CC reads:

- Current `crates/homefleet-mcp-source/` once Phase 19a v2 of homefleet lands. The reference implementation lives there in Rust; mcp-call needs to do the same thing in Node + the MCP TypeScript SDK.
- The MCP 2026-07-28 release candidate spec for Tasks extension shape (`tasks/get`, `tasks/update`, `tasks/cancel`, error codes, server-capability advertisement).
- The current `@modelcontextprotocol/sdk` JS package version on `feat/worker-dispatch` (post-3c merge) — confirm what task / subscribe / notifications/progress support is already exposed by the SDK, and what we'd have to drive at the JSON-RPC level.
- `src/jobs/binding-mcp-call.ts` post-worker-dispatch-merge — the structure to extend.

CC outputs a 1-page recon report:

- SDK gap analysis (what's supported via SDK methods vs what needs raw `request()` calls).
- Tasks-extension server capability advertisement shape (so we know how to detect support).
- The `homefleet+param://` URI scheme conventions (so subscribe URIs are interoperable with the homefleet ecosystem).
- Risk: if the MCP TypeScript SDK doesn't yet expose Tasks-extension support at all, this BOM either waits for SDK update or implements at the JSON-RPC level. Flag which.

**Commit:** `docs(mcp-long-running): Phase 0 — recon` on a new branch `feat/mcp-long-running-primitives`.

## Phase 1 — Tasks extension support (mcp-call, mode: 'task')

**Sensitivity:** `high`. Touches the substrate binding; adds new dispatch shapes that every future consumer can use.

CC reads Phase 0's recon, then:

- Extend `src/jobs/binding-mcp-call.ts` to accept `params: { mode: 'task', tool_name, tool_args, prefer_tasks?: true }`.
- When `mode: 'task'`: call `tools/call`. If response carries a task handle (Tasks extension), drive the task lifecycle: `tasks/get` polling or `notifications/tasks/updated` subscription per spec. Surface `tasks/update` results as `job_progress` events. Surface `tasks/cancel` via `binding.terminate(force)`.
- If the server doesn't advertise Tasks capability and `prefer_tasks: true` was set, fail with `OrchestratorError('tasks_unsupported_by_server')` rather than silently falling back to oneshot — the caller chose long-running; silent fallback hides a contract mismatch.
- Persist task handle on the `JobRecord.metadata` so a daemon restart can resume polling (where the server supports task resumption per the spec).
- Tests in `tests/jobs/binding-mcp-call-task.test.ts`: happy path (oneshot continues working), task happy path with synthesized server, server-side cancellation propagates to job_terminated:'crashed', client-side terminate calls tasks/cancel, server doesn't support tasks → error path, daemon-restart resumption.

**Commit message:**
```
feat(jobs): mcp-call binding — Tasks extension support (server-directed long-running)

- params.mode 'task' enables MCP 2026-07-28 Tasks extension
- task handle persisted on JobRecord.metadata for restart resumption
- job_progress emitted on tasks/update; terminate maps to tasks/cancel
- prefer_tasks fails fast when server lacks capability (no silent fallback)
- Phase 1 of proposed/mcp-long-running-primitives-bom.md (high sensitivity)
```

## Phase 2 — Resource subscriptions (mcp-call, mode: 'subscribe')

**Sensitivity:** `high`. New long-lived handle shape; the events channel is now a stream, not a finite sequence.

- Extend mcp-call to accept `params: { mode: 'subscribe', resource_uri, read_on_start?: true }`.
- Implementation: call `resources/subscribe` on the URI. Wire `notifications/resources/updated` to emit `job_progress { message: 'resource_updated', payload: { resource_uri, ...notification_body } }`. If `read_on_start: true`, call `resources/read` once at startup and emit the result as `job_progress` so consumers get the current value without waiting for the first push.
- `binding.terminate()` calls `resources/unsubscribe` and detaches; `events.exit` fires with `reason: 'terminated'`.
- If the server doesn't support subscriptions, fail with `OrchestratorError('subscriptions_unsupported_by_server')`. Same anti-silent-fallback rule as Phase 1.
- Persist the subscription URI on `JobRecord.metadata` so the dashboard can show what each long-lived job is subscribed to.
- Tests: happy path with synthesized server emitting 3 updates, read-on-start path, server-side close maps to exit:'crashed', client-side terminate unsubscribes, multiple subscribes on one binding handle (decide: error or multiplex; default error, one URI per dispatch — keeps the lifecycle model simple).

**Commit message:**
```
feat(jobs): mcp-call binding — resources/subscribe support (push-shaped streams)

- params.mode 'subscribe' opens a long-lived handle on a homefleet+param:// URI
- read_on_start delivers current value before first push
- notifications/resources/updated emitted as job_progress events
- terminate() unsubscribes cleanly
- Phase 2 of proposed/mcp-long-running-primitives-bom.md (high sensitivity)
```

## Phase 3 — Progress notifications passthrough

**Sensitivity:** `careful`. Smaller surface, mostly mechanical.

- For all three modes (oneshot, task, subscribe): if the MCP server emits `notifications/progress` (the spec's mid-call progress channel), forward as a `job_progress` event with the spec's `progressToken`, `progress`, `total` fields.
- The MCP SDK exposes a callback for this; wire it through. If the SDK doesn't expose it, attach a JSON-RPC notification handler at the transport layer.
- Tests: oneshot with mid-call progress emits 3 job_progress before exit, subscribe doesn't double-emit progress + update (the two are different notification channels), task mode forwards progress AND tasks/update separately.

**Commit message:**
```
feat(jobs): mcp-call binding — progress notifications passthrough

- notifications/progress from any mode forwarded as job_progress
- progressToken / progress / total fields preserved on the payload
- Phase 3 of proposed/mcp-long-running-primitives-bom.md (careful sensitivity)
```

## Phase 4 — Documentation + dashboard surface

**Sensitivity:** `routine`.

- Update `src/jobs/binding-mcp-call.ts` JSDoc header to document the three modes + when to use each.
- Update the dashboard `jobs` page (post-3c) to show the subscribed-URI metadata for `mode: 'subscribe'` jobs and the task handle for `mode: 'task'` jobs. These are read-only metadata badges; no new interactions.
- Add a section to `src/dashboard/pages/about.ts` (or equivalent) documenting which MCP primitives stavR supports so consumers can self-check capability.
- BOM commit-message tracking: `docs(jobs)` series.

## Phase 5 — homefleet integration smoke test

**Sensitivity:** `careful`. Cross-repo smoke; verifies stavR + homefleet talk cleanly.

- Spin up homefleet's `elpris-mcp` Python sidecar (per `C:\dev\nibe-bridge\proposed\phase-19b-v2-elpris-mcp.md`). It exposes 53 `homefleet+param://elpris/se4/...` resources with subscribe support.
- Add an operator-runnable script (`scripts/smoke/mcp-long-running-elpris.ts` or PowerShell equivalent) that:
  1. Dispatches a `mode: 'subscribe'` job against `homefleet+param://elpris/se4/current_sek_per_kwh`.
  2. Waits 60 seconds; expects at least one `job_progress` event (or a read_on_start emission).
  3. Terminates the job; verifies `resources/unsubscribe` was sent.
  4. Dispatches a `mode: 'oneshot'` job calling `resources/read` on the same URI; verifies value parity with the subscribe path.
- Smoke output is part of the BOM completion report.
- If this smoke fails, EITHER stavR's binding is wrong OR homefleet's MCP surface is wrong. Both are diagnosable; the smoke is the convergence point.

## Phase 6 — (Optional) Federated long-running job handoff

**Sensitivity:** `high` — touches federation path. Deferred. **Do not execute without re-dispatch.**

When a federated peer dispatches a long-running mcp-call job that originates on the operator's daemon, the task/subscription state must traverse the federation outbox cleanly. Likely a Phase-after-federation-lands cycle. Captured here so it's not forgotten.

## Out of scope

- Multi-URI subscription multiplex on one binding handle — keep it one URI per dispatch. Consumers wanting many subscribe to many.
- MCP elicitation / sampling primitives — orthogonal feature surface, not needed for "run jobs against any MCP."
- Translation layer for non-spec-compliant MCP servers — if a server doesn't speak the spec, fix the server. mcp-call doesn't carry compatibility shims.
- Replacement for `claude.execute` — that's the claude-execute BOM, a different path (subprocess delegation), and stays separate.

## Verification per phase

Standard four greens for each phase commit: `npm run build` clean, `npx vitest run` passing (delta tracked vs prior phase), `npx tsc --noEmit` clean. DCO sign-off on every commit (`git commit -s`). One commit per phase. Push at end of each phase.

High-sensitivity phases (0, 1, 2, 5, 6) HALT for operator review before push. `careful` and `routine` proceed without an approval gate but still report.

## Open questions for the operator (do not answer in this BOM)

1. Should the dashboard surface `mode: 'subscribe'` jobs as a separate "Subscriptions" panel or in the same job list? Phase 4 decision.
2. Token-bucket rate-limiting on per-server subscriptions — does mcp-call enforce, or does the homefleet sensitivity layer? Likely the latter, but worth a 10-3-1 if it surfaces in Phase 2.
3. Whether claude-execute's subprocess pattern eventually becomes a special-case `mode: 'process'` on mcp-call — probably not (different binding kind, different lifecycle), but worth re-evaluating after both ship.
