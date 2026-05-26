# family-son-mcp Phase 5 — recon

Read-only Phase 0 deliverable for `proposed/family-son-mcp-phase-5-llm-gateway-bom.md` (commit `793ea76` on `feat/proposed-bom-phase5-and-fs-atomic-write`). Reviews the seven recon questions, names exact files/lines, and ends with a request → forward → response flow and a flags section listing every place the BOM's plan needs an operator-visible decision before Phase 1 begins.

The BOM's eight hard invariants are taken as binding. Where existing code disagrees with what the BOM assumes, the disagreement is called out under **Flags**, not silently adapted.

---

## Q1 — Anthropic provider abstraction

**File:** `src/steward/providers/anthropic.ts:40-99`

The existing provider is a `StewardProvider` factory — `makeAnthropicProvider({ apiKey, model?, fetchImpl?, apiUrl? })` returns an object with one async generator method `complete(call: StewardCompleteOpts)` that yields `StewardEvent` chunks (`text`, `tool_call`, `usage`, `done`).

Key shape (lines 49–97):

- Request body assembled from `StewardCompleteOpts`: `{ model, max_tokens, system, messages.filter(m=>m.role!=='system'), tools.map(...) }` (lines 49–59).
- Single non-streaming POST to `opts.apiUrl ?? 'https://api.anthropic.com/v1/messages'` with three headers: `x-api-key: opts.apiKey`, `anthropic-version: '2023-06-01'`, `content-type: application/json` (lines 60–68).
- Error path: `throw new Error(\`anthropic api ${res.status}: ${txt.slice(0, 500)}\`)` — the upstream body is interpolated into the message (lines 69–71).
- Cost estimator `estimateCostUsd()` co-located (lines 107–125): opus $15/$75 per 1M tokens; sonnet $3/$15; haiku $0.80/$4.

**Reuse assessment.** The provider bakes the StewardEvent shape into its return; a gateway forward needs raw Anthropic JSON in and raw Anthropic JSON out. We therefore **cannot** call `complete()` from the gateway handler and reuse it directly. The cleanest path is a sibling helper in the same file — call it `forwardAnthropicMessages({ apiKey, body, headers, fetchImpl?, apiUrl? })` — that does the POST, returns the raw response (status + headers + body) without parsing, and is reusable both by tests and by the gateway. This preserves BOM invariant #8 ("reuse `src/steward/providers/anthropic.ts` for the actual fetch") in spirit: same file, same vetted header set, same error-throwing convention, no edits to `complete()`.

**Landmines.**

