# family-son-mcp Docker test — Phase 0 recon

Substrate inventory for `proposed/family-son-mcp-docker-test-bom.md`. Five questions, exact answers below — file paths, line numbers, env var names, endpoint shapes. No design choices baked in beyond what the BOM commits to (auth ON, container-to-container hop, operator authors the matrix).

## Q1 — Env vars that flip auth ON vs OFF

**The bombardment rig's `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH` is a wrapper-script env var, not a daemon env var.** The daemon source has no reference to that name; the bombardment Docker entrypoint translates it into a CLI flag:

- `bombardment/docker/entrypoint.sh:24-25` — `if [ "${STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH:-0}" = "1" ]; then EXTRA_FLAGS="--allow-non-local-without-auth"`
- `bombardment/compose/docker-compose.yml:57,83,115` — sets it on all three rig daemons
- `Dockerfile:25-27` — documents the translation
- `.github/workflows/bombardment-docker.yml:93` — CI sets it

**The actual daemon-side knob** is YAML config `network.require_auth_when_non_local` (default `true`), schema at `src/config.ts:20-24`. CLI flag `--allow-non-local-without-auth` overrides it to `false` (`src/cli.ts:194,62-64,200`).

**Auth-ON state for this test:** OMIT `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH` from the container env (or set `=0`), AND leave `network.require_auth_when_non_local: true` in `stavr.yaml` (which is the default if the key is omitted). The bombardment entrypoint will then NOT add the `--allow-non-local-without-auth` flag, and the daemon will enforce the bind-auth gate.

**Other auth-related env vars** (all read at daemon start):

| Env var | Source | Default | Purpose |
|---|---|---|---|
| `STAVR_WEBAUTHN_RP_ID` | `src/security/webauthn.ts:90` | `'localhost'` | Relying-party id passkeys bind to. For non-loopback bind, must match the hostname browsers/clients see. |
| `STAVR_WEBAUTHN_ORIGINS` | `src/security/webauthn.ts:92,94` | derived (loopback ports) | Comma-separated origin allowlist for WebAuthn ceremonies. |
| `STAVR_WEBAUTHN_RP_NAME` | `src/security/webauthn.ts:91` | `'stavR'` | Display name in passkey prompt. |
| `STAVR_PEER_ID` | `src/federation/index.ts:53` | `'stavr-self'` | mDNS / federation announcement id. |

Runbook §2.3 (`docs/family-son-mcp.md:73-99`) prescribes setting `STAVR_PEER_ID`, `STAVR_WEBAUTHN_RP_ID`, `STAVR_WEBAUTHN_ORIGINS` on the daemon process. For this test, WebAuthn is NOT on the critical path (pairing uses the 6-digit code path, not WebAuthn; the BOM Phase 4 explicitly omits Tier-3 EXPLICIT). RP_ID is set for completeness and to match the container hostname.

## Q2 — Bind config for a container hostname

**Resolver:** `resolveBind()` at `src/config.ts:142-171`. Loopback values (`localhost`, `127.0.0.1`, `::1`, empty) → `{ is_loopback: true, mode: 'localhost' }` (line 145). Explicit host strings → `{ host, is_loopback: LOOPBACK_HOSTS.has(host), mode: 'explicit' }` (lines 165-170). `0.0.0.0` is treated as explicit, **not** loopback (`LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']` line 140).

**Bind-auth gate:** `checkBindAuthGate()` at `src/config.ts:194-207`. Refuses when bind is non-loopback AND `requireAuthWhenNonLocal` AND NOT `authConfigured` (no paired devices yet). The runbook §2.5 / §3.1 calls this out — bootstrap from loopback first, flip bind after.

**The decisive shape detail.** The daemon issues a single `app.listen(opts.port, bindHost, ...)` at `src/transports.ts:1276`. Whatever string is in `bindHost` is the only interface the daemon listens on. **There is no automatic "also bind loopback" behaviour.** This matters for Phase 4: the dashboard decision-respond endpoint requires a loopback caller (see Q4), so the daemon MUST also listen on loopback inside the container for the operator to approve CONFIRM-tier calls without external HTTP gymnastics.

**Recommended container bind: `bind: 0.0.0.0`.** Listens on ALL interfaces in the container — both the container hostname `stavr-operator` (which the son-client resolves over the Docker network) AND `127.0.0.1` (which `docker compose exec stavr-operator curl localhost:7777/...` uses for operator approvals). `docs/federation/configurable-bind.md:35,92` documents `bind: 0.0.0.0` as a supported value for federation deployments. The bind-auth gate treats `0.0.0.0` as non-loopback (correctly — externally addressable), so the bootstrap-from-loopback dance still applies.

