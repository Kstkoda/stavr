# family-son-mcp Phase 5 — OAuth recon

**Round date:** 2026-05-27. **Sensitivity:** HIGH. **Outcome: scenario (iii) — the Phase 5 gateway as built is NOT proxyable as-is.** Three Anthropic-side facts converge to invalidate the BOM's central premise (a stavR daemon forwarding the operator's Anthropic credential to give the son inference against the operator's Max budget). Recon doc only — no source-file changes.

The recon was triggered after Phase 3a/3b landed by an operator question: *"does CC actually use an x-api-key the way our gateway assumes, or is it OAuth, and if OAuth — is that bearer reusable by a different client?"*

The answers below are sourced from (a) CC's own help text and runtime debug output captured against the operator's installed CC v2.1.152, (b) `~/.claude.json` and `~/.claude/.credentials.json` shape inspection (keys only, no values exfiltrated), and (c) two Anthropic GitHub issues (`anthropics/claude-code#28091` and `#37205`) that document Anthropic's explicit policy.

---

## Q1 — What endpoint does CC POST to, and what auth header does it carry?

**Endpoint:** `POST https://api.anthropic.com/v1/messages` (same path the stavR gateway already targets).

**Provider classification:** `firstParty` (i.e., direct Anthropic API, not Bedrock/Vertex/Foundry).

**Auth method:** OAuth — specifically, the `claude.ai` OAuth flow.

### Sources

1. `claude auth status` returns:
   ```json
   {
     "loggedIn": true,
     "authMethod": "claude.ai",
     "apiProvider": "firstParty",
     "subscriptionType": "max"
   }
   ```
2. CC's `--bare` flag help text says verbatim:
   > Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (**OAuth and keychain are never read**). 3P providers (Bedrock/Vertex/Foundry) use their own credentials.
3. `claude -p --debug --debug-file <path> "ping"` produces (captured + scrubbed; the actual log file has been deleted):
   ```
   [DEBUG] [API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: false, has Authorization header: false
   [DEBUG] [API:auth] OAuth token check starting
   [DEBUG] [API:auth] OAuth token check complete
   [DEBUG] [API:timing] dispatching to firstParty model=claude-opus-4-7[1m]
   [DEBUG] [API REQUEST] /v1/messages x-client-request-id=<uuid> source=sdk
   ```
   The literal `[API:auth] OAuth token check` line confirms the auth path is OAuth, not `x-api-key`.

### The wire-format

From CC's debug + the linked GitHub issues, the actual outbound request shape is:

```
POST /v1/messages HTTP/1.1
Host: api.anthropic.com
Authorization: Bearer sk-ant-oat01-<...>
anthropic-version: <version>
content-type: application/json
x-anthropic-billing-header: cc_version=2.1.152.8a5; cc_entrypoint=sdk-cli; cch=00000;
x-client-request-id: <uuid>
user-agent: <Anthropic SDK signature>
```

Two CC-specific headers:
- **`x-anthropic-billing-header`** — bills the call against the operator's Claude subscription (Max in this case) rather than pay-per-use API credits.
- **`x-client-request-id`** — request correlation; not a credential.

The fallback path: with `ANTHROPIC_API_KEY` set (or `--bare`), CC switches to `x-api-key: sk-ant-api03-<...>` (the classic Anthropic API key, separate billing against pay-per-use credits). That is the shape our existing gateway forwards.

### Token storage

CC stores the OAuth tokens in the OS keychain (`tengu_windows_credman` GrowthBook flag is `true` for the operator), NOT in `~/.claude.json`. `~/.claude.json`'s `oauthAccount` object holds metadata only (`accountUuid`, `organizationUuid`, `subscriptionType`, etc.) — verified by enumerating keys + types without exfiltrating values. `~/.claude/.credentials.json` contains only MCP-plugin OAuth (Notion, Linear, Monday, etc.) — empty `accessToken` strings, separate from the Claude API auth.

---

## Q2 — If the gateway presents the same OAuth bearer, does Anthropic accept it from a different client?

**No. Scenario (iii). As of ~Feb 2026 Anthropic explicitly rejects OAuth tokens from any client other than Claude Code itself.** This invalidates the gateway-as-credential-proxy design.

### Sources

