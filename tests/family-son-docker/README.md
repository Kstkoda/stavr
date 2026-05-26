# family-son-mcp — Docker-substrate test rig

End-to-end exercise of the family-son-mcp onboarding runbook
(`docs/family-son-mcp.md` Phases 2–4) over a containerized non-loopback
hop. Two containers on a Docker bridge network: `stavr-operator` plays
the operator's daemon, `son-client` plays the son's thin MCP client.
The Docker network IS the non-loopback hop (different IP, different
netns, no shortcut to 127.0.0.1).

For the test plan + acceptance criteria, see
`proposed/family-son-mcp-docker-test-bom.md`. For the substrate
inventory the BOM was built on, see
`proposed/family-son-mcp-docker-test-recon.md` — especially the
addendum on the `authConfigured → bearer-middleware install` coupling
that drove this substrate's shape.

## 1 — Bring it up (Phase 1)

From the repo root:

```sh
# Image precondition — uses the same image the bombardment rig builds.
docker build -t stavr:ci -f Dockerfile .

# Up. No host ports published.
docker compose -f tests/family-son-docker/docker-compose.yml up -d

# Tail logs (Ctrl-C to detach, containers keep running):
docker compose -f tests/family-son-docker/docker-compose.yml logs -f

# Tear down (and wipe the named volume so the next run starts clean):
docker compose -f tests/family-son-docker/docker-compose.yml down -v
```

Phase 1's only verification is the daemon's loopback `/healthz` from
**inside** the operator container — the daemon binds `localhost` (per
`operator/stavr.yaml`) so it isn't reachable over the Docker network
yet:

```sh
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator curl -fsS http://127.0.0.1:7777/healthz
# expect: 200 with body `{"ok":true, ...}`
```

The son-client → stavr-operator Docker-network hop check is **deferred
to Phase 2** — after the bootstrap-pair flips `authConfigured=true` and
the operator edits `stavr.yaml` to `bind: '0.0.0.0'` and restarts.

## 2 — Why bind=localhost in Phase 1 (the substrate shape)

The daemon's request-time bearer-auth middleware is installed
**conditionally at boot time** (`src/transports.ts:492`):

```ts
const requireBearer = !!opts.authConfigured && !isLoopback;
if (requireBearer) {
  app.use(/* checkBearerAuth */);
}
```

When `authConfigured=false` (zero paired devices) the middleware is
never registered — `/mcp` would be open to any caller, loopback or
not. So a brand-new daemon CANNOT safely listen on a non-loopback
interface; it must boot loopback, pair at least one device, and then
flip the bind. That is exactly the runbook §2.5 bootstrap-from-loopback
dance the BOM exists to test.

Two knobs that *look* like they'd let us shortcut this — `STAVR_ALLOW_
NON_LOCAL_WITHOUT_AUTH=1` on the rig entrypoint, and
`network.require_auth_when_non_local: false` in `stavr.yaml` — both
have the same material effect: they relax the startup safety gate, but
because the bearer middleware only mounts when `authConfigured=true`,
the result is a wide-open daemon. The BOM (hard invariant #1) bans
the first by name; the recon doc addendum documents why the second is
equivalent and equally banned.

The Phase 2 dance is the **only** clean path to a non-loopback bind
under "auth ON."

## 3 — Phase 2: bootstrap pair on loopback, flip bind, real pair over the wire

The full sequence (driven by the Phase 2 deliverable script
`scripts/pair.sh`, added when Phase 2 lands):

```sh
# 2a — Bootstrap pair on loopback (inside the operator container).
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator node /app/dist/cli.js pair bootstrap
# captures a 6-digit code from the JSON output

docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator curl -sS -X POST \
    http://127.0.0.1:7777/pair/complete \
    -H 'Content-Type: application/json' \
    -d '{"code":"<6-digit>","device_name":"bootstrap"}'
# captures the bootstrap bearer (we discard it — it's only needed to
# flip authConfigured=true)

# 2b — Flip bind. Edit operator/stavr.yaml on the host:
#    network:
#      bind: '0.0.0.0'        # was 'localhost'
#      require_auth_when_non_local: true
# Then restart the daemon:
docker compose -f tests/family-son-docker/docker-compose.yml \
  restart stavr-operator
# Wait for healthy. The bearer middleware now mounts (authConfigured=true,
# bind non-loopback). Startup bind-auth gate accepts the bind because
# the bootstrap device exists.

# 2c — Deferred Phase 1 reachability check: son-client → operator over
#      the Docker network.
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec son-client curl -fsS http://stavr-operator:7777/healthz
# expect: 200

# 2d — Real pairing: operator opens a new pair window, son-client
#      hits /pair/complete over the network. Captures the son's bearer
#      for Phase 3 / 4.
```

The bootstrap device is intentional bycatch — Phase 2's `stavr devices
list` will show two rows (`bootstrap` + the son's handle). Phase 4e's
revoke targets the son's device id specifically; the bootstrap device
stays paired throughout.

## 4 — Why no `ports:` published

The auth-on daemon must not be reachable at `localhost:7777` on the
Windows host running Docker Desktop. Test traffic to the daemon goes
exclusively through the `son-client` container on the Docker bridge,
which is the actual hop the BOM is testing. Publishing 7777 would also
collide with any locally-installed stavR daemon listening on the same
port.

## 5 — Driving the containers (cheat sheet)

```sh
# Operator-side commands inside the stavr-operator container
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator node /app/dist/cli.js <subcommand>

# Son-side curl probes from the son-client container
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec son-client curl -fsS http://stavr-operator:7777/healthz

# Operator-loopback dashboard / decisions API (inside the operator
# container, since /dashboard/* enforces loopback-only at the path
# fence and respond verifies the caller is on loopback)
docker compose -f tests/family-son-docker/docker-compose.yml \
  exec stavr-operator curl -sS http://127.0.0.1:7777/dashboard/decisions?status=open
```

The rig's stock entrypoint (`bombardment/docker/entrypoint.sh`) is
**overridden** by `operator/init.sh` — see §6 below for why.

## 6 — What goes where

| Path | Purpose |
|---|---|
| `docker-compose.yml` | The two services + network + volume + custom entrypoint override. |
| `operator/stavr.yaml` | Daemon config mounted read-only into the operator container. Bind starts `localhost`; operator edits to `0.0.0.0` between Phase 1 and Phase 2c. Single source of truth for `network.bind`. |
| `operator/init.sh` | Custom entrypoint — runs `daemon start` **without** `--bind-host` so the yaml drives bind across the reconfigure. The stock entrypoint always passes `--bind-host` from `STAVR_BIND_HOST` (default `0.0.0.0`), which would override the yaml. |
| `README.md` | This file. |
| `scripts/` | Phase 2/3/4 drive scripts (added in those phases). |
| `SMOKE-RESULTS.md` | Phase 4 capture file (added in Phase 4). |