**RP_ID pairing:** `STAVR_WEBAUTHN_RP_ID=stavr-operator` to match the container hostname the son-client uses. `STAVR_WEBAUTHN_ORIGINS=http://stavr-operator:7777,http://localhost:7777`.

**Bootstrap flow inside the container:**
1. Start with `bind: localhost` + `require_auth_when_non_local: true` (gate satisfied because is_loopback=true).
2. `stavr pair bootstrap` from inside `stavr-operator` to mint a device. Now `authConfigured=true`.
3. Flip `bind: 0.0.0.0`, restart daemon. Gate now satisfied (authConfigured=true).
4. Son-client reaches `http://stavr-operator:7777/mcp` over the Docker network.

This matches the runbook §3.1 / §3.5 flow with `0.0.0.0` substituted for `helm.stavr.mesh`.

## Q3 — Actor-permissions matrix: storage and authoring

**Storage:** SQLite table `actor_permissions` in the daemon's database file (typically `~/.stavr/stavr.db`, configured via `defaultDbPath()` in `src/cli.ts`). Schema in `src/security/actor-permissions.ts:59-65`: columns `actor_id, tool_id, tier, set_by, set_at`. Upsert via `set()` at line 189 (`INSERT ... ON CONFLICT`). Read via `resolve()` — exact `(actor_id, tool_id)` lookup, no fuzzy matching. **Tool ids must match the registered dotted form verbatim** (`github.list_prs`, not `github_list_prs` — runbook §4.3 highlights this footgun).

**Authoring mechanism — operator dashboard only.** Page at `/dashboard/permissions` (`src/dashboard/pages/permissions.ts`). Mutation endpoints `POST /dashboard/permissions/capability` and `POST /dashboard/permissions/actor` (lines 24-25). The dashboard is mounted under `/dashboard/*` which is loopback-only by the bind-checking middleware — so writes are loopback-bound, not exposed to the son-client. Tier dropdown values come from `TIER_OPTIONS` at line 37 (AUTO / CONFIRM / EXPLICIT).

**MCP tool writes blocked.** Runbook §4.3 and `src/security/actor-permissions.ts:186` confirm matrix writes via MCP tool calls are blocked at the transport layer. Only operator-side (loopback) dashboard requests can mutate the matrix. **Per BOM hard invariant #3, CC does not author rows.** The test driver will instruct the operator to use the dashboard (or a direct loopback POST to the mutation endpoint, operator's choice — but CC does not do this).

