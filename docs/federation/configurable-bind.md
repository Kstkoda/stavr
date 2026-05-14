# Configurable bind + auth gate (spec 52 A1)

The stavr daemon binds to `127.0.0.1` by default. That posture — local-first, no
network exposure — is the safe path documented in ADR-006 and remains the default
out of the box. Spec 52 introduces "Mode 1 federation": one daemon on a home NAS,
paired devices (laptop, tablet) calling into it across a trusted network. To
enable that, the bind address has to be configurable. To prevent operators from
accidentally exposing the daemon to a network without authentication, every
non-loopback bind passes through an auth gate.

## Config file

Default location: `~/.stavr/stavr.yaml` (override with `$STAVR_HOME`). Missing
file ⇒ defaults apply.

```yaml
network:
  # Default; current behaviour (ADR-006). Binds 127.0.0.1, no auth required.
  bind: localhost

  # Bind to the first non-loopback IPv4 interface (machine-dependent).
  # bind: lan

  # Bind to the tailnet IP via tailscale (spec 52 A3 — not yet implemented).
  # bind: tailscale

  # Explicit host or host:port — known-trusted networks only.
  # bind: 192.168.1.10:7777
  # bind: 0.0.0.0

  # Refuse to start when `bind` is non-loopback and the pairing-token
  # subsystem (spec 52 A2) has not been configured. Defaults to true. Set
  # to false only if you've reasoned through what's at the other end of the
  # network you're binding.
  require_auth_when_non_local: true
```

The schema is enforced by Zod on every daemon start; type errors and unknown
shapes surface with `stavr config: invalid config in <path>` and a list of the
offending keys.

## The auth gate

Two conditions matter:

| `bind`       | `require_auth_when_non_local` | `authConfigured` | Daemon starts? |
|--------------|-------------------------------|------------------|----------------|
| `localhost`  | any                           | any              | ✅              |
| non-loopback | `true`                        | `false`          | ❌ refuses      |
| non-loopback | `true`                        | `true`           | ✅              |
| non-loopback | `false`                       | any              | ✅ (escape hatch) |

`authConfigured` is determined by the daemon at startup. In A1 it is always
`false` because the device-pairing token store (A2) does not yet exist. Once A2
lands, `authConfigured` becomes "there is at least one non-revoked row in the
`devices` table" — and the same gate carries forward unchanged.

On refusal the daemon prints, then exits with code 1:

> stavr daemon refusing to bind non-local without auth configured. Run
> `stavr pair --bootstrap` first or set `network.require_auth_when_non_local:
> false` if you know what you're doing.

The same check runs in two places:
1. **`stavr daemon start` CLI** — pre-flight before forking the detached child.
   This is the path that gives the operator a clean exit message.
2. **`mountTransports`** — defence in depth, in case a library consumer wires the
   transport layer directly without going through the CLI.

## CLI surface

```sh
# Inspect the effective config (no side effects).
stavr config show

# What would happen if I bound this?
stavr config show --bind-host 0.0.0.0
stavr config show --bind-host 0.0.0.0 --allow-non-local-without-auth

# Start the daemon with a one-off override (still runs through the gate).
stavr daemon start --bind-host lan
stavr daemon start --bind-host 192.168.1.10 --allow-non-local-without-auth
```

The output of `stavr config show` is a single JSON object:

```json
{
  "config_path": "/home/k/.stavr/stavr.yaml",
  "config_source": "defaults",
  "effective": {
    "network": { "bind": "0.0.0.0", "require_auth_when_non_local": true }
  },
  "resolved_bind": {
    "host": "0.0.0.0",
    "mode": "explicit",
    "is_loopback": false
  },
  "auth_gate": {
    "would_refuse": true,
    "reason": "stavr daemon refusing to bind non-local without auth configured. …"
  },
  "default_config_path": "/home/k/.stavr/stavr.yaml"
}
```

## I painted myself into a corner — how do I get back to localhost?

Three options, in order of preference:

1. **Edit `~/.stavr/stavr.yaml`** and set `network.bind: localhost`. The next
   `stavr daemon start` (or restart) honours it.
2. **Override on the command line**: `stavr daemon start --bind-host localhost`.
   This bypasses whatever is in the config file for this one invocation.
3. **Delete the config file**: `rm ~/.stavr/stavr.yaml`. Defaults apply
   (localhost + require_auth_when_non_local=true).

Note that the auth gate already prevents the "I bound 0.0.0.0 and now anyone on
the network is talking to me" scenario at start time — the daemon refuses to
come up. So a misconfigured config file fails closed, not open.

## Why not `0.0.0.0` by default?

Two reasons:
- **ADR-006** committed to local-first. Changing the default would silently
  expand the attack surface of every existing installation on upgrade.
- The dashboard and the MCP transport have no per-request authentication of
  their own. They rely on "the bind address is loopback and the kernel
  enforces that no one else can connect" as the security boundary. Once the
  bind is non-loopback that boundary moves to the pairing-token middleware
  (A2). Until A2 ships, a non-loopback bind is genuinely unsafe — hence the
  refusal, not a warning.

## What's next in spec 52

- **A2** — pairing-code authentication. Wires `authConfigured` to a real
  `devices` table and adds the `stavr pair` CLI.
- **A3** — tailscale transport adapter. Resolves `bind: tailscale` to the
  tailnet IP and shells `tailscale ip --4` to discover it.
- **A4** — self-signed cert fallback for operators who don't run tailscale.
