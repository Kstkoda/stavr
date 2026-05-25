# Family — son as a remote MCP client of stavR

> **Model.** The son runs a normal Claude Code install on his own machine. His CC points at the operator's stavR `/mcp` endpoint. Every tool call passes through stavR's 4-tier chokepoint; tool credentials never leave the operator's box. No stavR daemon and no CC worker processes run on the son's machine.

This guide walks the operator (Kenneth) through the three phases of bringing one son online:

- **Phase 2 — Reachability.** Bring the daemon up on the WireGuard mesh under a stable hostname.
- **Phase 3 — Pairing.** Issue a device bearer token to the son's machine.
- **Phase 4 — MCP channel.** Configure the son-side Claude Code; the operator authors actor-permissions in the dashboard; smoke an end-to-end call.

Phase 5 (Anthropic-compatible LLM gateway) is a separate, high-sensitivity follow-up — not covered here.

**Naming convention used in this guide** — neutral handles, no personal or computer names:

| Slot | Value |
|---|---|
| Daemon hostname on mesh | `helm.stavr.mesh` |
| `STAVR_PEER_ID` | `helm-01` |
| `STAVR_WEBAUTHN_RP_ID` | `helm.stavr.mesh` |
| Son's device handle | `<son-handle>` — operator chooses at pair time (e.g., `peer-01`, `g1`). Becomes `peer:<son-handle>` at the chokepoint. |

The operator keeps a private mapping from handle to person; the daemon never sees a name.

---

## Phase 2 — Daemon reachability

The work in this phase is operator-side: stand up the WG mesh, point the daemon at a stable hostname, set the WebAuthn RP id, restart, verify. No code changes.

### 2.1 — WireGuard mesh (operator-provisioned)

Out of scope for stavR itself, but a prerequisite. Requirements the mesh must satisfy:

- The operator's stavR host is reachable from the son's machine at a **stable hostname** — never a bare IP. WebAuthn RP id validation will reject an IP literal.
- DNS resolution of `helm.stavr.mesh` works on both ends. Two cheap options:
  - **Hosts-file entries.** On the operator's machine, add `<wg-ip> helm.stavr.mesh` to `C:\Windows\System32\drivers\etc\hosts`. On the son's machine, add the same. Trivial; no DNS server needed.
  - **WireGuard DNS field.** Set the `DNS` field in the son's WG peer config to a small internal resolver (or to the operator's host if it runs `dnsmasq`). Marginally cleaner; more infra.
- WG traffic between the two endpoints is fully encrypted by WG itself. stavR speaks plain HTTP inside the tunnel — that is correct and intended; do not bolt a TLS terminator on top unless you also adjust `STAVR_WEBAUTHN_ORIGINS`.
- The operator's WG interface allows inbound TCP on stavR's port (default 7777).

Verify from the son's machine BEFORE configuring stavR:

```powershell
# Should print the operator's WG-side IP
nslookup helm.stavr.mesh

# Should print TCP open / refused / filtered; "open" is what we want
Test-NetConnection helm.stavr.mesh -Port 7777
```

(Bash equivalents: `getent hosts helm.stavr.mesh`, `nc -vz helm.stavr.mesh 7777`.)

### 2.2 — Configure stavR (operator side)

Edit `~/.stavr/stavr.yaml` (Windows: `C:\Users\<you>\.stavr\stavr.yaml`). Create the file if it does not exist:

```yaml
network:
  # The mesh hostname — must resolve on every machine that will reach the
  # daemon. Bare IPs are NOT acceptable here; WebAuthn RP id will reject
  # an IP literal at origin validation, breaking Tier-3 EXPLICIT flows.
  bind: helm.stavr.mesh

  # Default-true; the daemon refuses non-loopback bind without at least
  # one paired device. Phase 3 brings up that first device. Until then,
  # the daemon will refuse to start with the non-loopback bind above —
  # which is correct. Pair from loopback first (Phase 3), then restart.
  require_auth_when_non_local: true
```

### 2.3 — Set environment variables (operator side)

