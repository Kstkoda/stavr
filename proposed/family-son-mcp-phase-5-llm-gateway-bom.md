# family-son-mcp Phase 5 — LLM gateway endpoint BOM

**Goal.** Expose an Anthropic-API-compatible HTTP endpoint on stavR that proxies inference requests from a paired remote actor (a son) to the operator's Anthropic credential, with per-actor metering and chokepoint-gated authorization. The son's Claude Code sets `ANTHROPIC_BASE_URL=http://<operator-ip>:7777/anthropic` and uses the operator's Claude Max budget instead of carrying his own subscription. Credentials never leave the operator's daemon process.

**Closes** the family-resource-gateway model end-to-end. Phases 2–4 (now landed via the Docker-substrate test, PR `feat/family-son-mcp`) proved the auth + chokepoint substrate; this adds the resource that makes the substrate worth having.

**Sensitivity:** **HIGH**. Touches the operator's Anthropic credential, per-call billing, and a network-exposed LLM endpoint. All writes promoted to Tier 3 EXPLICIT regardless of action class (per CLAUDE.md §9). Per-phase operator approval gate.

## What this BOM proves

1. The endpoint accepts Anthropic-API-shape requests on a stavR route (`/anthropic/v1/messages`), forwards them to the operator's Anthropic credential, and returns the response transparently to the calling actor.
2. The operator's Anthropic credential is held in the credential vault; never appears in request logs, never in error messages, never returned to the calling actor.
3. The chokepoint enforces per-actor authorization: a `peer:*` actor with no LLM-grant matrix row → NO_GO. With a grant row → proceed, subject to budget.
4. Per-actor token budget: each request decrements a budget counter atomically with the response; budget exhaustion produces a clear error to the actor without leaking the operator's remaining budget.
5. Audit trail: every gateway call produces an event with `actor_id`, `tokens_in`, `tokens_out`, `model`, `cost_estimate`. No request body in the audit log by default (privacy/PII).
6. Revocation: revoking the actor's device immediately cuts off gateway access (same path as PR #83's 4e revocation smoke).

## What this BOM does NOT cover

- OpenAI-compatible endpoint (separate cycle if/when needed).
- Ollama-compatible endpoint (already brokered by the existing Ollama provider).
- Streaming SSE response forwarding (Phase 5b follow-up).
- Federated metering across multiple operator daemons (single-daemon scope).
- Cowork or browser-driven Anthropic UI.

## Hard invariants

1. **Credential never leaves the daemon process.** The Anthropic API key is loaded from the credential vault into an in-memory variable used only by the forward fetcher. It MUST never appear in event payloads, response bodies, error messages, or log lines. Test: grep the audit log + error log after every smoke run — no key bytes.
2. **Every request bearer-authed at the transport layer.** `/anthropic/*` is added to the bearer-auth middleware's enforcement list, NOT to the public allow-list. Identical 401 shape to `/mcp` for unauthed/revoked.
3. **Chokepoint before forwarding.** Actor's matrix row checked before the fetcher runs. NO_GO actors get a structured denial, no forward attempt, no token spend.
4. **Budget decrement atomic with response.** Successful forward must increment `tokens_consumed` in the same transaction that records the audit event. No race where the actor gets tokens we didn't bill.
5. **No request body in audit log by default.** Request prompts may contain PII. Audit captures metadata only.
6. **Budget exhaustion is a clear, immediate error.** Son's CC sees `429 budget_exceeded` with reset time; not a timeout, not an empty 200.
7. **Operator must be able to inspect, increase, or zero-out an actor's budget** via dashboard endpoint. Loopback-only, same fence as the permissions matrix.
8. **No source changes outside the gateway path.** No edits to MCP transport beyond mounting the new route, no chokepoint changes beyond registering the new resource, reuse `src/steward/providers/anthropic.ts` for the actual fetch.

## Phase 0 — recon (HIGH-sensitivity operator-approval gate)

Read code, write findings, halt. Identify:

1. Existing Anthropic provider abstraction (`src/steward/providers/anthropic.ts`) — what it exposes, how it loads the API key, whether it can be reused as-is.
2. Credential vault — how secrets are loaded, the contract for "use credential without exposing it."
3. The bearer-auth middleware mount point in `src/transports.ts` — where to insert `/anthropic/*` so it's behind auth but distinct from the MCP transport.
4. Chokepoint integration — how `runChokepointDecision()` is called for non-MCP routes. May need a small adapter so a REST-shaped request produces the same gate flow as an MCP tool call.
5. Event-log primitive — schema for a new event kind `llm_gateway_call` and the transaction shape that ties forward + decrement + audit together.
6. Actor-permissions matrix schema — whether a new `tool_id` is the right primitive for "llm gateway access," or whether this needs its own resource type column.
7. Anthropic API contract — which endpoints the son's CC actually hits (`/v1/messages` is the main one). Confirm versioning shape, header forwarding, error response forms.

