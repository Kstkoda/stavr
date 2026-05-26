# family-son-mcp Docker test — Phase 4 SMOKE results

Run date: 2026-05-26. Substrate: `tests/family-son-docker/` rig (operator
container on `0.0.0.0:7777` after the Phase 2 bootstrap dance; son-client
on the Docker bridge `172.19.0.3`). All five sub-checks PASS.

Token + device ids used (gitignored under `state/`):

- son-test bearer: `28b617a904ae...` (48 chars)
- son-test device id: `4dd17142-b525-4ae1-8789-569452220fef`
- bootstrap device id: `6046258c-6386-489d-a189-316fe81391db`

The matrix-write and decision-respond endpoints are loopback-only by
their mount fence (`src/transports.ts:554-560`). Every operator action
below runs **inside** the operator container via
`docker compose exec stavr-operator ...`.

Source references used in interpreting the results:

- `src/security/actor-permissions.ts:181` — default-deny when no matrix row
- `src/security/decision-gate.ts:254-264` — per-actor NO_GO reason format
- `src/security/decision-gate.ts:88-189` — CONFIRM-tier decision flow
- `src/tools/registry.ts:227-232` — `wrapHandlerWithGate` MCP error shape
- `src/transports.ts:1386-1407` — `checkBearerAuth()` 401 paths
- `src/transports.ts:2062-2096` — `POST /dashboard/permissions/actor`
- `src/transports.ts:2706-2787` — `POST /dashboard/decisions/:id/respond`
- `src/cli.ts:659-698` — `stavr devices revoke`
- `src/persistence.ts:1347` — `WHERE revoked_at IS NULL` filter

---

## 4a — default-deny ✅ PASS

**Premise.** No matrix row exists for `peer:son-test`. The chokepoint
must default-deny ANY tool the son invokes.

**Request — son-client → operator (Docker network):**

```sh
# Two-step MCP handshake; tool-call.sh drives initialize, captures
# mcp-session-id, then sends tools/call:
sh tests/family-son-docker/scripts/tool-call.sh 4a github.list_prs \
   '{"owner":"Kstkoda","repo":"stavr","state":"open"}'
```

**Operator action.** None.

**Response (verbatim, `state/4a-response.txt`):**

```
HTTP/1.1 200 OK
content-type: text/event-stream
mcp-session-id: d6f2dadd-aaa0-407b-9900-d5d999cc6c8c

event: message
id: 99076481-8796-44c8-a3c8-dae5b6ddc59a:2
data: {"result":{"content":[{"type":"text","text":"per-actor NO_GO: actor \"peer:son-test\" cannot invoke github.list_prs (source=default-deny)"}],"isError":true},"jsonrpc":"2.0","id":2}
```

**Verdict.** ✅ PASS. Chokepoint denied at the per-actor layer with
`source=default-deny`. Note the **structural distinctness from 401**:

- HTTP 200 (transport succeeded; bearer-auth gate passed)
- `content-type: text/event-stream` (MCP SDK wrapping)
- `mcp-session-id` present
- JSON-RPC `result` with `isError: true` and a text `content` block
- **NO `structuredContent` field** (no tool layer was reached)

---

## 4b — AUTO tier ✅ PASS

**Premise.** Operator authors a single row in the matrix:
`peer:son-test → github.list_prs` at AUTO. The same call from 4a must
now succeed past the chokepoint.

**Operator action — author the AUTO row** (loopback POST inside the
operator container; `mayRespond`-style loopback fence per
`src/transports.ts:554-560`):

```sh
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator curl -sS -X POST \
    http://127.0.0.1:7777/dashboard/permissions/actor \
    -H 'Content-Type: application/json' \
    -d '{"actor_id":"peer:son-test","tool_id":"github.list_prs","tier":"AUTO","set_by":"operator"}'
```

(Note for Windows operators: the inline `-d` form mangles JSON via
PowerShell argv conversion. See the runbook fold-in section at the
end of this file for the safe three-step `Set-Content → docker cp →
curl --data-binary @file` pattern. The bash form above is what
worked for the operator in this run from inside the container's
shell.)

**Operator response:**

```json
{"ok":true,"actor_id":"peer:son-test","tool_id":"github.list_prs","tier":"AUTO"}
```

**Request — son-client → operator (Docker network), same tool as 4a:**

```sh
sh tests/family-son-docker/scripts/tool-call.sh 4b github.list_prs \
   '{"owner":"Kstkoda","repo":"stavr","state":"open"}'
```

**Response (verbatim, `state/4b-response.txt`):**