Two env vars on the daemon process. The exact mechanism depends on the supervisor:

**Windows (WinSW — the OS-native governor):** edit `bin/winsw/StavrDaemon.xml` and add inside `<service>`:

```xml
<env name="STAVR_PEER_ID" value="helm-01"/>
<env name="STAVR_WEBAUTHN_RP_ID" value="helm.stavr.mesh"/>
<env name="STAVR_WEBAUTHN_ORIGINS" value="http://helm.stavr.mesh:7777,http://localhost:7777"/>
```

Then restart:

```powershell
.\bin\winsw\StavrDaemon.exe stop
.\bin\winsw\StavrDaemon.exe start
```

**Linux (systemd --user):** `systemctl --user edit stavr.service`, add:

```ini
[Service]
Environment="STAVR_PEER_ID=helm-01"
Environment="STAVR_WEBAUTHN_RP_ID=helm.stavr.mesh"
Environment="STAVR_WEBAUTHN_ORIGINS=http://helm.stavr.mesh:7777,http://localhost:7777"
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user restart stavr.service
```

**macOS (launchd):** edit `~/Library/LaunchAgents/com.stavr.daemon.plist`, add the three env entries under `EnvironmentVariables`, then:

```bash
launchctl bootout gui/$(id -u)/com.stavr.daemon
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stavr.daemon.plist
```

### 2.4 — Why these values matter (skim if you've done this before)

- `STAVR_PEER_ID=helm-01` — replaces the default `stavr-self` in mDNS / federation announcements. Two daemons advertising `stavr-self` on the same network collide. `helm-01` is operator-shape (the role) plus an ordinal — readable in logs, anonymous in announcements.
- `STAVR_WEBAUTHN_RP_ID=helm.stavr.mesh` — the relying-party id WebAuthn binds passkeys to. It MUST match the hostname the operator's browser sees in the URL bar when registering passkeys against this daemon, otherwise registration succeeds but authentication mysteriously fails on the next session.
- `STAVR_WEBAUTHN_ORIGINS=http://helm.stavr.mesh:7777,http://localhost:7777` — explicit origin allowlist for WebAuthn ceremonies. Includes loopback so the operator can still register passkeys from `http://localhost:7777`; includes the mesh hostname for any future cross-machine dashboard use.

### 2.5 — First boot will refuse — that is correct

After 2.2/2.3, restart and check logs. The daemon WILL refuse to bind:

```
stavr daemon refusing to bind non-local without auth configured.
Run `stavr pair bootstrap` first or set `network.require_auth_when_non_local: false`
if you know what you're doing.
```

This is the bind-auth gate working as designed (see `src/config.ts::checkBindAuthGate`). It is preventing the daemon from being reachable until at least one paired device exists.

**Recovery — TEMPORARILY drop bind back to loopback** so you can run `stavr pair bootstrap`:

```yaml
network:
  bind: localhost
  require_auth_when_non_local: true
```

Restart, complete Phase 3 (pair one device), then flip `bind` back to `helm.stavr.mesh` and restart again. After the first paired device, `authConfigured` is true and the non-loopback bind is accepted.

### 2.6 — Verification

**On the operator's machine** (loopback should still answer regardless of bind):

```powershell
# Health check — 200, body is `{"ok":true,...}` or similar
Invoke-RestMethod http://localhost:7777/healthz

# Confirm bind from logs
Get-Content -Tail 20 $env:LOCALAPPDATA\stavr\logs\StavrDaemon.out.log
# expect: "HTTP/SSE listening on helm.stavr.mesh:7777"
```

**On the son's machine** (after Phase 3 lands a paired device and you've flipped bind back to `helm.stavr.mesh`):

```powershell
# 200 — public-allowlist endpoint, no token required
Invoke-RestMethod http://helm.stavr.mesh:7777/healthz

# 401 — /mcp without bearer is the no-go signal we want
try {
  Invoke-RestMethod http://helm.stavr.mesh:7777/mcp -Method POST -Body '{}' -ContentType 'application/json'
} catch [System.Net.WebException] {
  $_.Exception.Response.StatusCode  # Unauthorized
}
```

