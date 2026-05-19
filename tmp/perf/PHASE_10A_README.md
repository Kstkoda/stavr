# Phase 10a verification — two-instance federation smoke

> Autonomous verification artifacts for v0.7 federation foundation
> (PR β). The 90-min sustained load (Phase 10b) is operator-supervised
> and runs separately — this is just the smoke + the spin scripts.

## What's in here

| File | Purpose |
|---|---|
| `peer-smoke.mjs` | Two-process daemon smoke. Spawns peer-a + peer-b, waits for /healthz, asserts mutual federation visibility + dashboard renders + auth endpoints. Self-contained — no manual setup. |
| `spin-peer.ps1` | Manual single-peer launcher. Use when you want a second daemon running interactively (e.g., to drive the family-mode page from a browser). |
| `peer-smoke-artifacts/` | Output: per-instance home dirs + `peer-smoke-summary.json` (created by peer-smoke.mjs). |

## Running the smoke

```powershell
# Build first
npm run build

# Run smoke (~60s observation window by default)
node tmp/perf/peer-smoke.mjs

# Tighter window for fast feedback
node tmp/perf/peer-smoke.mjs --observation-seconds 15

# Verbose daemon stdout/stderr
$env:SMOKE_VERBOSE = 1
node tmp/perf/peer-smoke.mjs
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every assert passed |
| 1 | At least one assert failed (see `peer-smoke-summary.json`) |
| 2 | Setup failed (port in use, daemon failed to start, missing dist) |

## What the smoke verifies

1. Two daemon instances boot cleanly on different ports + with different
   `STAVR_HOME` dirs.
2. Both `/healthz` endpoints reach `ok` within 30 seconds.
3. After a settling period, each instance's `/api/federation/peers` shows
   the other instance in the list. Mutual visibility within the
   observation window (default 60s).
4. `/api/federation/health` on each side returns the expected
   `{peer_id, protocol_version}` shape.
5. `/dashboard/family-mode` renders + contains the table heading.
6. `/dashboard/about` renders + carries the Raido rune entity.
7. `/api/auth/credentials` responds 200 with an empty list initially.
8. `/api/auth/tier3/recent` returns `has_recent: false` before any
   assertion is recorded.

## What's deferred to Phase 10b (operator-supervised)

- **90-minute sustained load.** Wall-clock real time; not parallelizable.
  Run separately with `tmp/perf/load-runner.mjs --minutes 90` against the
  smoke setup left running (or against a single daemon for the
  v0.6.11-style memory-leak regression).
- **Real WebAuthn ceremonies.** The `/api/auth/*` endpoints respond
  correctly, but completing a registration or assertion requires a real
  authenticator (Windows Hello, YubiKey, etc.) — must be a human in a
  browser.
- **Cross-LAN host federation.** Same-process two-port is the autonomous
  surrogate; true multi-machine validation needs Kenneth + sons running
  the actual deployment per `docs/family-mode.md`.

## Manual repro of a single peer

If you want a second daemon running so you can poke at it from a
browser without the smoke harness tearing it down:

```powershell
.\tmp\perf\spin-peer.ps1 -Port 7778 -PeerId peer-b

# Then visit
#   http://localhost:7778/dashboard/family-mode
#   http://localhost:7778/api/federation/health
```

The script seeds a minimal `peers.yaml` at `tmp\perf\peer-spin-<id>\`
so the peer knows its own id even without operator editing. Add other
peers manually to that file if you want to test peer discovery against
your main daemon on 7777.
