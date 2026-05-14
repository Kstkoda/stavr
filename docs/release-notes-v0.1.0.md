# Stavr v0.1.0 — initial public release

**Date**: 2026-05-12
**Tag**: `v0.1.0`
**Status**: Pre-1.0 software. API surfaces may evolve; the architecture described below is the stable shape.

---

## What is Stavr

Stavr is a local-first trust broker for AI agents. It runs as a small daemon on the User's own machine, mediates between AI assistants and the systems on that machine, and records every action in an append-only audit log the User owns.

Stavr is **not** a model. It is the layer that turns a generic AI assistant — Claude, ChatGPT, Anthropic's Claude Code, future agents — into something that can act on the User's behalf with explicit, auditable, revocable authority. It binds to `127.0.0.1` only, requires no third-party cloud service, and stores all state on the User's local disk.

The intent of v0.1.0 is twofold: to deliver a working broker that solves the immediate problem of multi-agent orchestration with audit and consent guarantees, and to establish a public record — dated, indexed, hosted on GitHub — of the architectural primitives Stavr introduces.

---

## Architecture summary (prior-art record)

This section is a deliberate, public, dated description of the Stavr architecture. It is published as part of the v0.1.0 release on **2026-05-12** for the purpose of defensive disclosure: anyone subsequently filing patent claims on the architectural primitives described here will face this document as prior art on the indicated date.

### The four roles

Stavr defines four distinct roles in its system. The boundaries between them are first-class — encoded in event taxonomy, persistence schema, and protocol — not merely conceptual.

- **User** — the human accountable for what the system does. The User holds identity (name, contact), decision authority of last resort, and the right to revoke trust at any time.

- **Operator** (interim term; "Steward" is the v0.2 name per spec 48) — the AI agent the User has chosen as their representative. The Operator holds project context, dispatches Workers, translates the User's intent into concrete tasks, summarizes work back to the User, and requests approvals when needed. There is exactly one Operator per User session.

- **Worker** — a single-purpose subprocess (in v0.1: a Claude Code session in a dedicated git worktree) spawned by the Operator to do a specific piece of work. Workers are isolated from each other and from the User's primary working tree. Workers terminate; the Operator persists across them.

- **Daemon** — Stavr itself. The local broker that hosts the append-only event log, holds the trust scope state, mediates tool calls, runs the worker orchestrator, serves the audit dashboard, and (in a future phase, spec 49) may host the Operator subprocess directly.

This four-way separation is the precondition for everything that follows. Without it there is no answer to "who decided this?" or "what is the User accountable for that the Operator did?"

### The five-layer approval pipeline

Every action a Worker (or any MCP client) requests passes through five gates in order. The ordering is the substantive claim:

1. **Tool tier check.** Each tool registered with the Daemon carries a tier annotation: `AUTO` (run without prompting), `CONFIRM` (gated by `await_decision`), or `NEVER` (refused outright). `AUTO`-tier actions skip the rest of the pipeline and execute immediately. The tier is a property of the tool, fixed by the adapter that registered it.

2. **Trust scope match.** For `CONFIRM`-tier actions, the daemon checks whether an active trust scope covers the call. A trust scope is a User-granted bundle: an allow-list of `(tool, param-pattern)` entries, a time bound, an action-count cap, optional forbidden patterns within the scope, and a reporting cadence. Scopes are first-class persistent objects with explicit grant/revoke/extend/expire lifecycles. The User authorizes a scope once; the Operator executes within it many times without further prompts.

3. **Explicit user approval.** If no active scope covers the call, the daemon opens an `await_decision` event with a deadline (default 5 minutes), routes it to the User's surface (Cowork chat, dashboard, etc.), and waits. The User chooses Approve or Reject. On timeout, a configured default fires (typically Reject) and the action is logged as `decision_late_response` if the User answered after.

4. **No-go list deny-override** (planned in spec 48, partially staged in v0.1). After the scope or approval check has *cleared* the action, a separate hard-coded deny matcher runs. Pattern hits — destructive filesystem operations, force-push to default branches, schema-dropping SQL, `curl | sh`, reads of SSH/AWS credentials, attempts to modify the no-go list itself — open a per-action approval *even if* a scope or prior approval would have allowed it. The no-go list is shipped with Stavr and cannot be weakened by any User-grantable scope. Users may *add* entries via a local hook file; they cannot *remove* the built-in entries. This is the safety floor.

5. **Execution + append-only audit.** Cleared actions execute. Every step — the tool call, the scope id (if any), the approval correlation id, the result, the elapsed time, the tokens used by any LLM call involved — is appended to the SQLite event log. The log is the system of record. Nothing in Stavr's runtime modifies past events.

