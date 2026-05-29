# claude.execute MCP tool — delegation via local CC subprocess BOM

**Goal.** Expose a single MCP tool `claude.execute` through stavR that lets a paired remote actor (a son's Claude Code instance) dispatch a single-shot prompt to a `claude -p` subprocess running on the operator's machine. The subprocess uses the operator's ambient Claude Code credentials (OAuth/Max in the OS keychain), runs the prompt, captures the output, and returns it as the tool's result. Son's CC retains its own LLM for orchestration; this tool is for *specific* heavyweight delegation — not transparent inference proxying.

**Why this design.** Anthropic's OAuth tokens are bound to Claude Code's client identity at the authorization-server layer (verified by Phase 5 OAuth recon: anthropics/claude-code#28091, #37205 closed not-planned). A transparent Anthropic-API proxy with the operator's OAuth is structurally impossible. But running `claude -p` *as the operator on the operator's box* uses the operator's credentials natively — no proxying involved, just process invocation. The MCP tool surface is the right abstraction because son's CC already speaks MCP to stavR, and the existing chokepoint enforces actor + tier with no new substrate needed.

**Depends on.** `proposed/worker-dispatch-bom.md` must land first. That BOM provides the `invoke + job` substrate (Option B locked) with pluggable executor bindings. This BOM adds one specific executor binding plus the MCP tool that calls it.

**Sensitivity:** careful. Touches: chokepoint registration, child-process spawning, audit log, dashboard. Reversible (delete tool ID, kill running jobs).

## What this BOM proves

1. A registered MCP tool `claude.execute` is reachable via the existing `/mcp` surface to any actor whose chokepoint matrix permits it; default-denies for any `peer:*` without a row.
2. A tool call resolves to a `claude-code-subprocess` executor binding (built on the worker-dispatch substrate) that spawns `claude -p` with the son's prompt.
3. The subprocess runs as the operator's user with the operator's ambient credentials. The subprocess output is captured, parsed as `--output-format json`, and the assistant message is returned as the MCP tool result.
4. Concurrency is bounded (per-actor and global caps); timeouts are enforced; output size is capped; the prompt content is hash-audited, not plaintext-logged by default.
5. Operator can list running jobs, view completed-job output, and cancel a running job from the dashboard.
6. Cancellation propagates as SIGTERM (with a 5s grace before SIGKILL) and the audit event records `cancelled_by_operator`.

## What this BOM does NOT cover

- Multi-turn conversation continuity. Each `claude.execute` call is single-shot; son's CC manages its own conversation, and each delegate call is fresh.
- Streaming responses. The tool returns the final assistant message after the subprocess exits.
- Other LLM executor bindings (Ollama, vLLM, OpenAI). Those are additional executor bindings built on the same worker-dispatch substrate — separate cycles.
- Cross-machine federation of jobs (son's stavR → operator's stavR via federation). This BOM scopes to son's CC as a paired remote actor calling `/mcp` directly; federation expansion is a later cycle.

## Hard invariants

1. **Subprocess runs as the operator's user.** No `sudo`, no `runas`, no privilege escalation. Inherits HOME / USERPROFILE so `claude` resolves the operator's `~/.claude.json` / OS-keychain credentials natively.
2. **Bounded timeout per call.** Default 5 minutes wall-clock. Operator-configurable in `stavr.yaml`; hard ceiling 30 minutes. On timeout: SIGTERM, 5s grace, SIGKILL.
3. **Bounded output size.** Default 10 MB cap on captured stdout. Exceeding the cap truncates and audits `output_truncated=true`. No 1 GB log floods.
4. **Concurrency caps.** Default 2 concurrent jobs per `peer:*` actor; default 5 concurrent jobs total across all actors. Both operator-configurable.
5. **Binary path resolved at daemon boot, not per-call.** Operator configures `claude_binary_path` in `stavr.yaml` (default: result of `which claude` at boot). No runtime PATH lookup — defends against PATH-manipulation in the daemon's environment.
6. **Prompt passed via argv or stdin, never shell-interpolated.** Use `spawn` (not `exec` with a string command); pass the prompt as a discrete argv element or via stdin. No shell metacharacter risk.
7. **Prompt content is hash-audited by default.** Audit event captures `prompt_sha256`, `prompt_length`, NOT the prompt text. Operator can opt into verbose audit per actor or globally (`stavr.yaml: claude_execute.verbose_audit: true`) — that opt-in stores prompt plaintext in the audit log.
8. **Default-deny for `peer:*` on `claude.execute`.** Operator authors the matrix row (Option A locked decision). Loopback / operator-shape callers bypass per the existing chokepoint conventions.
9. **Cancellation is operator-only.** The operator can cancel any running job via the dashboard. Sons cannot cancel each other's jobs or their own (intentional — prevents a stuck-CC son from spamming-and-canceling to evade audit).
10. **No mid-call retries.** If the subprocess fails (non-zero exit, timeout, crash), the failure is returned to the son as the tool result with a clear error code. The son's CC decides whether to retry — the gateway does not silently re-run.

## Phase 0 — recon

Read, do not implement. Halt with a recon md.

1. **`claude` CLI invocation shape.** Verified by Phase 5 OAuth recon: CC stores OAuth in OS keychain, invokes via `--debug api` was visible. For this BOM, document: exact CLI for non-interactive single-shot (`claude -p`, `claude --print`, or whichever flag set); `--output-format json` schema (what fields, what's reliably present); how to set `--model` / `--max-tokens` / `--system` from CLI args.
2. **Worker-dispatch executor-binding hook.** After the worker-dispatch BOM lands, the recon identifies where new executors register (the interface name, where they're declared in `stavr.yaml` or code, the lifecycle hooks: `start(args)` / `cancel()` / `getStatus()` / etc.).
3. **MCP tool-registration mechanism.** Confirm the path for registering a new tool ID (`claude.execute`) at the chokepoint and exposing it through `/mcp`. Verified pattern from existing `github.*` tools — the recon just confirms reuse.
4. **Dashboard job-visibility primitive.** Per `project_stavr_no_orphan_components_rule`, every top-level component has a deep-dive path. Recon: is there an existing "jobs" view in the dashboard the new tool can plug into, or does a new view need a small dashboard cycle? If new view: list (running, queued, completed-last-1h) + detail page (prompt sha + output preview + cancel button).
5. **Process-spawn primitive.** Identify the right Node child_process API for the use case (`spawn` with stdio capture, NOT `exec`). Confirm cross-platform behavior (Windows-specific shell handling, signal semantics).

**Deliverable:** `proposed/claude-execute-mcp-tool-recon.md` with all five answers + concrete file:line references + a flagged design space if any (e.g., session-id support if `claude -p` supports resume across calls — out of scope for the single-shot promise but worth knowing about). Halt.

## Phase 1 — `claude-code-subprocess` executor binding

Implement the executor binding using the worker-dispatch substrate. NO MCP tool registration yet — just the executor itself, callable from internal tests.

- New file `src/executors/claude-code-subprocess.ts` (or wherever Phase 0's recon located the binding hook). Exports an executor that:
  - Accepts `{ prompt, model?, system?, max_tokens?, timeout_ms? }` args from a `job.invoke()`.
  - Resolves the `claude_binary_path` from the daemon's resolved config (set at boot).
  - Spawns `claude -p --output-format json --model <model?> --system <system?> --max-tokens <max?>` with the prompt as a discrete argv element.
  - Captures stdout up to the size cap, parses the JSON, extracts the assistant message text + usage tokens.
  - Returns `{ ok, text, usage, exit_code, duration_ms, output_truncated, error_class? }`.
  - On timeout: SIGTERM, 5s grace, SIGKILL; returns `{ ok: false, error_class: 'timeout' }`.
  - On non-zero exit: returns `{ ok: false, error_class: 'subprocess_error', exit_code }`.
  - On output truncation: still returns `ok: true` with `output_truncated: true` and whatever was captured.

Tests:
- Mock the binary path to a test harness script that prints a deterministic JSON shape; verify happy path.
- Mock a slow script; verify timeout produces SIGTERM → SIGKILL within bounds.
- Mock a script that emits >10 MB; verify truncation flag.
- Verify the prompt is NOT shell-escaped (run a script that echoes argv[0..n] back; verify the prompt arrives byte-for-byte).
- Verify no PATH lookup at call-time (point `claude_binary_path` at an absolute path with no PATH set, confirm it still runs).

Deliverable: executor binding + tests, no MCP surface yet. `git commit -s`, push, halt.

## Phase 2 — `claude.execute` MCP tool registration

Wire the executor binding to the MCP tool surface. The chokepoint sees a new tool ID; operator authors matrix rows; son's CC can call it.

- Register `claude.execute` at the chokepoint. Default tier matrix entry for `peer:*`: no row (default-deny). For operator-shape (loopback / KNOWN_ACTORS): AUTO.
- Tool schema (MCP `tools/call` shape): `{ prompt: string, model?: string, system?: string, max_tokens?: number, timeout_ms?: number }`. Returns `{ text, usage, exit_code, duration_ms, output_truncated }` on success; standard MCP error shape on failure.
- The tool handler:
  1. Pulls the call's actor from logContext.
  2. Runs the chokepoint gate (existing pattern — registered tool ID, no new gate code needed).
  3. On allow: calls `job.invoke({ executor: 'claude-code-subprocess', args })` via the worker-dispatch substrate. Awaits the job's result.
  4. Returns the result as the MCP tool's response, with the audit-safe fields stripped/hashed per invariant #7.
  5. On chokepoint NO_GO: returns the standard MCP isError response (same shape as `github.*` NO_GO).

Tests:
- AUTO-tier matrix row → tool call succeeds, executor invoked, result returned (against the mock binary from Phase 1).
- No matrix row → NO_GO (standard chokepoint denial shape).
- CONFIRM-tier matrix row → decision queued, operator approves, call completes (verifies CONFIRM flow at the gateway).
- Tool call without `prompt` arg → MCP schema validation error.
- Tool call with a model/system/max-tokens → those propagate to the subprocess (verify via the mock binary's argv echo).

Deliverable: MCP tool + chokepoint integration + tests. `git commit -s`, push, halt.

## Phase 3 — dashboard job visibility

Per the no-orphan-components rule: every top-level component gets a deep-dive path. Add a "Jobs" view to the dashboard.

- List view at `/dashboard/jobs`: queued / running / completed in last 1h, with per-row columns: actor, tool (currently always `claude.execute`), elapsed/duration, status.
- Detail view at `/dashboard/jobs/:job_id`: full audit trail for the job — actor, prompt SHA256, model, args, full output (subject to verbose-audit setting), exit code, duration, audit timeline.
- Cancel button on running jobs — POST `/dashboard/jobs/:job_id/cancel`. Loopback-only fence, same as other dashboard mutations. Triggers SIGTERM → SIGKILL flow.
- Loopback-only on all dashboard routes (existing pattern).

Tests:
- List view shows currently-running jobs.
- Cancel button sends SIGTERM, subprocess exits, audit records `cancelled_by_operator`, job final state = `cancelled`.
- Detail view of a completed job shows the audit-safe payload (prompt SHA, not plaintext, unless verbose-audit is on globally).

Deliverable: dashboard route handlers + views + tests. `git commit -s`, push, halt.

## Phase 4 — end-to-end smoke against a real paired actor

Walk the runbook against a paired son device on the live daemon. NOT against the Docker substrate this time — against the operator's real daemon at `http://192.168.1.162:7777` (or wherever).

- Operator authors `peer:<son-handle> → claude.execute @ AUTO` matrix row.
- Son's CC connects via existing pairing (no re-pair needed — this is a new tool on an existing surface).
- Son's CC asks something via the tool: "use claude.execute to summarize this paragraph."
- Operator's box spawns `claude -p`, captures output, returns to son.
- Operator inspects audit on dashboard: actor, prompt SHA, model, duration, no plaintext prompt by default.
- Repeat with `claude.execute @ CONFIRM` — son's call blocks, operator approves via dashboard, call completes.
- Repeat with operator-cancellation mid-call.

Deliverable: `tests/claude-execute/SMOKE-RESULTS.md` capturing each sub-check verbatim. `git commit -s`, push, halt for final review before merge.

## Done criteria

- All four phases pass per-phase tests and smokes.
- Son's CC can dispatch a prompt to the operator's box via `claude.execute`, gets the assistant response, with the work running on the operator's Max OAuth.
- Concurrency caps, timeouts, output caps, prompt hash-audit, default-deny, cancellation — all empirically verified.
- The dashboard shows the operator their jobs in real time and lets them cancel.

## Out of scope (follow-ups)

- **Job persistence across daemon restart.** A running job's subprocess dies when the daemon does; the job state should record `interrupted_by_daemon_restart`. Recovery semantics (re-spawn? notify son? leave failed?) is a separate decision; for now, accept that a daemon restart fails any in-flight jobs.
- **Streaming output to the son.** The son's CC gets the final response only. SSE-style streaming would require MCP tool-response streaming support — a separate transport concern.
- **Multi-turn delegation.** Each tool call is single-shot. A "session" abstraction where son's CC reuses a long-lived claude subprocess across calls is a future optimization.
- **Cost/usage routing to son's budget.** The subprocess uses the operator's Max, so usage is on the operator's bill. No per-son metering at this layer — the operator decides whether to throttle a son's call rate via the concurrency cap.
- **Federated dispatch.** Son's stavR sending the job to operator's stavR via federation (vs son's CC calling `/mcp` on operator's stavR directly). Federation expansion is a later cycle.
- **Other model providers as subprocess executors** (Ollama, OpenAI's `codex` CLI, etc.). Each gets its own executor binding built on the same worker-dispatch substrate.
