# Pairing-code authentication (spec 52 A2)

A1 made the bind address configurable but blocked non-loopback binds while
`authConfigured` was always false — there was no way to make it true. A2
provides the missing half: a 6-digit pairing-code flow that issues a device
token, persisted as SHA256 hashes on the daemon and as the raw token on the
remote device's disk (mode 0600).

## The flow

```
┌─────────────────────┐               ┌──────────────────────┐
│ NAS / daemon host   │               │ Remote device        │
│                     │               │ (laptop, tablet …)   │
│ stavr pair         │               │                      │
│   bootstrap         │   6-digit     │ stavr pair          │
│   (loopback only) ─►│   code  ───►  │   remote-host        │
│                     │  (operator    │   --code 123456      │
│                     │   reads it    │   --name laptop      │
│                     │   off screen) │                      │
│                     │               │                      │
│      ◄──────────────│  POST /pair/  │ ───────────►         │
│      (token issued, │  complete     │ (token saved to      │
│       devices row)  │               │  $STAVR_HOME/       │
│                     │               │  devices.json)       │
└─────────────────────┘               └──────────────────────┘
```

1. **Bootstrap** runs on the daemon host. `stavr pair bootstrap` POSTs to
   `/pair/initiate` over loopback (the daemon refuses this endpoint from
   non-loopback callers). The daemon generates a 6-digit code, registers it
   in an in-memory window with a 5-minute TTL, and returns it. The CLI prints
   the code plus a copy-pasteable command line for the device side.

2. **Remote-host** runs on the new device. The operator types in (or
   `--code`-passes) the 6-digit code along with a chosen device name and the
   daemon's URL. The device CLI POSTs to `/pair/complete`. On success it
   receives a 48-character hex token (192 bits) and writes
   `{ daemon_url, device_id, device_name, token, paired_at }` to
   `$STAVR_HOME/devices.json` with mode 0600.

3. **Authenticated requests**: the device attaches
   `Authorization: Bearer <token>` to every non-public request. The daemon's
   middleware looks the SHA256 hash up in the devices table (constant-time via
   crypto.timingSafeEqual) and refuses with 401 if it can't find an active row.

## The chicken-and-egg

You can't pair from a remote network until the daemon will accept connections
from a remote network — but the daemon refuses non-loopback binds without a
paired device. The bootstrap sequence is:

1. Start the daemon with the default `bind: localhost`.
2. From the same machine, run `stavr pair bootstrap` (loopback).
3. Read the 6-digit code off the screen, walk to the laptop / tablet.
4. On the device, run `stavr pair remote-host --daemon-url <addr> --code … --name …`.
   Even though the daemon is loopback-only right now, the operator types in
   the daemon's intended remote URL — but actually they have to reach it
   over the network, which still doesn't work because the daemon hasn't
   moved to non-loopback yet. **Step 4 happens AFTER step 5.**
5. Stop the daemon. Edit `~/.stavr/stavr.yaml` to set `network.bind: lan`
   (or `tailscale` once A3 lands). Restart the daemon. Now the gate opens
   automatically because `authConfigured = true` (devices table has a row).
6. Now run `stavr pair remote-host …` on the device, against the daemon's
   LAN/tailnet URL. Token issued, persisted, ready to authenticate.

Yes, this is awkward. A3/A4 (tailscale and self-signed cert) make the network
step less manual, but the inherent "must pair from loopback first" pattern is
intentional — it ensures someone with physical access to the daemon machine is
the only entity that can open a pairing window.

## CLI surface

```sh
# On the daemon side (loopback only)
stavr pair bootstrap
# Output:
#  {
#    "ok": true,
#    "code": "381207",
#    "expires_at": "2026-05-13T01:05:00.000Z",
#    "instructions": "Run `stavr pair remote-host --daemon-url <addr> --code 381207 --name <device-name>` on the new device."
#  }

# On the new device
stavr pair remote-host \
  --daemon-url http://nas.local:7777 \
  --code 381207 \
  --name kenneth-laptop

# Auditing paired devices
stavr devices list                  # active only
stavr devices list --include-revoked
stavr devices show <id>
stavr devices revoke <id>
```

## Security model

| What we protect against                       | How                                       |
|-----------------------------------------------|-------------------------------------------|
| Random network probe → reaches MCP transport  | Bearer-token middleware refuses w/ 401    |
| Long-lived token leak → permanent access      | `stavr devices revoke <id>` flips active |
| Pairing window leak → attacker pairs first    | 5-min TTL + 6-digit code + loopback-only initiate |
| Token brute-force via timing                  | `crypto.timingSafeEqual` on the SHA256 hash |
| Token brute-force via search                  | 192 bits of entropy in the token         |
| Operator-side credential theft (token on disk) | File mode 0600 on POSIX. **Keytar integration is a follow-up** — the file fallback is the current always-works path. |

What we explicitly DON'T protect against:
- An attacker on the same LAN who has compromised one of your paired devices.
- An attacker with physical access to the daemon machine (they can open a
  new pairing window via `stavr pair bootstrap` themselves).
- An attacker who has read the device's `devices.json` file. Mitigations:
  per-user home directory permissions; keytar follow-up; document
  full-disk encryption as part of the threat model in A8.

## Wire format

`POST /pair/initiate` (loopback only, no body)
```json
{ "ok": true, "code": "381207", "expires_at": "2026-05-13T01:05:00Z" }
```

`POST /pair/complete`
```json
// request
{ "code": "381207", "device_name": "kenneth-laptop" }
// response
{
  "ok": true,
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "device_name": "kenneth-laptop",
  "paired_at": "2026-05-13T01:00:30.123Z",
  "token": "0a1b2c3d…"   // 48 hex chars, returned exactly once
}
// failure (always this exact body — never reveals whether the slot exists)
{ "ok": false, "error": "invalid_code" }
```

`Authorization: Bearer <token>` on every non-public request once
`authConfigured` is true. Public endpoints (no auth required): `/healthz`,
`/pair/complete`, `/pair/initiate`.

## What's next

- **A3** — tailscale transport adapter. `bind: tailscale` auto-detects the
  tailnet IP. Combined with A2's token, the security model becomes
  "tailnet ACL + pairing token".
- **A4** — self-signed cert fallback for operators who can't use tailscale.
  Devices pin the fingerprint at pair time.
- **Keytar integration** — replace the file fallback for token storage.
  Tracked as a follow-up issue, not in A2.