Bash equivalents:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://helm.stavr.mesh:7777/healthz
# expect: 200

curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' http://helm.stavr.mesh:7777/mcp
# expect: 401
```

### 2.7 — Phase 2 done — what's verified

- The WG mesh resolves `helm.stavr.mesh` from the son's machine.
- The operator's daemon binds on `helm.stavr.mesh:7777` after the bootstrap pair (Phase 3).
- `/healthz` answers from both ends.
- `/mcp` without a bearer returns 401 — the bearer-auth middleware is active on non-loopback.

If any of these fail, do NOT proceed. Phase 3's pair-complete request runs through the same middleware; broken reachability here will surface as confusing failures there.

---

## Phase 3 — Device pairing

Bootstrap the son's machine as a paired device of the operator's daemon. Outputs a long-term bearer token the son's Claude Code will carry on every `/mcp` request.

The ceremony is two commands across two machines; the token is shown exactly once.

### 3.1 — Prerequisite — daemon back on loopback for the bootstrap

`stavr pair bootstrap` is loopback-only by design (the `/pair/initiate` endpoint refuses non-loopback callers). If Phase 2's `network.bind: helm.stavr.mesh` is still in `~/.stavr/stavr.yaml`, the daemon currently refuses to start because no paired devices exist yet. Temporarily set:

```yaml
network:
  bind: localhost
  require_auth_when_non_local: true
```

Restart the daemon (the right `restart` invocation per Phase 2.3 for your supervisor). The daemon is now on `127.0.0.1:7777` — Phase 3 uses that.

After Phase 3 completes successfully, flip `bind` back to `helm.stavr.mesh` and restart once more.

### 3.2 — Operator side — open the pairing window

On the operator's machine, from any terminal:

```powershell
stavr pair bootstrap
```

Output (JSON):

```json
{
  "ok": true,
  "code": "123456",
  "expires_at": "2026-05-25T12:34:56.789Z",
  "instructions": "Run `stavr pair remote-host --daemon-url <addr> --code 123456 --name <device-name>` on the new device."
}
```

The 6-digit code is valid for **5 minutes**. If it expires, re-run `stavr pair bootstrap` for a new one.

### 3.3 — Son side — exchange the code for a token

The son's machine needs to reach the operator's daemon via the WG mesh. The mesh hostname is `helm.stavr.mesh:7777`. The son has TWO options for the exchange:

**Option A — raw curl (no stavR install on son's machine, recommended for BOM intent).**

```bash
# Substitute the real 6-digit code and a neutral device handle.
curl -sS -X POST http://helm.stavr.mesh:7777/pair/complete \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456","device_name":"<son-handle>"}'
```

PowerShell equivalent:

```powershell
$body = @{ code = '123456'; device_name = '<son-handle>' } | ConvertTo-Json
Invoke-RestMethod -Method POST `
  -Uri 'http://helm.stavr.mesh:7777/pair/complete' `
  -ContentType 'application/json' `
  -Body $body
```

Response (JSON):

```json
{
  "device_id": "9c1f...",
  "device_name": "<son-handle>",
  "paired_at": "2026-05-25T12:35:10.123Z",
  "token": "8e2a1f...long-opaque-string"
}
```

**The `token` is the bearer the son's Claude Code will use in Phase 4.** Save it somewhere durable — a password manager entry is the right place. The daemon stores only the SHA-256 hash; the raw value is shown exactly once and cannot be recovered.

**Option B — stavR CLI installed on the son's machine.** Slightly more polished, also slightly larger footprint. If the son has stavR installed:

```bash
stavr pair remote-host \
  --daemon-url http://helm.stavr.mesh:7777 \
  --code 123456 \
  --name <son-handle>
```

This calls `/pair/complete` for you and writes the token to the son's local `~/.stavr/devices.yaml`. Same response shape. Either path produces the same server-side state.