```
HTTP/1.1 200 OK
content-type: text/event-stream
mcp-session-id: a1883e0e-de59-4bae-b5e2-3b807564e984

event: message
data: {"result":{"content":[{"type":"text","text":"{\"code\":\"gh_failed\",\"message\":\"gh pr list --repo stavr --state open --limit 30 --json number,title,state,author,headRefName,baseRefName,updatedAt,createdAt,isDraft failed: spawn gh ENOENT\",\"exit_code\":\"ENOENT\",\"stderr\":\"\"}"}],"structuredContent":{"code":"gh_failed","message":"gh pr list --repo stavr --state open --limit 30 --json number,title,state,author,headRefName,baseRefName,updatedAt,createdAt,isDraft failed: spawn gh ENOENT","exit_code":"ENOENT","stderr":""},"isError":true},"jsonrpc":"2.0","id":2}
```

**Verdict.** ✅ PASS. Chokepoint allowed the call through (no
`per-actor NO_GO` reason); the failure is at the **tool execution
layer** — the bombardment image doesn't ship the `gh` CLI binary, so
`spawn gh ENOENT`. The `structuredContent` field is the
chokepoint-passed signature: only present when the tool handler ran.

**Substrate note.** The image ships the stavR daemon but no GitHub
CLI tooling. Every `github.*` tool that wraps a `gh` subprocess will
return this same `gh_failed` shape downstream of the chokepoint. That
is acceptable for the test: the assertion target is the chokepoint
behavior, and `structuredContent` presence is sufficient proof the
gate let the call through. Installing `gh` in the test image is a
future enhancement if we want to assert on tool output too.

---

## 4c — out-of-scope NO_GO ✅ PASS

**Premise.** Only `github.list_prs` is in the matrix from 4b.
Anything else must still default-deny.

**Request — son-client → operator (Docker network):**

```sh
sh tests/family-son-docker/scripts/tool-call.sh 4c github.create_pr \
   '{"owner":"Kstkoda","repo":"stavr","title":"test","body":"test","head":"feat/test","base":"main"}'
```

**Operator action.** None.

**Response (verbatim, `state/4c-response.txt`):**

```
HTTP/1.1 200 OK
content-type: text/event-stream
mcp-session-id: 20c216f2-fe4e-4b20-9400-fb519a046576

event: message
data: {"result":{"content":[{"type":"text","text":"per-actor NO_GO: actor \"peer:son-test\" cannot invoke github.create_pr (source=default-deny)"}],"isError":true},"jsonrpc":"2.0","id":2}
```

**Verdict.** ✅ PASS. Same chokepoint NO_GO shape as 4a — no
`structuredContent`, no tool execution, default-deny. The 4b row for
`github.list_prs` did NOT bleed into `github.create_pr` permissions.
Confirms the matrix is per-(actor, tool) granular.

---

## 4d — CONFIRM tier ✅ PASS

**Premise.** Operator adds a second row:
`peer:son-test → github.read_file` at CONFIRM. The son's call must
BLOCK until the operator approves a decision in the queue.

**Operator action 1 — author the CONFIRM row** (PowerShell three-step
file form to avoid Windows argv JSON-mangling):

```powershell
'{"actor_id":"peer:son-test","tool_id":"github.read_file","tier":"CONFIRM","set_by":"operator"}' `
  | Set-Content -Path body.json -NoNewline -Encoding ascii

docker compose -f tests/family-son-docker/docker-compose.yml `
  cp body.json stavr-operator:/tmp/body.json

docker compose -f tests/family-son-docker/docker-compose.yml `
  exec stavr-operator curl -sS -X POST `
    http://127.0.0.1:7777/dashboard/permissions/actor `
    -H "Content-Type: application/json" `
    --data-binary "@/tmp/body.json"
```

**Operator response:**

```json
{"ok":true,"actor_id":"peer:son-test","tool_id":"github.read_file","tier":"CONFIRM"}
```

**Son request — backgrounded** (will block on the chokepoint
decision):

```sh
# initialize first to capture session, then tools/call in background
TOKEN=$(cat tests/family-son-docker/state/son-test-token)
# ... (init exchange omitted for brevity; full call in
#      state/4d-init.txt + bg curl writing to state/4d-response.txt)
curl -isS --max-time 300 -X POST http://stavr-operator:7777/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Mcp-Session-Id: 850f6f85-49f5-4c61-bd78-ba1ec52a9f7b" \
  --data '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"github.read_file","arguments":{"owner":"Kstkoda","repo":"stavr","path":"README.md"}}} ' \
  > state/4d-response.txt &
```

**Verification while call is hanging — pending decision visible to
operator:**

```sh
docker compose exec stavr-operator curl -sS \
  'http://127.0.0.1:7777/dashboard/decisions?status=open'
```

Response:

