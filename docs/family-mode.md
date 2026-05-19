# Family mode — multi-machine stavR setup

> stavR is normally a single-machine personal gateway. **Family mode** is the
> name for running it across two or more machines on the same network so
> they can find each other, share work, and audit each other's actions.

This is the operator-facing setup guide. It's written for someone who can
edit a YAML file and run a daemon — but who doesn't necessarily know what
mDNS is, what an Ed25519 key is, or how WebAuthn handshakes work. We'll
explain those as they come up.

> **Audience and scope.** Family mode v0.7 is LAN-only. You and your family
> members all need to be on the same Wi-Fi (or wired LAN). Internet-side
> peering — your laptop in a cafe talking to your home desktop — is on the
> v1.0 roadmap and requires WebRTC, which we [intentionally deferred][findings]
> for v0.7.
>
> [findings]: ../proposed/v0_7-federation-findings.md

---

## What you need before you start

For each machine that will join the federation:

1. **Node 20 or newer** — `node --version` should print v20.x or higher.
2. **stavR installed** — clone the repo, `npm install`, `npm run build`.
3. **A WebAuthn-capable browser + authenticator** — Chrome, Edge, Firefox
   (recent), or Safari (recent). Windows Hello, Touch ID, or a YubiKey
   all work for the operator-identity passkey. The passkey is what gates
   high-trust ("Tier 3 EXPLICIT") actions, so each operator on each
   machine should register at least one.
4. **Network reachability** — every machine should be able to ping every
   other machine by hostname (e.g., `kenneth-laptop.local`). On Windows,
   Bonjour comes with iTunes or can be installed via Apple's [Bonjour Print
   Services for Windows][bonjour-win]; on Linux/macOS it's typically already
   running.
5. **Firewall** — multicast UDP on port 5353 (mDNS) must be allowed. If
   the family-mode page on `/dashboard/family-mode` shows no peers but
   `peers.yaml` is configured, this is the first thing to check.

[bonjour-win]: https://support.apple.com/kb/dl999

---

## Worked example: Kenneth + 2 sons

**Setup:** Kenneth has a Windows desktop. His sons each have an RTX 4080
Super gaming rig also on Windows. All three machines are on the same home
Wi-Fi.

**Goal:** Each machine runs stavR. Kenneth dispatches BOMs from his
desktop (he becomes the **Originator**). When a BOM mentions "use the
4080 Super for local generation", his stavR routes that step to whichever
son's machine has free GPU (they become **Participants**). The
**Convener** (the machine hosting the decision log) is usually the
Originator, but doesn't have to be.

### Step 1 — Install stavR on every machine

On each machine:

```powershell
git clone https://github.com/Kstkoda/stavr.git
cd stavr
npm install
npm run build
```

That's the same for all three machines. Nothing federation-specific yet.

### Step 2 — Pick peer IDs

Each machine needs a stable identifier other machines will refer to it by.
Use something simple — your-firstname or your-machine-nickname is fine.
Lowercase, alphanumeric, dashes / underscores only.

Kenneth's plan:

| Machine            | Peer ID            |
|--------------------|--------------------|
| Kenneth's desktop  | `kenneth-desktop`  |
| Son 1's rig        | `son1-rig`         |
| Son 2's rig        | `son2-rig`         |

### Step 3 — Write the peers.yaml file

On **each** machine, create `~/.stavr/peers.yaml` (Windows:
`C:\Users\<you>\.stavr\peers.yaml`). The file declares this machine's
self-id and lists the peers this machine affirmatively trusts.

Kenneth's `~/.stavr/peers.yaml`:

```yaml
self_id: kenneth-desktop
self_display_name: Kenneth Desktop

peers:
  - id: son1-rig
    display_name: Son 1's Rig
    hostname: son1-rig.local
    port: 7777
    trust: verified
    notes: 'paired 2026-05-19 in person'

  - id: son2-rig
    display_name: Son 2's Rig
    hostname: son2-rig.local
    port: 7777
    trust: verified
    notes: 'paired 2026-05-19 in person'
```

On **Son 1's** machine, `~/.stavr/peers.yaml`:

```yaml
self_id: son1-rig
self_display_name: Son 1's Rig

peers:
  - id: kenneth-desktop
    display_name: Kenneth Desktop
    hostname: kenneth-desktop.local
    port: 7777
    trust: local-equivalent   # son1 treats dad's machine as fully trusted
    notes: 'dad'

  - id: son2-rig
    display_name: Son 2's Rig
    hostname: son2-rig.local
    port: 7777
    trust: verified
```

Son 2's file mirrors this with his own self_id.

#### Trust levels — what they mean

| Trust level         | Meaning                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `local-equivalent`  | Peer's actions count as the operator's own. Use sparingly.              |
| `verified`          | Paired peer; cross-peer Tier 3 actions need the originator's passkey.   |
| `untrusted`         | Discovered but not paired. mDNS sees it; events do NOT flow.            |