> **BOM intent.** The BOM specifies the son runs Claude Code only — no stavR daemon, no CC worker processes. The stavR CLI is technically more than that, but a one-shot CLI for pairing is a small concession. **Option A (curl) is the cleaner match for the BOM** because it leaves the son's machine with nothing stavR-related except the bearer token pasted into the CC config.

### 3.4 — Operator side — verify the device landed

```powershell
stavr devices list
```

Output should include the new device:

```json
[
  {
    "id": "9c1f...",
    "name": "<son-handle>",
    "paired_at": "2026-05-25T12:35:10.123Z",
    "paired_from_ip": "10.0.0.42",
    "revoked_at": null
  }
]
```

`paired_from_ip` should be the son's WG-side IP — sanity-check it matches the address WG hands out to the son.

### 3.5 — Bring the daemon back up on the mesh

The first paired device exists, so `authConfigured` is now true and the bind-auth gate will accept the non-loopback bind. Flip `~/.stavr/stavr.yaml`:

```yaml
network:
  bind: helm.stavr.mesh
  require_auth_when_non_local: true
```

Restart the daemon. Logs should show:

```
HTTP/SSE listening on helm.stavr.mesh:7777
```

### 3.6 — Verification

**From the son's machine.** The token is what we're testing.

```bash
# Without token — 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  --data '{}' http://helm.stavr.mesh:7777/mcp
# expect: 401

# With token — 400 or 406 (MCP-protocol error, NOT 401). That's the win:
# bearer-auth let us in; the request body is invalid MCP, which is what
# we want to prove at the auth layer.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <paste-token-here>' \
  --data '{}' http://helm.stavr.mesh:7777/mcp
# expect: 400 or 406 (NOT 401)

# /healthz — public allowlist, always 200
curl -s -o /dev/null -w '%{http_code}\n' http://helm.stavr.mesh:7777/healthz
# expect: 200
```

PowerShell variant uses `Invoke-WebRequest -SkipHttpErrorCheck` to capture non-2xx codes without exception machinery.

### 3.7 — If pairing fails

| Symptom | Likely cause |
|---|---|
| `connect: connection refused` from `pair/complete` | Daemon not running on `helm.stavr.mesh:7777`, or `network.bind` is still `localhost`. Phase 2 verification didn't fully pass. |
| `404 not_found` or `400 invalid_code` | Code expired (5-min TTL) or mistyped. Re-run `stavr pair bootstrap`. |
| `400 device_name required` | The `device_name` field is required and must be non-empty in `/pair/complete`. |
| Operator's `stavr pair bootstrap` returns `403 loopback_only` | The bootstrap command was run against a non-loopback URL. `/pair/initiate` refuses non-loopback callers. Run on the operator's machine against `http://127.0.0.1:7777`. |
| Son's curl hangs forever | WG tunnel down, or no route. Re-run the Phase 2 `Test-NetConnection` / `nc -vz` reachability probe. |

### 3.8 — Phase 3 done — what's verified

- One device row exists in the operator's `devices` table, paired from the son's WG IP.
- The son holds a long-term bearer token (in his password manager, or in his stavR `devices.yaml` if Option B).
- Non-loopback `/mcp` with the token is accepted (returns an MCP protocol error, not 401).
- Without the token, `/mcp` returns 401.
- The daemon is back on `helm.stavr.mesh:7777`.

---

## Phase 4 — MCP channel + son-side CC config

The son's Claude Code points at the operator's `/mcp` endpoint and carries the Phase 3 bearer token on every request. The operator authors a tight `actor_permissions` matrix in the dashboard so the son's `peer:<son-handle>` actor can only do what was agreed.

### 4.1 — Son-side Claude Code MCP entry

Claude Code reads MCP server configs from one of:

- **User scope:** `~/.claude.json` (or platform equivalent: `%USERPROFILE%\.claude.json` on Windows, `~/Library/Application Support/Claude/.claude.json` on macOS — `claude mcp list` will print the resolved path).
- **Project scope:** `.mcp.json` in the project root.