**Deliverable:** `proposed/family-son-mcp-phase-5-recon.md` with all seven answers + exact file references + the request → forward → response flow diagram. Halt.

## Phase 1 — endpoint shell + bearer auth

Add `/anthropic/v1/messages` route to `src/transports.ts`. No forward yet — just:
- Accept the route.
- Run bearer-auth (must produce 401 for missing/invalid token, same shape as `/mcp`).
- Return a stub 501 Not Implemented with a clear JSON body.

Smoke: paired actor's bearer → 501 with stub body. No bearer → 401. Revoked bearer → 401.

**Deliverable:** route handler + tests. `git commit -s`, push, halt.

## Phase 2 — chokepoint integration

Wire the route handler into `runChokepointDecision()` for actor authorization. New `tool_id` (per Phase 0 recommendation) gates the call: NO_GO without a matrix row, AUTO/CONFIRM with one. Reuse Option A semantics — operator-only matrix authoring.

Smoke: actor with no matrix row → NO_GO (same shape as PR #83 4a). Actor with `peer:son-1 → llm.anthropic @ AUTO` → past the chokepoint, still 501 because forward isn't wired.

**Deliverable:** chokepoint integration + tests + matrix entry docs update. Halt.

## Phase 3 — credential forwarding (HIGH-sensitivity operator-approval gate)

Wire the actual forward. Operator's API key loaded from vault into the handler's closure. Implement non-streaming first — `/v1/messages` with `stream: false`. Handler:

1. Receives the chokepoint-passed request from Phase 2.
2. Loads operator's Anthropic credential from the vault.
3. POSTs to `https://api.anthropic.com/v1/messages` with the operator's key in `x-api-key`.
4. Returns response body and headers to the son's CC (credential redacted from any error context).
5. Anthropic errors returned transparently (son sees what Anthropic said) — but any internal field that could leak credential or operator identity is stripped.

Smoke: son's CC pointing `ANTHROPIC_BASE_URL` at the gateway, makes a `messages.create` call, gets a real Claude response. Son's machine never sees the operator's `~/.anthropic.json` or equivalent.

**Deliverable:** working forward, full E2E smoke with the existing son-1 device. Halt.

## Phase 4 — per-actor metering + budget

Add a `peer_llm_budget` table (schema: `actor_id`, `budget_tokens`, `consumed_tokens`, `period_start`, `period_end`). Each forwarded call:

1. Reads `usage.input_tokens + usage.output_tokens` from Anthropic's response.
2. Increments `consumed_tokens` for the actor in the same DB transaction as the audit event.
3. If `consumed_tokens > budget_tokens`, the next call returns `429 budget_exceeded` with reset time.

Operator dashboard endpoint to view/set per-actor budgets (loopback-only, same fence as `/dashboard/permissions/actor`).

Smoke: set son's budget to 100 tokens, son makes a request costing 90 → ok. Next request costs 30 → 429. Operator resets → next call succeeds.

**Deliverable:** budget table migration + dashboard endpoint + tests + operator-playbook update. Halt.

## Phase 5 — armed CI gate

Add a `family-son-mcp-llm-gateway` GitHub Actions workflow that runs against a containerized stavR (reusing `stavr:ci`):
- Stand up daemon with auth on.
- Pair a fake actor.
- Author an `llm.anthropic @ AUTO` row.
- Stub the Anthropic upstream with a mock returning deterministic responses + usage counts.
- Run the four smokes from Phases 1–4.

Wire as a required check on PRs that touch `src/steward/providers/anthropic.ts` or `src/transports.ts` near the new route.

**Deliverable:** workflow + matching test harness + branch-protection note. Halt for review before merge.

## Done criteria

- All five phases pass per-phase smokes.
- Son's CC, pointed at the gateway with a matrix-granted bearer, successfully calls Claude through the operator's account.
- No credential bytes in any log, event payload, or response.
- Budget enforcement empirically demonstrated (over-budget → 429, reset → ok).
- CI gate runs green on a fresh PR.

## Out of scope (tracked follow-ups)

- Streaming SSE responses (Phase 5b — most CC flows are non-streaming or adapt).
- OpenAI-compatible endpoint (separate cycle).
- Multi-operator federation (multiple daemons sharing a budget pool — far future).
- Browser/UI usage of the gateway.
- Per-call dollar-cost estimate display (gateway gives token counts; separate "cost dashboard" cycle can map them).