For a family deployment, `verified` is the right default. Use
`local-equivalent` only for your own machines (e.g., your laptop + your
desktop), never for someone else's machine.

### Step 4 — Start the daemons

On each machine:

```powershell
pm2 start ecosystem.config.cjs
pm2 logs stavr -f
```

Watch the logs for `mDNS coordinator started` and `federation: peers.yaml
loaded`.

Open `http://localhost:7777/dashboard/family-mode` on each machine. Within
~5 seconds you should see the other two peers appear in the table, with
state pills going from `Discovered` to `Online`.

### Step 5 — Register passkeys

On each machine, visit `http://localhost:7777/dashboard/settings#identity`.
Click "Register passkey", complete the WebAuthn ceremony (Windows Hello,
Touch ID, or YubiKey — whatever the browser offers). You'll see the
credential appear in the list.

Each operator on each machine should register at least one passkey. The
passkey is what gates Tier 3 EXPLICIT actions — high-trust cross-peer
operations like "let dad's machine use a worker on son1's machine."

---

## Troubleshooting

### "No peers appear on the family-mode page"

Walk down the list:

1. **All three daemons running?** `pm2 list` on each machine. `stavr`
   process should be `online`.
2. **Same network?** Try `ping son1-rig.local` from Kenneth's machine. If
   that fails, Bonjour/mDNS isn't resolving — install Bonjour Print
   Services for Windows or check the firewall.
3. **Multicast allowed?** Windows Defender Firewall may block mDNS
   (UDP/5353). Allow Node.js through the firewall, or add a rule for
   port 5353/UDP.
4. **WSL?** mDNS does NOT work cleanly from inside WSL. Run stavR from
   PowerShell directly, not from WSL bash.
5. **VLAN / guest network?** Some routers isolate guest networks from
   the main LAN. Move every machine to the same network.

### "I see the peer but state stays Degraded"

The peer is reachable via mDNS but stavR can't HTTP-ping it. Check:

1. Is the daemon HTTP port (7777) reachable from this machine? `curl
   http://<peer-hostname>.local:7777/api/federation/health` should
   return JSON.
2. Is the firewall blocking inbound TCP/7777 on the peer? Allow Node.js.
3. Did you change the port in one peer's config? Update the others'
   `peers.yaml` to match.

### "Passkey registration fails"

The most common cause is the WebAuthn RP id mismatch. By default stavR
uses `localhost` as the RP id, which works when you visit
`http://localhost:7777/...`. If you're accessing the dashboard via the
peer's hostname (`http://kenneth-desktop.local:7777/...`), set:

```powershell
$env:STAVR_WEBAUTHN_RP_ID = "kenneth-desktop.local"
$env:STAVR_WEBAUTHN_ORIGINS = "http://kenneth-desktop.local:7777,http://localhost:7777"
pm2 restart stavr --update-env
```

(Same idea on macOS/Linux with `export`.)

### "Force originator handoff" — when do I need that?

You don't, in v0.7. The button on the family-mode page is a placeholder;
the actual handoff machinery ships in v0.7.1. For now, the originator
role attaches to whichever machine you typed the BOM into; switching
mid-task means re-issuing the BOM on the other machine.

---

## What v0.7 ships vs what's coming

**In v0.7 (this release):**

- mDNS auto-discovery on the same LAN.
- peers.yaml as the trust root.
- Plain HTTP between peers (loopback-friendly, no TLS yet).
- WebAuthn passkey for the operator identity primitive.
- Federation role types (Originator / Participant / Convener) in the
  broker event surface.
- Per-peer Tier 3 EXPLICIT gate helper (`requireRecentTier3Assertion`).
- Family-mode + About dashboard pages.

**Coming in v0.7.1:**

- Cross-peer event mirroring (Participant role enforcement).
- Worker spawner protocol wired into a federated dispatch.
- Force originator handoff action.
- host_exec EXPLICIT gating via passkey OR typed friction string
  (passkey proves presence; friction proves target — they're
  complementary, per [Phase 0 findings §B][findings]).

**Coming in v1.0:**

- WebRTC peer-to-peer + STUN/TURN NAT traversal — internet peering.
- BIP32-Ed25519 federation key derivation (Decision 3 Option B).
- Topology page actor-nodes + flow particles (Decision 4).

---

## Reference

- [ADR-042][adr-042] — the five locked design decisions.
- [ADR-034 §B][adr-034] — family-scale positioning.
- [Phase 0 findings][findings] — why WebRTC is deferred + scope
  reconciliation details.
- `~/.stavr/peers.yaml` — your trust root. Edit it, then trigger
  "Reload peer config" from `/dashboard/settings`.

[adr-042]: ../adr/042-federation-roles-discovery-operator-identity-flow-viz-worker-spawner.md
[adr-034]: ../adr/034-personal-mcp-gateway-positioning.md
[findings]: ../proposed/v0_7-federation-findings.md