For the family-mode model, **user scope** is correct — the son's stavR connection follows him across projects.

**Preferred — let the Claude Code CLI write the entry:**

```bash
claude mcp add --transport http --scope user stavr \
  http://helm.stavr.mesh:7777/mcp \
  --header "Authorization: Bearer <paste-token-from-phase-3.3>"
```

If the local `claude mcp add` doesn't accept `--header` (older CLI), fall back to the manual JSON below.

**Manual fallback — edit `~/.claude.json`:**

```json
{
  "mcpServers": {
    "stavr": {
      "type": "http",
      "url": "http://helm.stavr.mesh:7777/mcp",
      "headers": {
        "Authorization": "Bearer <paste-token-from-phase-3.3>"
      }
    }
  }
}
```

Save, then restart any open Claude Code session so the new config is read.

### 4.2 — Verify the son's CC sees stavR

In a fresh Claude Code session on the son's machine:

```
> /mcp
```

Claude Code prints the configured MCP servers and their connection state. `stavr` should appear in the list and resolve as connected. If it appears but shows an auth error, the bearer header is wrong — re-check the token.

### 4.3 — Operator-side — author the actor_permissions matrix

> **Operator-only step.** Matrix writes are gated to the operator via the dashboard (MCP tool writes are blocked at the transport layer for safety). I do not author rows.

Until the operator adds rows for `peer:<son-handle>`, EVERY tool the son's CC tries will be denied at the chokepoint with `per-actor NO_GO: actor "peer:<son-handle>" cannot invoke <tool> (source=default-deny)`. That is the structural fence — see `proposed/family-son-mcp-recon.md` §2 for the full mechanic.

In the operator's browser, open `http://localhost:7777/dashboard/permissions`. The matrix is a (actor × tool) grid. Add the son's actor first if it isn't there (the Phase 3 paired device should have caused it to surface).

**Recommended seed — Option A baseline from the recon doc.** Tool granularity, default-deny everything else:

| Tool (registered id) | Tier | Why |
|---|---|---|
| `github.list_branches` | AUTO | Cheap listing; per-repo is rarely sensitive |
| `github.list_commits` | AUTO | Listing |
| `github.list_issues` | AUTO | Listing |
| `github.list_prs` | AUTO | Listing |
| `github.list_pr_files` | AUTO | Listing |
| `github.list_labels` | AUTO | Listing |
| `github.list_workflow_runs` | AUTO | Listing |
| `github.read_file` | **CONFIRM** | Content read — operator wants visibility per-call so per-repo can be checked at confirm time |
| `github.read_commit` | CONFIRM | Content read |
| `github.read_issue` | CONFIRM | Content read |
| `github.read_pr` | CONFIRM | Content read |
| `github.read_pr_diff` | CONFIRM | Content read |
| `github.read_pr_review_comments` | CONFIRM | Content read |
| `github.read_workflow_run` | CONFIRM | Content read |
| **Every other tool** | **(no row — default-deny → NO_GO)** | The son can't invoke them at all |

**No write tools** in the son's matrix to start. If the son needs to propose a PR later, the operator adds `github.create_pr` at tier `CONFIRM` then — never `AUTO` for a write tool.

The CONFIRM-tier reads land in the operator's decision queue (Telegram + `/dashboard/decide`). That is the per-resource gate today: the operator sees the repo + path the son requested and approves or rejects per call. It is operationally heavier than a per-resource scope fence but uses zero new code — see Option A in the recon.

### 4.4 — Two-machine smoke

End-to-end proof that the channel works. Each item is one observable behaviour.

**Pre-flight:**

- Operator dashboard `/dashboard/permissions` shows `peer:<son-handle>` rows per §4.3.
- Operator has Telegram notifications configured (or accepts that decisions only land in the dashboard).
- Son's Claude Code session shows `stavr` connected in `/mcp`.

**Tests, in order:**