```json
{"decisions":[{
  "correlation_id": "2776ffdb-cba5-4d39-aca4-05c7b29870a7",
  "question": "Approve github.read_file call (tier=CONFIRM, actor=peer:son-test)?",
  "options": [{"id":"approve","label":"Approve"},{"id":"reject","label":"Reject"}],
  "default_option_id": "reject",
  "timeout_sec": 1800,
  "status": "open",
  "requested_at": "2026-05-26T08:50:41.534Z",
  "expires_at": "2026-05-26T09:20:41.534Z",
  "source_agent": "peer:son-test",
  "tier": "CONFIRM"
}]}
```

This is the operator-visible queue state proving the chokepoint
created the decision row and is awaiting human input. The
`source_agent: peer:son-test` is the actor stamped by the
`/mcp` middleware at `src/transports.ts:526-536`; the operator can
correlate this with the device row in `stavr devices list`.

**Operator action 2 — approve the decision** (PowerShell three-step):

```powershell
'{"chosen_option_id":"approve","responder":"operator","reason":"smoke 4d"}' `
  | Set-Content -Path body.json -NoNewline -Encoding ascii

docker compose -f tests/family-son-docker/docker-compose.yml `
  cp body.json stavr-operator:/tmp/body.json

docker compose -f tests/family-son-docker/docker-compose.yml `
  exec stavr-operator curl -sS -X POST `
    http://127.0.0.1:7777/dashboard/decisions/2776ffdb-cba5-4d39-aca4-05c7b29870a7/respond `
    -H "Content-Type: application/json" `
    --data-binary "@/tmp/body.json"
```

**Operator response:**

```json
{"ok":true,"responded_at":"2026-05-26T08:54:15.809Z"}
```

**Backgrounded call response (verbatim, `state/4d-response.txt`):**

```
HTTP/1.1 200 OK
content-type: text/event-stream
mcp-session-id: 850f6f85-49f5-4c61-bd78-ba1ec52a9f7b

event: message
data: {"result":{"content":[{"type":"text","text":"{\"code\":\"gh_failed\",\"message\":\"gh api repos/stavr/contents/README.md failed: spawn gh ENOENT\",\"exit_code\":\"ENOENT\",\"stderr\":\"\"}"}],"structuredContent":{"code":"gh_failed","message":"gh api repos/stavr/contents/README.md failed: spawn gh ENOENT","exit_code":"ENOENT","stderr":""},"isError":true},"jsonrpc":"2.0","id":2}
```

**Post-approval queue state:**

```json
{"decisions":[]}
```

**Verdict.** ✅ PASS. End-to-end CONFIRM-tier human-in-the-loop
proven:

1. Call blocked at `await broker.store.awaitDecisionResponse(...)`
   in `src/security/decision-gate.ts:153`.
2. Decision row visible in `/dashboard/decisions?status=open` with
   the operator-readable question text + the original args (repo +
   path) accessible via the correlation_id audit trail.
3. Operator POSTed approval with `chosen_option_id: "approve"`.
4. `respondToDecision` resolved the awaited promise; the chokepoint
   returned `{ allowed: true }` and the tool handler ran (and failed
   on `gh_failed` per the substrate note in 4b — `structuredContent`
   is present, proving the gate let it through).
5. Open queue cleared.

**Cycle time.** Decision queued at 08:50:41.534Z, approval at
08:54:15.809Z — ~3:34 hands-on for the three-step PowerShell
ceremony. The default `timeout_sec: 1800` (30 min, per
`src/security/decision-gate.ts:93`) gave plenty of headroom.

---

## 4e — revocation ✅ PASS

**Premise.** Operator revokes the son-test device. The next call
from son-client — using the same bearer that worked in 4d — must
401 at the bearer-auth middleware, BEFORE the chokepoint runs.

**Operator action — revoke** (no JSON body, no quoting issue):

```powershell
docker compose -f tests/family-son-docker/docker-compose.yml `
  exec stavr-operator node /app/dist/cli.js devices revoke `
    4dd17142-b525-4ae1-8789-569452220fef
```

**Operator response:**

```json
{"ok":true,"device_id":"4dd17142-b525-4ae1-8789-569452220fef","revoked_at":"2026-05-26T09:12:22.741Z"}
```

(Note: actual response uses `device_id`, not `id`. Captured for
runbook fold-in below.)

**Request — son-client → operator, reusing the same bearer:**

```sh
sh tests/family-son-docker/scripts/tool-call.sh 4e github.list_prs \
   '{"owner":"Kstkoda","repo":"stavr","state":"open"}'
```

**Response (verbatim, `state/4e-init.txt` — auth fails before tool-call
even sends; helper script exits non-zero because no
`mcp-session-id` header was returned, which is the correct shape):**

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Content-Length: 36