**Direct HTTP shape (for the operator's reference, if they prefer curl over the UI):**

```
POST http://localhost:7777/dashboard/permissions/actor
Content-Type: application/json
{ "actor_id": "peer:son-test", "tool_id": "github.list_prs", "tier": "AUTO" }
```

(The exact request body field names should be confirmed from `src/dashboard/pages/permissions.ts` at the time the operator authors a row — flagged as a thing to verify with the operator, not assumed.)

## Q4 — CONFIRM-tier decision queue

**Operator UI:** `/dashboard/decide` (`src/dashboard/pages/decide.ts:1`) — renders open decisions as cards with Approve / Reject buttons.

**HTTP approval endpoint:** `POST /dashboard/decisions/:correlationId/respond` at `src/transports.ts:2706-2787`. Request body: `{ chosen_option_id: "approve" | "reject", reason?: string, responder?: string }` (lines 2708-2712). The endpoint is loopback-bound at the network layer (mounted under `/dashboard/*`) AND enforces a verified-caller identity check at line 2730-2748 (`mayRespond(existing, verifiedCaller)`) — `body.responder` is advisory only; the real authorization is the actor stamped by the upstream middleware via `logContext`.

**Discovery shape:** `GET /dashboard/decisions?status=open` returns open decisions including their `correlation_id`. The test driver can poll this from inside the operator container (loopback) to learn the `correlation_id` to approve.

**Data flow for a CONFIRM-tier call:**

1. Son-client posts an MCP `tools/call` with bearer token. Transport stamps `actor_id = "peer:son-test"` (`src/transports.ts:526-536`).
2. Chokepoint resolves matrix tier for `(peer:son-test, github.read_file)`. Tier=CONFIRM → `runChokepointDecision()` (`src/security/decision-gate.ts:88`).
3. `broker.store.createDecision(correlationId, question, options, timeoutSec, REJECT, actor, tier)` (line 124) — inserts a row in the `decisions` SQLite table.
4. Daemon publishes `decision_request` event (line 134-148); the call awaits at line 153 (`broker.store.awaitDecisionResponse`).
5. Operator (from inside the container, on loopback) does either: open `http://localhost:7777/dashboard/decide` in a browser, OR `curl -X POST http://localhost:7777/dashboard/decisions/<correlation_id>/respond -d '{"chosen_option_id":"approve"}'`.
6. `respondToDecision()` at `src/transports.ts:2751` updates the row; the awaiting call unblocks; chokepoint returns `{ allowed: true }` and the tool call proceeds.

**Default timeout** is `DEFAULT_TIMEOUT_SEC` (`src/security/decision-gate.ts:93`) — auto-reject fallback if no operator response.

## Q5 — Revocation command

**CLI:** `stavr devices revoke <id>` — registered at `src/cli.ts:659`. Action body at lines 662-698.

**Mechanism:**
- Line 676: `store.revokeDevice(id, revokedAt)`.
- Underlying SQL (`src/persistence.ts:1376`): `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL` — atomic, idempotent.
- Line 686: publishes `device_revoked` event.

**Immediate propagation.** Bearer-auth middleware queries `findActiveDeviceByTokenHash()` at `src/transports.ts:1404`. The query (`src/persistence.ts:1347`) filters `WHERE revoked_at IS NULL` on every request — no caching, no TTL, no daemon restart needed. A token whose device row has `revoked_at` set returns no match → middleware returns `{ ok: false, status: 401, error: 'invalid_token' }` (`src/transports.ts:1405`). The chokepoint never runs.

**Phase 4e expectation matches:** next `tools/call` after revoke returns **401** (not the chokepoint's NO_GO — the auth layer rejects before chokepoint even sees the request).

## Implications for the test substrate

These follow directly from the answers above; calling them out so Phase 1 doesn't have to re-derive them:

- **Bind: `0.0.0.0`** in the `stavr-operator` container after the bootstrap-from-loopback step. Required so the dashboard decision-respond endpoint (loopback-only by middleware) is reachable from inside the container via `docker compose exec stavr-operator curl http://localhost:7777/...`. The son-client still reaches the daemon via `http://stavr-operator:7777` over the Docker network — that's the non-loopback hop the BOM cares about.
- **Two-phase bind dance** mirrors the runbook §3.1/§3.5: start `bind: localhost` → `stavr pair bootstrap` inside the operator container → flip to `bind: 0.0.0.0` → daemon restart. The compose substrate (Phase 1) needs a mechanism to do that flip (entrypoint script, or `docker compose exec` followed by a daemon restart).
- **Auth-ON env shape for the operator container:**
  - DO set: `STAVR_PEER_ID=helm-01`, `STAVR_WEBAUTHN_RP_ID=stavr-operator`, `STAVR_WEBAUTHN_ORIGINS=http://stavr-operator:7777,http://localhost:7777`.
  - Do NOT set: `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH` (the bombardment rig's bypass).
  - YAML: `network.bind` per the dance above; `network.require_auth_when_non_local: true` (default, explicit for clarity).
- **Operator-side authoring (Phase 4)** is via the dashboard or direct loopback `curl` to `/dashboard/permissions/*` from inside the operator container. CC does NOT author rows. The test scripts must surface the request shape so the operator can act, then poll for the daemon's response.
- **Matrix store path inside the container:** `~/.stavr/stavr.db` for the daemon's runtime user. A named volume on `~/.stavr/` (per BOM Phase 1) preserves both the matrix and the devices table across restarts — necessary because the bind-dance restarts the daemon mid-test.

## Things to verify when the operator next acts

- The exact request body shape for `/dashboard/permissions/actor` (field names: `actor_id` vs `actor`, `tool_id` vs `tool`, etc.) — easiest path is for the operator to click the dashboard once and have the browser DevTools show the network request, or for me to read `src/dashboard/pages/permissions.ts` in detail at Phase 4 time.
- Whether `claude mcp add --transport http --header` (runbook §4.1) is actually supported on the CLI version inside the son-client image — if not, fall back to manual `~/.claude.json` edit. (Phase 4-relevant; not blocking now.)
- Whether the `device_revoked` event arriving over SSE causes any in-flight call to be cancelled, or only blocks subsequent calls. Phase 4e only requires the latter.