1. **AUTO read — silent pass.** Son's CC: "list the branches on Kstkoda/stavr." CC invokes `github.list_branches`. Expected: response returns within seconds, no operator prompt. Operator-side audit event `tool_invoked` carries `actor: peer:<son-handle>`, `source: matrix`, tier `AUTO`.

2. **CONFIRM read — operator prompted.** Son's CC: "read the README of Kstkoda/stavr." CC invokes `github.read_file`. Expected: son's CC blocks. Operator's dashboard `/dashboard/decide` (and Telegram, if wired) shows a decision request: `Approve github.read_file call (tier=CONFIRM, actor=peer:<son-handle>)?` with the args (repo + path) visible. Operator approves. Son's CC unblocks with the file content.

3. **Out-of-scope tool — structural deny.** Son's CC: "create a PR on Kstkoda/stavr that adds X." CC tries `github.create_pr`. Expected: immediate denial at the chokepoint with `per-actor NO_GO: actor "peer:<son-handle>" cannot invoke github.create_pr (source=default-deny)`. No operator prompt is created (default-deny is silent on the operator side; only the deny event lands in the audit log). Son's CC reports the denial reason.

4. **No-go floor — operator can't override.** Son's CC (or any actor): attempt one of the no-go-list entries (e.g., a no-go-list rooted hard-deny tool). Expected: chokepoint denies with `no-go floor: ...`. The operator-side audit event `no_go_match` lands.

5. **Token revocation kills access immediately.** Operator: `stavr devices revoke <device_id>`. Son's CC retries any tool. Expected: 401 at the transport, before the chokepoint runs. No new decisions open.

6. **Tier-3 EXPLICIT path (only if the son's matrix ever includes an EXPLICIT tool).** Currently the seed leaves nothing at EXPLICIT, so this is informational: an EXPLICIT call would first require a recent operator passkey assertion at `/dashboard/settings#identity` (60-second TTL) and THEN open a confirmation decision.

7. **Credential boundary.** Operator: verify the son's machine has no stavR tokens for the GitHub PAT. The son sees only the bearer for `helm.stavr.mesh`; the GitHub PAT lives in the operator's credential store and is never returned over the wire. (The chokepoint forwards calls server-side; the son's CC sees only tool responses, never credentials.)

### 4.5 — What "done" looks like

- The son's Claude Code, on his own machine, makes tool calls brokered through `helm.stavr.mesh:7777/mcp`.
- Every call passes through the 4-tier chokepoint; out-of-scope calls are denied with `default-deny` at the actor-permissions layer.
- CONFIRM-tier reads route an approval to the operator; the operator can see args (repo + path) and approve or reject per call. This is the per-resource gate today.
- No credential and no daemon ever lands on the son's machine. No CC worker processes are spawned for him.
- Verified by the two-machine smoke above, not CI alone.

### 4.6 — What's deliberately NOT included

- **No restriction of the son's NATIVE Claude Code tools (Bash, Write, Edit).** Per operator decision, native-tool fencing is out of scope. The son's CC runs his Bash and writes his own files with full native permissions; only the MCP layer is gateway'd.
- **No Phase 5 work** — the Anthropic-compatible LLM gateway endpoint (the son's `ANTHROPIC_BASE_URL` pointing at stavR, billing-metered per son) is a separate high-sensitivity BOM that needs its own operator go-ahead.
- **No per-resource (per-repo, per-path) scope fence at the chokepoint.** That is the Option B work in the recon doc. Today's per-resource gate is "tier CONFIRM + operator eyes per call" — operationally heavier but zero new code.

---

## Reference

- `proposed/family-son-mcp-onboarding-bom.md` — the BOM.
- `proposed/family-son-mcp-recon.md` — Phase 0 recon, esp. §2 (default-deny mechanic) and §6 (Option A rationale).
- `src/security/decision-gate.ts::buildChokepointGate` — the multi-layer gate the son's calls flow through.
- `src/security/actor-permissions.ts::resolve` — the default-deny logic.
- `src/transports.ts:526-536` — where `peer:<son-handle>` gets stamped onto the request.