1. **Anthropic's verbatim API responses** (per `anthropics/claude-code#28091` and `#37205`):
   - With OAuth token in `Authorization: Bearer`: `"OAuth authentication is currently not supported."`
   - With OAuth token in `x-api-key`: `"invalid x-api-key"` (the OAuth `sk-ant-oat01-*` format is not accepted as an API key either)
2. **Feature request #37205** ("Allow OAuth tokens for Anthropic Messages API — enable subscription-based programmatic access") was **closed as "not planned"** and labeled "invalid". No Anthropic engineering response committed to a future path.
3. **NousResearch/hermes-agent#15080** independently confirms: a Hermes agent presenting a valid Claude Code OAuth token to `https://api.anthropic.com/v1/messages` is rejected with HTTP 400.
4. **Mechanism (inferred from the failure shape):** the bearer is bound to the CC client identity at the OAuth authorization-server layer. The `/v1/messages` resource server validates not just the token's signature/expiry but its bound `client_id`. Spoofing the `x-anthropic-billing-header` does NOT help — that header is observed/logged but does not change the auth-decision plane.

### Empirical test status

I deliberately did NOT extract the operator's live OAuth token to attempt a curl smoke. Two reasons:
- The operator's instruction in this round (*"do NOT touch the vault or do anything with the synthetic key"*) is interpreted broadly as a do-not-handle-real-credentials posture during recon.
- The documentary evidence is conclusive — Anthropic has publicly stated the policy AND the failure shape is reproduced by independent third parties. An empirical 401/400 from a curl would only confirm what the docs already say.

If the operator wants empirical verification later, it's a 30-second test: `curl -H "Authorization: Bearer <oauth-token>" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/messages -d '<body>'`. Expected response: HTTP 401 with body `{"type":"error","error":{"type":"authentication_error","message":"OAuth authentication is currently not supported."}}`.

---

## Q3 — OAuth refresh contract

Documented for completeness; not load-bearing for feasibility (Q2 already terminated the proxy design).

