# bombardment/chaos — Phase 4 destructive chaos overlays

Phase 4 of the bombardment rig — fault injection on top of the Phase 3
docker-compose federation topology. The work here is **destructive**
(mutates container state, kills processes, partitions networks,
corrupts data on disk). The fault-injection sidecars live in a separate
compose overlay (`bombardment/compose/chaos.yml`); the in-container
helper scripts are bind-mounted read-only on the base topology but are
inert unless invoked via `docker exec`, so the base topology stays
usable for the read-only oracle layer.

## Sub-phases

### Phase 4a — container kill

- **Overlay:** `bombardment/compose/chaos.yml` (Pumba kill sidecar).
  The in-container helpers are bind-mounted by the base compose — see
  "In-container helpers — how they get in" below.
- **Runner:** `run-kill-slice.mjs` — coordinates the kill cycle and
  invokes the recovery oracle.
- **Oracle:** `oracles/kill-recovery.mjs` — asserts two invariants on
  one kill cycle:
  1. Docker's `restart: unless-stopped` policy brings the container
     back, and `/healthz` returns 200 within the budget. The container's
     `RestartCount` must also increment relative to a pre-kill snapshot
     (positive proof the policy fired).
  2. An in-flight decision (pre-seeded with a past `expires_at`) is
     swept by `startupDecisionSweep` on the daemon's restart, producing
     a `decision_late_response` event.

  A third invariant — an SSE consumer reconnecting with `?since_id=`
  across the kill — was specified originally but dropped on 2026-05-25
  (see `proposed/bombardment-chaos-debug-bom.md` "Decision (locked)"):
  the SSE endpoint is loopback-gated, so no consumer can be both
  loopback to the daemon AND survive a SIGKILL of the daemon's
  container. The since_id replay logic is already covered in-process by
  `tests/chaos.test.ts`; the across-a-container-kill wrapper adds no
  coverage and is impossible by topology.

### Phase 4b — network chaos

- **Overlay:** `bombardment/compose/netchaos.yml` — heavier impairment
  than Phase 3c's `pumba.yml`: a one-sided partition between sites, a
  500ms latency spike, 10% packet loss.
- **Runner:** `run-netchaos-slice.mjs` — applies the overlay, re-runs
  the Phase 3d federation oracles under the heavier budget, tears down.

### Phase 4c — projection corruption + rebuild-from-log

- **Runner:** `run-projection-corruption.mjs` — coordinates the
  corruption + rebuild cycle on a single peer.
- **In-container helpers:**
  - `in-container/corrupt-projection.mjs` — flips `decisions.status`
    out of band on a known correlation_id (no event written; the log
    stays clean).
  - `in-container/replay-projection.mjs` — replays the `events` table
    into a fresh in-memory `decisions` table and compares it against
    the live (corrupted) projection; mismatches are the oracle's
    failure surface.
- **What this proves:** the event log is the source of truth and the
  projection is derivable from it. The daemon does not (yet) ship a
  `rebuildProjectionFromLog()` function — Phase 4c demonstrates the
  rebuild path from the rig side (which is what an operator-side
  recovery tool would do); the daemon-side rebuild is a separate
  cycle's deliverable.

## In-container helpers — how they get in

The base compose file bind-mounts `bombardment/chaos/in-container/`
read-only at `/app/bombardment-chaos/` on every peer container. The
helpers are JavaScript modules invoked via
`docker exec stavr-peer-a node /app/bombardment-chaos/<helper>.mjs ...`
from the runner scripts. They use the daemon's bundled
`better-sqlite3` to open `${STAVR_HOME}/runestone.db` directly — same
DB the daemon writes to — and either insert a fixture row (seed) or
read it back (verify). They never modify daemon code paths.

## Why Pumba for some, `docker kill` for others

The Phase 3c `pumba.yml` (netem latency / loss) uses Pumba in compose
mode because the impairment runs for a fixed duration alongside the
oracles. For container kill the runner needs deterministic timing
(seed → kill → wait for restart → assert), which Pumba's
schedule-and-detach model fights; the runner therefore drives
`docker kill` directly (matches the pattern in `peer-unreachable-recovery`
which uses `docker pause` for the same reason). The Pumba kill sidecar
in `chaos.yml` is available for the operator-driven path; runners
prefer the direct invocation.
