# family-son-mcp — Docker-substrate test BOM

**Goal.** Prove the family-son-mcp onboarding runbook (`docs/family-son-mcp.md` Phases 2–4) end-to-end over a non-loopback hop, without WireGuard or a second physical machine. A containerized stavR with **auth ON** plays the operator's daemon; a second container plays the son's MCP client. The Docker network IS the non-loopback hop — different IP, different netns, no shortcut to 127.0.0.1.

**What this BOM proves.**

1. The daemon enforces auth on a non-loopback origin (the bombardment rig's `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH=1` bypass is **OFF** here).
2. Pairing E2E: `stavr pair bootstrap` → `/pair/complete` → bearer token, exactly as the runbook §3 describes.
3. Bearer auth holds: 401 without bearer, not-401 with (the F9-fixed §3.6 smoke).
4. The chokepoint structurally fences a `peer:*` actor at tool-granularity — default-deny NO_GO with no matrix row, AUTO-tier through with a matching row, NO_GO when calling a tool outside the row.
5. CONFIRM-tier per-resource gating works: a CONFIRM-tier row queues a decision the operator approves before the call completes.
6. Revocation cuts off immediately: `stavr devices revoke` → next call 401.

**What this BOM does NOT cover** (tracked follow-ups; do not attempt here):

- Phase 5 (Anthropic-compatible LLM gateway endpoint) — gated, separate operator go-ahead.
- Real WireGuard mesh test — for when the operator has a son's physical machine on hand.
- Native son-side CC tool fencing — locked decision: NOT restricted.
- Chokepoint scope-awareness for trust-scopes — separate future cycle.

## Hard invariants

1. The operator stavR container MUST run with **auth ON** — no `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH`. The bombardment rig's auth-bypass is exactly the contamination this test exists to avoid.
2. The son-client container MUST hit the daemon by container hostname over the Docker network (a real non-loopback hop). NOT via `host.docker.internal` to the host's stavR. NOT a shared netns. This must be a **fresh** stavR instance bound to its container hostname.
3. The actor-permissions matrix is authored by the operator — **NOT by CC**. CC may PROPOSE rows in its report; CC must NOT write into the matrix store. (Per the Option A locked decision.)
4. No changes to the bombardment rig (`bombardment/compose/`, `bombardment/chaos/`, `bombardment/federation/`). This test uses its OWN compose under a new directory `tests/family-son-docker/`.
5. If anything in the runbook turns out to be wrong as you run it (a command that doesn't work, a path that's stale, etc.), CAPTURE the correction. After Phase 4 completes, propose a small fold-in commit to `docs/family-son-mcp.md` with the corrections. Do NOT alter the runbook silently while running the test.

**Sensitivity:** careful. Security-adjacent (auth, pairing, chokepoint). Per-phase verification + operator approval gate at each phase transition.

## Phase 0 — recon

Identify the substrate before building it. Answer all five:

1. The env vars that flip auth ON vs OFF on a containerized stavR. The rig daemons use `STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH=1`; confirm that omitting it (or setting it to `0`) is the auth-ON state, and identify any other auth-related env vars (`STAVR_WEBAUTHN_RP_ID`, etc. — cross-ref the runbook §2.2 / §2.3 + the F3 fix).
2. The daemon's bind config for a non-loopback containerized deployment — what `bind:` value works inside a container where the daemon should listen on its container hostname, and the right `STAVR_WEBAUTHN_RP_ID` paired with it.
3. The actor-permissions matrix storage location inside the container — file path or DB table the operator writes to. Identify the exact operator-side authoring mechanism (dashboard? CLI? YAML edit?).
4. The CONFIRM-tier decision queue — the endpoint or UI the operator approves a pending call through.
5. The revocation command (`stavr devices revoke <id>` — confirm syntax and that it propagates immediately to the chokepoint).

**Deliverable:** `proposed/family-son-mcp-docker-test-recon.md` with all five answers + exact commands/paths. Halt for operator review before Phase 1.

## Phase 1 — compose substrate (loopback-only healthcheck)

> **Restructured 2026-05-26** after the Phase 0 recon addendum: the
> bearer-auth middleware mounts only when `authConfigured=true`
> (`src/transports.ts:492`), so a brand-new daemon cannot safely
> listen on a non-loopback interface. Phase 1 brings up the substrate
> on loopback only; the son-client → operator Docker-network hop check
> moves to Phase 2c, after the bootstrap pair flips `authConfigured`.

New directory: `tests/family-son-docker/` (do NOT put anything under `bombardment/`).

1. `tests/family-son-docker/docker-compose.yml` with two services:
   - `stavr-operator`: image `stavr:ci`. Auth ON (per Phase 0 findings) — `operator/stavr.yaml` ships with `network.bind: 'localhost'` and `require_auth_when_non_local: true` (the runbook §2.5 default). Named volume for `~/.stavr/`. Healthcheck on `127.0.0.1:7777/healthz`. Custom entrypoint (`operator/init.sh`) so the yaml is the single source of truth for `network.bind` across the Phase 2 reconfigure (the stock bombardment entrypoint forces `--bind-host` from `STAVR_BIND_HOST` which would override the yaml).
   - `son-client`: minimal image (alpine + curl + jq) with no daemon. Reaches the operator only at `http://stavr-operator:7777`.
2. `tests/family-son-docker/README.md`: how to `compose up`, tear down, what each file in the rig does, and an explainer for why Phase 1 is loopback-only.
3. `compose up -d`. Verify `stavr-operator` is healthy via the daemon's loopback inside its own container:
   ```sh
   docker compose -f tests/family-son-docker/docker-compose.yml \
     exec stavr-operator curl -fsS http://127.0.0.1:7777/healthz
   ```
   Do NOT attempt son-client → stavr-operator over the Docker network at this phase — the daemon doesn't listen on that interface yet.

**Deliverable:** the compose + README committed; daemon healthy via its own loopback. Halt for operator review.

## Phase 2 — bootstrap dance + son pairing

Walks the runbook §2.5 bootstrap-from-loopback dance plus the §3 son
pairing flow as one continuous sequence. The four sub-steps map to the
four runbook moments.

**2a — Bootstrap pair on operator loopback.** Inside `stavr-operator`:

```sh
docker compose ... exec stavr-operator node /app/dist/cli.js pair bootstrap
# captures the 6-digit code

docker compose ... exec stavr-operator curl -sS -X POST \
  http://127.0.0.1:7777/pair/complete \
  -H 'Content-Type: application/json' \
  -d '{"code":"<6-digit>","device_name":"bootstrap"}'
```

The bootstrap device's bearer token is discarded — its only purpose is to flip `authConfigured=true` so the daemon can be reconfigured for non-loopback bind.

**2b — Reconfigure to bind=0.0.0.0 and restart.** Operator edits `tests/family-son-docker/operator/stavr.yaml` on the host (`bind: 'localhost'` → `bind: '0.0.0.0'`), then:

```sh
docker compose -f tests/family-son-docker/docker-compose.yml restart stavr-operator
```

After restart: the startup bind-auth gate is satisfied (`authConfigured=true`), the bearer-auth middleware is mounted (`src/transports.ts:492` predicate is true: authConfigured && !isLoopback), and the daemon binds non-loopback.

**2c — Son-client → operator Docker-network reachability (the deferred Phase 1 check):**

```sh
docker compose ... exec son-client curl -fsS http://stavr-operator:7777/healthz
# expect: 200
```

**2d — Real pairing over the wire.** Walk the runbook §3 verbatim, container-to-container:

1. Operator side (in `stavr-operator`): `stavr pair bootstrap`. Capture the 6-digit code + the device handle template (`son-test`).
2. Son side (in `son-client`): the runbook's §3.3 curl form against `http://stavr-operator:7777/pair/complete` with the code and `device_name=son-test`. Capture the returned bearer token.
3. Verify on the operator side: `stavr devices list` shows BOTH `bootstrap` and `son-test` active. The bootstrap device is intentional bycatch from 2a.
4. If any runbook command fails or returns a different shape than the runbook claims, NOTE it for the post-Phase-4 fold-in.

**Deliverable:** `tests/family-son-docker/scripts/pair.sh` capturing the son-side network steps (token captured to a file the next phase reads). A short transcript note in the script's header records the bootstrap dance (2a + 2b) so it's reproducible without re-reading the BOM. Halt for operator review.

## Phase 3 — bearer auth smoke

Run the F9-fixed §3.6 verification from the son-client.

1. POST to `/mcp` with proper `Accept: application/json, text/event-stream` and `Content-Type: application/json`, body `{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}`, **without** `Authorization` → expect **401**.
2. Same call **with** `Authorization: Bearer <token from Phase 2>` → expect **not-401** (the MCP SDK handshake; the exact code may vary but auth has passed).

**Deliverable:** `tests/family-son-docker/scripts/auth-smoke.sh` with both checks. Halt for operator review.

## Phase 4 — chokepoint smoke (operator-interactive)

Five sub-checks. The operator authors matrix rows, approves the CONFIRM decision, and runs the revocation. CC drives the son-client calls and captures responses.

**4a — default-deny.** With NO matrix row for `peer:son-test`, send an MCP `tools/call` for any tool (e.g., `github.list_prs`). Expect NO_GO at the chokepoint regardless of HTTP-layer auth.

**4b — AUTO tier.** Operator authors `peer:son-test` → `github.list_prs` at AUTO tier (use the mechanism Phase 0 identified). CC re-sends the call. Expect success.

**4c — out-of-scope NO_GO.** With only the `github.list_prs` row from 4b, CC sends `tools/call github.create_pr`. Expect NO_GO. Confirms default-deny holds for tools NOT in the matrix.

**4d — CONFIRM tier.** Operator adds `peer:son-test` → `github.read_file` at CONFIRM tier. CC sends the call. Expect the call to BLOCK pending a decision. Operator approves via the mechanism Phase 0 identified. The blocked call completes with the file content.

**4e — revocation.** Operator runs `stavr devices revoke <son-test device id>`. CC sends another tool call. Expect 401. Confirms revoke propagates immediately.

**Deliverable:** `tests/family-son-docker/SMOKE-RESULTS.md` recording each sub-check's request, response, and pass/fail. Halt — report end-to-end.

## Done criteria

- All five Phase 4 sub-checks produce the expected outcome.
- The test compose tears down cleanly (`docker compose down -v`).
- The bombardment rig is untouched.
- Any runbook corrections discovered during the test are folded into `docs/family-son-mcp.md` in a small commit before the operator decides to merge `feat/family-son-mcp`.

## Out of scope (do not attempt)

- Phase 5 (LLM gateway endpoint with credential forwarding + metering) — high-sensitivity, separate operator go-ahead.
- Native son-side CC tool fencing — locked decision: NOT restricted.
- Chokepoint scope-awareness for trust-scopes — separate future cycle.
- Real WireGuard test — when the operator has a son's machine on hand.
- Any code changes to the daemon or the chokepoint to "make the test pass" — if the test reveals a real product gap, REPORT and HALT; do not fix the daemon under this BOM.