{"ok":false,"error":"invalid_token"}
```

**Verdict.** ✅ PASS. Revocation propagated immediately. Structurally
distinct from every other Phase 4 shape:

| Phase   | HTTP   | Content-Type             | Session  | structuredContent | error string |
|---------|--------|--------------------------|----------|-------------------|--------------|
| Phase 3 no-token | 401 | application/json | — | — | `missing_or_invalid_authorization` |
| 4a / 4c default-deny | 200 | text/event-stream | yes | no | (text content: `per-actor NO_GO ...`) |
| 4b AUTO / 4d CONFIRM-approved | 200 | text/event-stream | yes | yes | (gh_failed downstream) |
| **4e revoked** | **401** | **application/json** | **—** | **—** | **`invalid_token`** |

**One useful sub-distinction within 401:**
- `missing_or_invalid_authorization` — no/malformed `Authorization`
  header (Phase 3).
- `invalid_token` — header present + bearer parses, but
  `findActiveDeviceByTokenHash` returned null because
  `WHERE revoked_at IS NULL` filtered the row out (this case).

Both 401; different `error` strings. Useful for the operator to
distinguish "son never paired" vs "son's device was revoked" in the
audit log without needing the bearer hash.

---

## Runbook divergences captured (for the post-Phase-4 fold-in to `docs/family-son-mcp.md`)

These were observed during Phase 2–4 execution. Held aside per BOM
hard invariant — captured but NOT silently fixed mid-test.

1. **`/pair/complete` response shape (Phase 2 / runbook §3.3).** The
   documented example shows `{device_id, device_name, paired_at,
   token}`. Actual response includes an `ok: true` prefix:
   `{ok:true, device_id, device_name, paired_at, token}`. Same for
   the `pair bootstrap` CLI output (runbook §3.2 already shows
   `ok:true`, but the §3.3 example body is missing it). Fold-in:
   add `"ok": true,` to the §3.3 example JSON.

2. **`/mcp` with-bearer expected response shape (Phase 3 /
   runbook §3.6).** The F9 example uses `--data '{}'` and expects
   400 ("MCP body error, auth satisfied"). That still holds. But a
   proper `initialize` body returns **200 with `mcp-session-id`**
   and an SSE-framed `result` block — arguably more demonstrative
   because the operator sees the MCP capability advertisement
   land. Fold-in: add an "alternative form" paragraph showing both
   `--data '{}'` → 400 and `--data '{...initialize...}'` → 200; both
   validate "auth satisfied". The robust assertion is "not 401".

3. **PowerShell-quoting gotcha (Windows operators).** The runbook's
   curl examples are bash-shaped. Inline `-d '{"...":"..."}'` is
   mangled by PowerShell argv conversion before docker.exe sees
   it — returns 400 with an HTML "Bad Request" page. Fold-in: add
   a Windows § (or a side note in §3.3 / §4.3) showing the safe
   three-step file form:

   ```powershell
   '<json>' | Set-Content -Path body.json -NoNewline -Encoding ascii
   docker compose ... cp body.json <container>:/tmp/body.json
   docker compose ... exec <container> curl -sS -X POST <url> `
     -H "Content-Type: application/json" `
     --data-binary "@/tmp/body.json"
   ```

   This applies to every operator-side POST to `/dashboard/permissions/*`
   and `/dashboard/decisions/*/respond` from a Windows host. Calls
   that take no JSON body (`stavr devices revoke <id>`, `stavr pair
   bootstrap`) are fine inline.

4. **`stavr devices revoke` response shape (4e).** Returns
   `{"ok":true,"device_id":"<uuid>","revoked_at":"<ISO>"}`. The
   field is `device_id`, not `id`. Fold-in: add the example JSON
   to runbook §4.4 step 5 ("Token revocation kills access
   immediately") so callers know the exact shape if they're
   scripting against it.

---

## What's verified end-to-end

- Auth ON enforced on every non-loopback `/mcp` call (Phase 3 + 4e).
- Chokepoint structural fence at tool granularity:
  - default-deny when no matrix row (4a, 4c)
  - AUTO passes through (4b)
  - CONFIRM blocks and resolves through operator decision (4d)
- Revocation is immediate at the bearer-auth layer; no cache, no
  daemon restart (4e).
- Every gate's denial shape is structurally distinct from every
  other (table above).
- All operator-side writes (matrix authoring, decision approval,
  device revoke) are loopback-only by mount fence
  (`src/transports.ts:554-560`) and required the operator to act
  from inside the operator container.

## What's deliberately NOT covered

- Phase 5 (Anthropic-compatible LLM gateway with credential
  forwarding + metering) — separate operator go-ahead.
- Real WireGuard mesh — for when there's a son's physical machine
  on hand.
- Native son-side CC tool fencing — locked decision: NOT restricted.
- Per-resource (per-repo, per-path) scope fence at the chokepoint —
  today's per-resource gate is "CONFIRM tier + operator eyes" (4d).
- Tool-layer assertions (e.g. that `github.read_file` actually
  returns README content) — the substrate doesn't ship `gh`. Future
  enhancement.