- **Hardcoded `anthropic-version: 2023-06-01` (line 64).** The son's Claude Code will send its own `anthropic-version` header. If we forward both, Anthropic accepts the latest one wins (per their API behaviour at recon time) — but mixing is fragile. **Decision the BOM needs:** pass son's header through if present, else inject ours. Recorded as **Flag F2**.
- The provider's error path includes the first 500 bytes of upstream response text in `new Error(...)` (line 71). If that error ever bubbles into a log line via the chokepoint or daemon's error logger, an Anthropic 401 body that quotes back the key prefix could leak (Anthropic doesn't quote keys today, but the surface exists). The gateway must catch & rewrap before any error escapes; the audit-log grep in invariant #1 is the load-bearing check.

---

## Q2 — Credential vault contract

**Files:**

- `src/credentials/vault.ts:1-170` — encryption + master-key loading (AES-256-GCM, `iv ‖ ciphertext ‖ authTag` blob; master key from OS keychain via wincred/Keychain/secret-service, falling back to `~/.stavr/master.key`).
- `src/credentials/store.ts` — the `CredentialStore` row model: `{ id, service, plaintext (post-decrypt), metadata, grants }`. Persisted as ciphertext in the `credentials` table (`persistence.ts:357`).
- `src/credentials/tools.ts:82-200` — `registerCredentialTools()`, including the MCP `credential_use` tool, which is the existing template for "use a secret without exposing it."

**Contract.** There is no callback/scoped-secret pattern. The vault returns plaintext to its caller from `store.resolveForUse({ credential_id, steward_session_id })` (line 106 in `tools.ts`). The "never leaves the daemon" promise is **discipline, not isolation** — every caller must (a) keep the plaintext in a closure variable, (b) never log it, (c) never put it in a response body, and (d) never put it in an error message. The `credential_use` tool today injects the plaintext into an outbound HTTP header or env var (lines 122/147) and returns only the upstream's status + sanitized body to the MCP caller.

**Anthropic-key provisioning.** No existing path. Today the vault is generic: `service` is a free-form string. For Phase 3 the operator's Anthropic key will live as a row with `service='anthropic'`. The BOM doesn't specify how the operator seeds it (dashboard form? CLI command? one-shot env var read at daemon boot?) — recorded as **Flag F5**.

**Landmines.**

- The vault is correct, but the gateway-side discipline is what the BOM's invariant #1 grep-test actually verifies. The forward handler must hold the plaintext in a single closure variable, never assign it to `req.locals`, never pass it through any logger, and never include it in any error formatter.
- The vault has no per-credential "in-use" counter, so we cannot tell from the vault alone whether the key is leaked. The audit/error-log grep after every smoke run is the only check.

---

## Q3 — Bearer-auth middleware mount

**File:** `src/transports.ts` — middleware mount at lines 487–513; the pure decision in `checkBearerAuth(...)` at lines 1386–1407.

The middleware mounts at `app.use(...)` (line 494) so it covers every route on the daemon's HTTP app. The decision function reads:

```ts
// transports.ts:1392-1406
if (args.path === '/healthz' || args.path === '/pair/complete' || args.path === '/pair/initiate') {
  return { ok: true };                              // public allow-list
}
if (args.isLoopbackReq) return { ok: true };        // loopback always passes
const presented = parseBearerToken(args.authHeader);
if (!presented) return { ok: false, status: 401, error: 'missing_or_invalid_authorization' };
const presentedHash = hashToken(presented);
const device = args.findActiveDevice(presentedHash);
if (!device) return { ok: false, status: 401, error: 'invalid_token' };
return { ok: true, device };
```

After bearer-auth, a second middleware stamps `logContext.actor_id` (lines 526–536):

```ts
const actorId = reqDevice
  ? `peer:${reqDevice.name}`
  : isLoopbackRequest(req)
    ? `loopback:${corrId}`
    : 'unknown';
logContext.run({ ...existing, actor_id: actorId }, () => next());
```

A third loopback-only fence (lines 538+) restricts `/dashboard/*` and `/events/sse` to loopback. **`/anthropic/*` MUST NOT be on that fence** — sons are by definition non-loopback.

**Insertion point.** No middleware change needed. Mount `/anthropic/v1/messages` (and a sibling 405-only catch-all under `/anthropic/*` if we want a tidy 404 shape) after the actor-stamping middleware and before any loopback-only fence. The route handler will read `(req as any).device` for the actor's device identity and `logContext.getStore()?.actor_id` for the `peer:<name>` form already used elsewhere.

**Landmines.**

- **Loopback bypasses bearer (line 1397).** BOM invariant #2 says "Every request bearer-authed at the transport layer." Today, loopback requests to `/anthropic/v1/messages` would skip bearer entirely. For the gateway use case (sons are non-loopback) this is fine, but it tightens to "Every *peer* request bearer-authed." Recorded as **Flag F1** — needs operator confirmation that loopback's existing behaviour is intended for this route. If not, we need a path-specific override in `checkBearerAuth` that strips the loopback bypass for `/anthropic/*`.
- Token authentication is hash-equality against `devices` (line 1404). Revocation works because `findActiveDeviceByTokenHash` filters by `status='active'` — same path Phase 4e in PR #85 already smoke-tested. No new revocation primitive needed for Phase 5.

---

## Q4 — Chokepoint integration for non-MCP routes

**Files:**

- `src/security/decision-gate.ts:88-190` — `runChokepointDecision(broker, { toolId, actor, tier, args, timeoutSec? })`. Pure async function; opens a decision, awaits operator response, returns `{ allowed, reason?, correlation_id }`.
- `src/security/decision-gate.ts:210-326` — `buildChokepointGate(broker, { capability, actorPermissions, identity })` returns a `RuntimeToolGate` whose `check(toolId, args)` layers no-go → capability override → per-actor tier (with EXPLICIT requiring a recent WebAuthn assertion).
- `src/server.ts:394-403` — `wrapServerForRegistry(server, toolRegistry, 'server.ts', buildChokepointGate(broker, {...}))` — the wrapper runs `check()` before every MCP tool handler. **The wrapper is MCP-only**; REST routes do not go through it.

**Adapter shape.** For `/anthropic/v1/messages`, the route handler should:

1. Read `actor = logContext.getStore()?.actor_id ?? 'unknown'` (stamped by the Phase 4.5 middleware at `transports.ts:526-536`).
2. Construct `args` for chokepoint logging — a metadata-only summary, **not the raw body**: `{ model: body.model, message_count: body.messages?.length, max_tokens: body.max_tokens }`. Per BOM invariant #5 the request body must not enter the audit log; this metadata-only shape is the equivalent of how MCP tool args are shaped today (already audit-safe).
3. Call `buildChokepointGate(...).check('llm.anthropic', metadataArgs)`. The gate uses the SAME stores already wired in `server.ts:390-393` (capability, actorPermissions, identity), so we want to expose those stores via a getter so the gateway route handler can construct the gate without duplicating the wiring. The cleanest move is a small helper in `src/server.ts` or a new `src/security/gateway-gate.ts` that returns the assembled gate object — the gate object itself is reusable as-is.
4. On `allowed=true` proceed to forward; on `allowed=false` respond `403` with the `reason` field (no leakage of operator state, just `"per-actor NO_GO: actor \"peer:son-1\" cannot invoke llm.anthropic"` etc.).

**`tool_id` choice.** `'llm.anthropic'`. Falls through `categorize()` → `'other'` → `defaultTierFor() = 'CONFIRM'` (`tools/categories.ts:165`). That default is correct (conservative bias; per BOM Phase 2 the operator authors an explicit matrix row before any forward happens). Phase 2 should also add `'llm.anthropic'` to `EXPLICIT_CATEGORY` in `categories.ts` so the dashboard's permissions matrix UI renders it in a sensible bucket (proposed new category `'llm'`), but this is a polish, not a requirement.

**Landmines.**

- **No REST adapter exists today.** This is the only piece of substrate Phase 5 has to invent. It's small (~30–50 lines), but BOM invariant #8 says "no source changes outside the gateway path." Mounting a getter for the chokepoint gate's three stores in `server.ts` counts as a tiny seam in non-gateway code; recorded as **Flag F3**. Alternative: re-instantiate the three stores from the broker via the existing `getOrCreate...` getters from inside the gateway route handler — these are idempotent (the "or create" branch only fires on first call), so duplicating the assembly is structurally safe.
- **EXPLICIT-tier requires a recent operator WebAuthn assertion** (`decision-gate.ts:265-296`). If the operator sets `llm.anthropic @ EXPLICIT` for an actor, every forward will demand a fresh passkey assertion, which would block sons across machines. Phase 2's matrix-row demo should use AUTO or CONFIRM; EXPLICIT is structurally available but operationally unusable for a remote son. Note in BOM Phase 2 docs.

---

## Q5 — Event log primitive + transaction shape

**Files:**

- `src/persistence.ts:167-182` — `events` table: `(id, kind, correlation_id, source_agent, tenant_id, payload_json, at, persisted_at, seq)` + indexes on `kind`, `correlation_id`, `seq`.
- `src/event-types.ts` — Zod enum of event kinds. We need to add `llm_gateway_call` (and probably `llm_gateway_denied` for the chokepoint NO_GO path, mirroring how `no_go_match` and `tier3_assertion_required` are separate kinds).
- `src/broker.ts` — `broker.publish(event)` is the emit API; persistence + fan-out to subscribers is internal.

**No native multi-step DB transaction wrapper.** The existing pattern in `decision-gate.ts:124-148` is two ordered side-effects without a wrapping SQLite transaction:

```ts
broker.store.createDecision(correlationId, question, options, timeoutSec, REJECT, actor, tier);
await broker.publish({ kind: 'decision_request', ... });
```

If the publish fails after the createDecision, the decision is orphaned (retention sweep handles it). This is **not** sufficient for Phase 4's metering — the BOM invariant #4 requires "budget decrement atomic with response," meaning a successful forward must update `tokens_consumed` and write the audit event in one SQLite transaction with no window where one succeeded and the other didn't.

**Recommended shape for Phase 4.** Add a method `broker.store.recordLlmGatewayCall(...)` that wraps:

```sql
BEGIN;
  INSERT INTO events (id, kind, ..., payload_json, ...) VALUES (...);
  INSERT INTO peer_llm_budget(actor_id, budget_tokens, consumed_tokens, ...)
    ON CONFLICT(actor_id, period_start)
    DO UPDATE SET consumed_tokens = consumed_tokens + excluded.consumed_tokens;
COMMIT;
```

Then `broker.publish()` the same event for subscriber fan-out (idempotent if the event row is already persisted by the transaction — the publish step can no-op on duplicate-id, or we re-shape publish to skip persistence for "already-persisted" events). This needs a small persistence API addition, and is the only persistence change in scope for Phase 4. Recorded as the canonical shape for Phase 4 in **Flag F4**.

**Event payload for `llm_gateway_call`** (proposed; subject to Phase 1 commit):

```ts
{
  kind: 'llm_gateway_call',
  at: ISOString,
  correlation_id: string,
  source_agent: actor_id,         // 'peer:son-1'
  payload: {
    model: string,
    tokens_in: number,
    tokens_out: number,
    cache_read_tokens?: number,
    cache_creation_tokens?: number,
    cost_estimate_usd: number,
    budget_consumed_after: number,
    budget_remaining_after: number,
    upstream_status: number,       // 200, 429, 5xx
    // NO request body, NO response content — BOM invariant #5
  }
}
```

---

## Q6 — Actor-permissions matrix schema

**File:** `src/persistence.ts:597-606`.

```sql
CREATE TABLE IF NOT EXISTS actor_permissions (
  actor_id  TEXT NOT NULL,
  tool_id   TEXT NOT NULL,
  tier      TEXT NOT NULL CHECK (tier IN ('AUTO','CONFIRM','EXPLICIT','NO_GO')),
  set_by    TEXT NOT NULL,
  set_at    INTEGER NOT NULL,
  PRIMARY KEY (actor_id, tool_id)
);
```

`tool_id` is a free-form string. The matrix has no concept of `resource_type` and doesn't need one — `'llm.anthropic'` slots into `tool_id` cleanly. **No schema change required.** The fence stays homogeneous: every protected verb (tool call, LLM call, future resource grant) goes through the same `(actor_id, tool_id, tier)` tuple, which is consistent with the chokepoint-fence mechanic recorded in memory (`stavr-chokepoint-fence-mechanic`).

Defaults flow through `defaultTierFor()` in `src/tools/categories.ts:137-167`. Without an explicit entry, `'llm.anthropic'` falls through to `categorize()` → `'other'` → default `'CONFIRM'` (line 165). That's safe — the BOM's Phase 2 requires an explicit operator-authored matrix row before any forward attempt, so the default tier never gets exercised in the gateway happy path. Adding `'llm.anthropic'` to `EXPLICIT_CATEGORY` (categories.ts:56) and a new `'llm'` `ToolCategory` is a small polish for dashboard surfacing; not blocking.

`set_by` column is always `'operator'` for matrix authoring (per `src/security/actor-permissions.ts:189`). Option A locked in the memory `stavr-family-son-mcp-model` means matrix authoring is operator-only, and that path is already enforced — no change needed.

---

## Q7 — Anthropic API contract

The provider at `src/steward/providers/anthropic.ts` (Q1) is the source of truth for the shape we already emit; the son's Claude Code emits a similar shape (the official Anthropic SDK targets the same endpoint).

**Endpoint:** `POST https://api.anthropic.com/v1/messages`

**Request headers** (we send today):

- `x-api-key: <operator-key>` — bearer-style API key
- `anthropic-version: 2023-06-01` — hardcoded
- `content-type: application/json`

**Request body** (subset we send; superset Anthropic accepts):

```ts
{
  model: string,               // 'claude-opus-4-7' default in our provider (anthropic.ts:43)
  max_tokens: number,
  system?: string,
  messages: Array<{ role: 'user' | 'assistant', content: string | ContentBlock[] }>,
  tools?: Array<{ name, description, input_schema }>,
  stream?: false,              // Phase 5 non-streaming only; SSE is Phase 5b
  // Anthropic also accepts: temperature, top_p, top_k, stop_sequences, metadata, ...
}
```

The son's Claude Code may send fields we don't generate today (e.g., `stream`, `temperature`, `metadata`). The gateway must forward the body **as-is** — the only field we have an opinion on is `stream`: per BOM scope, Phase 5 rejects `stream: true` with a 400 (Phase 5b will land SSE).

**Response body** (success, non-streaming — see `AnthropicMessageResponse` at anthropic.ts:8-24):

```ts
{
  id: string,
  type: 'message',
  role: 'assistant',
  content: Array<
    | { type: 'text', text: string }
    | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
  >,
  model: string,
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens?: number,
    cache_creation_input_tokens?: number,
  },
}
```

`usage.input_tokens + usage.output_tokens` is what feeds the Phase 4 budget decrement (BOM Phase 4 step 1).

**Error response** (Anthropic standard form):

```ts
{
  type: 'error',
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error'
        | 'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error',
    message: string,
  },
}
```

**Status codes we expect to see and forward transparently:** 200 (success), 400 (invalid request, including model not found), 401 (operator's key invalid — should never happen post-Phase-0; if it does, return `502 bad_gateway` to the son, never echo Anthropic's `authentication_error` body that may quote the key), 403 (perm), 429 (Anthropic rate-limited the operator's account — forward as 429, distinct from our internal `429 budget_exceeded`), 5xx (return 502 to the son).

**Son's outbound shape.** Claude Code with `ANTHROPIC_BASE_URL=http://<operator>:7777/anthropic` POSTs `/v1/messages` with the same Anthropic body shape and a `x-api-key` set to whatever the son configured (typically a placeholder, since the son no longer carries a real key). The gateway strips `x-api-key` from the inbound request, injects the operator's key from the vault into the outbound, and forwards the rest of the headers including `anthropic-version` if the son sent one. See **Flag F2** for the version-header decision.

---

## Request → forward → response flow

```
                                           +--------------------------------+
                                           |  Operator's Anthropic key       |
                                           |  (credential vault, decrypted   |
                                           |   into closure on first call)   |
                                           +----------------+----------------+
                                                            |
   son's CC                                                 |
   ANTHROPIC_BASE_URL=http://op:7777/anthropic              |  in-memory only
        |                                                   v
        |  POST /anthropic/v1/messages                  +---+----+
        |  Authorization: Bearer <son-token>            |        |
        |  x-api-key: <ignored>                         |        |
        |  body: { model, messages[], max_tokens, ... } |        |
        v                                               |        |
   +----+----------------------------------+            |        |
   |  bearer-auth middleware               |            |        |
   |  (transports.ts:487-513)              |            |        |
   |  - public-allowlist? no               |            |        |
   |  - loopback? no  -> verify token hash |            |        |
   |  - sets req.device = { id, name }     |            |        |
   +----+----------------------------------+            |        |
        |                                               |        |
        v                                               |        |
   +----+----------------------------------+            |        |
   |  actor-stamping middleware            |            |        |
   |  (transports.ts:526-536)              |            |        |
   |  sets logContext.actor_id =           |            |        |
   |    'peer:son-1'                       |            |        |
   +----+----------------------------------+            |        |
        |                                               |        |
        v                                               |        |
   +----+--------------------------------------------+  |        |
   |  /anthropic/v1/messages handler (new)           |  |        |
   |                                                 |  |        |
   |  1. Validate body shape, reject stream:true     |  |        |
   |  2. Build metadata args for chokepoint:         |  |        |
   |       { model, message_count, max_tokens }      |  |        |
   |  3. gate.check('llm.anthropic', metaArgs)       |  |        |
   |       -> NO_GO    -> 403 + reason, no forward   |  |        |
   |       -> CONFIRM  -> opens decision, awaits     |  |        |
   |       -> AUTO     -> proceed                    |  |        |
   |  4. Budget check (Phase 4):                     |  |        |
   |       if consumed >= budget -> 429              |  |        |
   |       budget_exceeded + reset_at                |  |        |
   |  5. Strip son's x-api-key, inject operator's    |<-+        |
   |  6. forwardAnthropicMessages({ body, ... })     |  ---------+
   |       POST api.anthropic.com/v1/messages        |   (helper, anthropic.ts sibling)
   |  7. On 200: parse usage,                        |
   |       broker.store.recordLlmGatewayCall(...)    |  -- single SQLite txn:
   |       (inserts event + increments budget)       |     events  +  peer_llm_budget
   |  8. Return upstream body verbatim to son        |
   |     (with content-type + relevant headers,      |
   |      MINUS any internal operator-identifying    |
   |      headers; error bodies sanitized to never   |
   |      include key fragments).                    |
   +-------------------------------------------------+
```

---

## Flags — decisions required before Phase 1

| # | Flag | Required decision |
|---|------|---|
| **F1** | Bearer-auth's loopback bypass (`transports.ts:1397`) means any process on the operator's own machine can call `/anthropic/v1/messages` without a token. Sons are by definition non-loopback so this isn't a son-facing gap, but BOM invariant #2 is worded "every request bearer-authed at the transport layer." | Operator decision: (a) accept current behaviour (loopback = operator = Lex Insculpta), or (b) add a path-specific carveout that strips the loopback bypass for `/anthropic/*`. Recommend (a); cheaper, matches existing dashboard/SSE behaviour. |
| **F2** | Provider hardcodes `anthropic-version: 2023-06-01` (`anthropic.ts:64`). Son's CC may send a newer version. | Pass-through if son sends; inject our default if absent. Recommend pass-through — the son's CC knows what shape it expects back. |
| **F3** | No REST → chokepoint adapter exists. The cleanest seam is a small getter in `server.ts` (or a new `src/security/gateway-gate.ts`) that exposes the assembled `RuntimeToolGate`. BOM invariant #8 says "no source changes outside the gateway path." | Confirm a 1–10 line export in `server.ts` (or a new sibling file under `src/security/`) is acceptable as "still on the gateway path." Recommend a new file `src/security/gateway-gate.ts` so the seam is structurally identifiable. |
| **F4** | Phase 4 budget atomicity needs a true SQLite transaction wrapping `INSERT INTO events` + `UPDATE peer_llm_budget`. Today's pattern in `decision-gate.ts:124-148` is non-transactional (publish runs after createDecision; failure orphans). | Approve adding `broker.store.recordLlmGatewayCall(...)` that takes both writes in one `BEGIN/COMMIT`. This is one new persistence method, no schema change beyond the new `peer_llm_budget` table from BOM Phase 4. |
| **F5** | No path exists today to seed the operator's Anthropic API key into the credential vault. The vault is generic; the operator currently has no UI or CLI to insert a `service='anthropic'` row. | Decide the seeding path: (a) dashboard form added in Phase 3, (b) CLI command, or (c) one-shot env var the daemon consumes once at boot and inserts into the vault (then unsets in-process). Recommend (a) — keeps the operator in the dashboard surface that already manages credentials. |
| **F6** | Provider's error path interpolates 500 bytes of upstream body into `new Error(...)` (`anthropic.ts:71`). If that error escapes uncaught to a logger, an Anthropic 401 body could (in theory; not today) leak the operator's key prefix. | Gateway handler must catch all errors from `forwardAnthropicMessages` and rewrap into a sanitized form before any logger sees them. The grep-the-logs check in BOM invariant #1 is the load-bearing verification. |

None of these flags are blocking for the Phase 0 deliverable itself, but **F3 and F5 must be resolved before Phase 2 begins**, and **F4 must be resolved before Phase 4 begins**. F1, F2, F6 can be decided alongside Phase 1.

---

## Out-of-scope confirmations

The BOM's "what this BOM does NOT cover" list is consistent with the code state recon:

- OpenAI-compatible endpoint — no existing scaffolding, separate cycle.
- Ollama-compatible endpoint — already brokered (`src/steward/providers/ollama.ts` sibling, not read in this recon but referenced in transports' `ollamaModels` ctx).
- SSE streaming — provider already uses the non-streaming endpoint (anthropic.ts:36-38 note); matches Phase 5 scope.
- Federated metering — no broker-to-broker primitive exists; not in scope.

---

## Halt

Phase 0 deliverable complete. Per CLAUDE.md §9 (HIGH sensitivity) and the BOM, halting for operator review before Phase 1 begins.

Next phase if approved: Phase 1 — endpoint shell + bearer auth (no forward yet; 501 stub behind bearer-auth, smoke for 401 / revoked / valid-bearer-501).
