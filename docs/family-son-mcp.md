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
Run `stavr pair --bootstrap` first or set `network.require_auth_when_non_local: false`
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

<!-- Phase 3 and Phase 4 appended in subsequent commits. -->