| Field | Value | Source |
|---|---|---|
| **Access-token lifetime** | ~1 hour | Issue #19078 and the daveswift.com OAuth-update writeup; observed via "access token expired during long autonomous task" reports |
| **Refresh-token lifetime** | Not officially documented; community reports "months to indefinite, until revoked or password change" | Inference from absence of forced re-auth complaints |
| **Refresh endpoint** | `console.anthropic.com` OAuth server, exact path not in public docs (the SEA-bundled JS is compressed; my `strings` extraction returned nothing meaningful for the operator's installed binary) | CC docs |
| **Refresh mechanism** | Server-to-server refresh-token grant; **does NOT require browser presence** for the refresh itself | "CC automatically refreshes expired access tokens" per code.claude.com/docs/en/authentication |
| **Initial auth** | Requires a browser redirect to `console.anthropic.com` consent page, then localhost callback with auth code, then code→token server-to-server exchange | Standard OAuth 2.0 authorization-code flow |
| **Known instability** | Issues #12879, #12447, #19078: refresh fails mid-long-task with no recovery path; operator must `/login` again | GitHub issue tracker, multiple reports |

### Token formats (for completeness)

- **OAuth access token**: `sk-ant-oat01-<...>` — what CC actually uses, **rejected at /v1/messages from non-CC clients** (Q2).
- **OAuth long-lived token** (from `claude setup-token`): also `sk-ant-oat01-<...>` — same rejection.
- **Console API key** (paid pay-per-use): `sk-ant-api03-<...>` — accepted at `/v1/messages` via `x-api-key`. This is what the existing Phase 3a seeding endpoint accepts.

---

## Scenario read: **(iii) — NOT proxyable as designed**

The Phase 5 BOM's central premise was: *"the son's Claude Code sets `ANTHROPIC_BASE_URL=http://<operator-ip>:7777/anthropic` and uses the operator's Claude Max budget instead of carrying his own subscription. Credentials never leave the operator's daemon process."*

That premise is structurally impossible with Anthropic's current OAuth policy. The operator's Max subscription is **only** usable via Claude Code itself; forwarding the bearer from a different client (the stavR gateway → api.anthropic.com) is rejected with `"OAuth authentication is currently not supported."`. **No documented workaround exists.**

The substrate built in Phases 0–3b still works *mechanically* — it just doesn't deliver the family-resource-sharing outcome the BOM promised. If the operator seeds an `sk-ant-api03-*` API key into the vault (paid pay-per-use, separate billing from Max), the gateway forwards successfully and the son gets inference — but it costs the operator separately from Max. That's not the deal the BOM made.

---

## Existing Phase 5 commits — usefulness audit under scenario (iii)

Branch `feat/family-son-mcp-phase-5`. From oldest to newest:

### Still load-bearing

| Commit | Title | Survives (iii)? | Notes |
|---|---|---|---|
| `5c24f61` | docs(recon): Phase 0 — LLM gateway recon | ✅ Substrate facts (vault, bearer-auth, chokepoint, event log) | Document supersedes its own feasibility conclusion — this OAuth recon is the correction |
| `d735e8c` | docs(decisions): Phase 0 — operator decisions on F1-F6 | ✅ F1, F3, F4, F6 still hold; F2 + F5 partially obsoleted (see below) | F2 (anthropic-version pass-through) is dead with OAuth dead; F5 (key seeding) needs a different credential shape |
| `022a02b` | feat(P1): `/anthropic/v1/messages` 501 stub | ✅ Route shell + bearer-auth coverage are reusable | The 501 → 200 promotion is what's invalidated, not the shell |
| `a37eba5` | feat(P2): chokepoint integration | ✅ Reusable as-is | The chokepoint gates ANY downstream verb; `llm.anthropic` as a tool_id is correct regardless of how the verb is implemented downstream |
| `3d7d2ac` | fix: review pass — 14/15 findings | ✅ Most fixes are gateway-path hardening that survives the redirect: peer-actor reason redaction (C1/C2/S7), Layer 0 killswitch on all methods (S2), shape-validate body (C7), audit emit completeness (C8/C11), JSON parse error shape (C12), body-limit (C21), capability/audit atomicity (C3), correlation_id propagation (C14), categories.ts irreversible (S1). All still apply | The `req.body.model` etc validation, the audit-event vocabulary, and the killswitch carving live above the forward layer |

### Needs rework

| Commit | Title | Status under (iii) |
|---|---|---|
| `19ea4d7` | feat(P3a): Tier-3-gated Anthropic-key seeding | ⚠️ **The endpoint, vault contract, and atomic rotation are reusable, but the credential SHAPE assumed (a single string `sk-ant-api03-*`) is only one of two possible credential types we might want to store. If we pivot to "spawn `claude -p` per call," the credential is the operator's OAuth refresh-token bundle (4+ fields), not a single key.** |
| `14a89bf` | feat(P3b): forward handler with mocked tests | ❌ The whole forward design assumes a credential type Anthropic accepts on `/v1/messages` from a non-CC client. Under (iii), this is only true when the credential is `sk-ant-api03-*` (paid API credits). With an OAuth credential, the forward will always fail with 401 OAuth-not-supported. |

### Tests that fail their stated purpose under (iii)

`tests/transports/gateway-forward.test.ts` — the mocked-upstream tests still pass because the mock doesn't enforce Anthropic's OAuth-rejection policy. The tests verify the gateway plumbing works against ANY upstream that accepts the forward; they do NOT verify the upstream actually accepts the credential. The "F6 fault-injection" test set is real coverage for the credential-redaction discipline, but the "happy path 200" test gives a false sense of end-to-end viability.

---

## Where this leaves Phase 5 — three plausible redirects

Operator pick. Recon-only doc; no implementation work attached. All three carry forward most of the Phase 5 substrate.

### Redirect A — **API-key-only gateway** (smallest pivot, defeats the budget premise)

Drop the OAuth/Max-subscription premise. The gateway forwards `x-api-key: sk-ant-api03-*` only. The operator buys console.anthropic.com API credits separately and seeds those via the existing Phase 3a endpoint. The son pays nothing for inference (he uses the operator's API credits), and the operator pays pay-per-use on top of their Max subscription.

- **Cost to operator:** double-billing — Max ($100/mo or $200/mo) PLUS API credits (~$15/M input + $75/M output for Opus).
- **Code change:** **none required.** Phases 0–3b work exactly as built. The BOM's framing changes from "use Max budget" to "the gateway uses a separate billing surface that the operator funds."
- **Honesty:** the BOM's "use the operator's Claude Max budget" promise is broken. Should be rewritten.

### Redirect B — **`claude -p` subprocess proxy** (preserves the budget premise, adds latency)

The gateway receives a request, spawns `claude -p` as a subprocess (which uses the operator's OAuth via keychain), pipes the son's prompt through stdin/stdout, returns the result. This is what feature request #37205 was working around with PAN — same shape.

- **Cost to operator:** zero extra (uses Max subscription as designed).
- **Latency:** +3–5 seconds per call (CC startup + OAuth check + sandbox bootstrap). Streaming is harder.
- **Code change:** **substantial.** The forward handler in P3b is replaced with a subprocess orchestrator. The credential vault is no longer used (CC handles its own OAuth). The Tier-3 seeding endpoint becomes a different thing entirely (or is removed).
- **Risk:** subprocess management, deadlocks, sandbox interactions, CC version drift across son and operator environments.

### Redirect C — **Bedrock/Vertex proxy** (different billing surface, retains forward design)

The operator configures the gateway to forward against AWS Bedrock or GCP Vertex (both host Anthropic models). The gateway becomes a Bedrock-shape proxy. The son's CC needs to be configured for the Bedrock provider (3P provider per CC's `--bare` help text), OR the gateway translates between Anthropic-API-shape and Bedrock-shape.

- **Cost to operator:** AWS/GCP credits, separate from both Max and console API.
- **Code change:** vault stores AWS/GCP credentials instead of Anthropic API key; the forward handler needs Bedrock/Vertex-shape headers + auth (SigV4 for Bedrock). The chokepoint/audit/route shell survive unchanged.
- **Strategic fit:** doesn't deliver "use the family Max budget"; just moves the billing surface elsewhere.

### Redirect D — **Cancel the gateway, keep the substrate** (honest outcome)

The Phase 5 substrate (gateway-gate.ts, route shell, audit events, chokepoint integration) is reusable for any future LLM-gateway design (e.g., Ollama, vLLM, custom self-hosted models). The family-Max-budget premise is admitted dead-on-arrival per Anthropic's policy. The gateway in this branch ships as "general-purpose LLM proxy with seeded credentials" rather than "family Max-budget broker."

- **Cost:** zero immediate financial; absorbs the Phase 5 engineering cost as a sunk substrate that paid for future endpoints (Ollama gateway, vLLM gateway, etc).
- **Code change:** rewrite the README/BOM framing; add Ollama/vLLM as the named test path in Phase 5 CI gate. Phase 4 metering becomes per-self-hosted-model usage rather than Anthropic-API tokens.

---

## Recommendation

The operator should pick between Redirect B (preserves the spirit of the BOM at a real engineering cost) and Redirect D (admits the policy reality and pivots the substrate to a different problem). Redirect A is acceptable but breaks the BOM's family-resource promise and creates "the operator pays twice" friction. Redirect C is a tangent.

If I had to recommend one: **Redirect D**. The Phase 5 substrate is genuinely valuable as a personal LLM-gateway primitive (the chokepoint, audit, vault, Tier-3 gate all make sense for ANY upstream LLM endpoint). The "family Max budget" outcome was always going to be policy-dependent; Anthropic has clearly indicated they don't want this use case (Issue #37205 closed-not-planned). Redirect D banks the engineering investment and pivots the use case to one the operator controls end-to-end: their own self-hosted Ollama, a personal vLLM, a Bedrock account they own, or `sk-ant-api03-*` API credits if they accept the double-billing.

Redirect B is the right pick if the operator is committed to the Max-budget premise and is willing to accept the latency cost. The implementation is real work but well-scoped.

## Halt

Recon doc complete. No source-file changes. No vault touch. No real credential bytes handled. The synthetic key the operator pasted earlier was never seeded (F6 smoke crashed on mDNS collision before `credStore.add`) and the script file containing the synthetic key inline has been scrubbed (`tmp/phase5-f6-smoke.ts` deleted, confirmed).

**Operator decisions needed:**
1. Which redirect? (A / B / C / D / other)
2. Does the existing branch `feat/family-son-mcp-phase-5` stay open for the redirect, or do we close it (mark the substrate as foundation for a follow-on branch) and start fresh?
3. Does the existing BOM (`proposed/family-son-mcp-phase-5-llm-gateway-bom.md` on `feat/proposed-bom-phase5-and-fs-atomic-write`) get rewritten or superseded by a new BOM?

Awaiting your call.