This five-layer ordering is the specific contribution. Each piece exists in prior systems (tier annotations are in Anthropic's MCP; scoped delegation is in OAuth and IAM since the early 2010s; deny-overrides are an established security pattern; structured audit logs are everywhere). The combination ordered specifically as `tier → allow-list scope → explicit per-action approval → deny-override floor → execute-with-audit` is what Stavr publishes here.

### Worker isolation

Each Worker is given a fresh git worktree under `<repo>/.stavr-worktrees/<worker-name>` on a dedicated branch checked out from a configurable base. The Worker runs `claude --print --output-format stream-json` headlessly inside that worktree. Its stdin receives the prompt as a structured stream-json user message (no command-line length limit); its stdout streams JSONL events back to the Daemon; its stderr is captured line-by-line. The Worker's `child.pid` is the actual Claude Code process — not a launcher husk — so the Daemon can SIGTERM cleanly when needed.

Workers cannot read or write outside their worktree without an explicit, audited tool call. The git worktree isolation provides the filesystem boundary; the MCP tool registry provides the action boundary; the trust scope or per-action approval provides the consent boundary. Together they are the sandbox.

### Event sourcing

The append-only event log is the substrate. The current event taxonomy is enumerated in [`docs/event-taxonomy.md`](event-taxonomy.md). Key kinds:

- `worker_spawned`, `worker_progress`, `worker_log`, `worker_terminated`, `worker_stuck` — the worker lifecycle
- `decision_request`, `decision_response`, `decision_late_response` — the approval pipeline
- `trust_scope_proposed`, `trust_scope_granted`, `trust_scope_revoked`, `trust_scope_extended`, `trust_scope_action_authorized`, `trust_scope_completed` — scope lifecycle
- `tool_call`, `tool_result`, `error` — the execution layer
- `pr_opened`, `commit_pushed`, `file_written` — domain-specific results

Claude Code stream-json events (system/init, assistant message, tool_use, tool_result, result) flow into the log as structured `worker_log` event payloads. The dashboard and the `stavr tail` CLI render them with semantic color and filter chips.

### Daemon model

The daemon binds exclusively to `127.0.0.1:7777`. It exposes:

- An MCP server at `/mcp/sse` (SSE transport) and `/mcp/messages` (POST)
- A raw SSE event stream at `/events/sse` for the CLI tail
- A dashboard surface under `/dashboard/*` (HTML + JSON endpoints + live tail)
- A status endpoint at `/status` and `/healthz`

There is no auth layer. There is no CORS. The daemon is single-user, local-only by design (see [ADR-006](../adr/006-daemon-binds-127001-only.md)). Multi-user, network-exposed, or federated deployments are out of scope for v0.1 and tracked in spec 49.

---

## What ships in v0.1

- Daemon, broker, persistence, MCP server, dashboard, CLI (`stavr daemon start|stop|restart|status`, `stavr status`, `stavr events`, `stavr tail`, `stavr shim`, `stavr connect-test`).
- Trust scope mechanism (propose/grant/revoke/extend, time + action capped, in-scope matcher with param constraints).
- Worker orchestrator with git-worktree isolation and Claude Code spawner (post-spec-47-Layer-0 direct-spawn with stream-json event capture).
- GitHub write adapters (10 tools): create_pr, merge_pr, create_issue, create_issue_comment, create_pr_comment, add_labels, remove_labels, close_issue, reopen_issue, request_pr_review.
- GitHub read adapters: read_pr, read_pr_diff, read_pr_review_comments, read_issue, read_commit, read_file, read_workflow_run, list_branches, list_commits, list_issues, list_labels, list_pr_files, list_prs, list_workflow_runs.
- Audit dashboard with live event tail, worker drill-in, inline decision approval, CSV/JSON export.
- Tool catalogue (`docs/tool-catalogue.json`) regenerated from the Zod schemas in `src/server.ts`.
- Event taxonomy documentation.
- Stuck-worker watchdog.

## What is explicitly NOT in v0.1 (roadmap)

- Operator (Steward) as a named first-class role with claim-token lifecycle — **spec 48**.
- OAuth credential vault for upstream services (GitHub, Slack, Anthropic) — **spec 48**.
- No-go list as a coded module with the starter pattern set — **spec 48**.
- Daemon-hosted Operator subprocess that runs the LLM loop locally — **spec 49**.
- Dashboard chat panel and CLI `stavr ask` for talking to the daemon-hosted Operator — **spec 49**.
- Cost/usage visibility surfaced in the dashboard (per-worker cost, per-session total, per-credential source) — **spec 49**.
- Cross-machine federation between Operators — deferred.
- Team Operators (one User, multiple chat-surface clients sharing a session) — deferred.

---

## Provenance and acknowledgments

Stavr was authored by Kenneth Stenlund in 2026, with substantial code contributions from Anthropic's Claude (Opus and Sonnet models) operating as Claude Code workers under Stavr's own trust-scope mechanism. The `[cc-opus]` and `[cc-sonnet]` provenance tags in the commit log mark every machine-assisted commit. The architecture, design, and review decisions were authored by Kenneth.

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is by Anthropic. The `stream-json` output format used for Worker event capture is by Anthropic's Claude Code team. The Contributor Covenant is by Coraline Ada Ehmke and contributors.

---

## License

Apache License 2.0. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE) for full terms.
