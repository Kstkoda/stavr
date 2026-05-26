// Bombardment Phase 3d — peer-state convergence oracle.
//
// The daemon's PeerClient probes each configured peer on a ~60s
// setInterval; peer-registry.ts `recordPingResult` flips a peer
// online <-> degraded on every probe, with NO miss threshold. Peer
// `state` is therefore a fast-moving, event-driven value — a single
// instantaneous `state === 'online'` snapshot is hostage to catching
// the exact instant between probe ticks. It false-positives two ways:
// a slow first probe on a contended CI runner (clean runs), and a
// lost probe (chaos runs, deliberate packet loss).
//
// So this oracle POLLS rather than snapshots. Over a bounded window it
// repeatedly reads every viewer's /api/federation/peers and asserts:
//
//   - every peer that SHOULD be reachable (shares a Docker network
//     with the viewer) is observed in a CONVERGED state AT LEAST ONCE.
//     Converged = `online`, OR `degraded` under
//     STAVR_BOMBARDMENT_UNDER_CHAOS provided `last_seen_at` is FRESH
//     (within LAST_SEEN_FRESHNESS_MS, default 2× probe interval). A
//     clean probe always succeeds → state is `online`; under chaos,
//     even one lost probe flips the cached state online → degraded
//     (peer-registry.ts:155 — no miss threshold), and the next polling
//     window may catch the daemon in that degraded gap rather than at
//     the next `online` tick. Accept it under chaos: `degraded` reached
//     from a recent successful ping proves the PeerClient loop ran and
//     `recordPingResult` flowed into the registry — which is the actual
//     liveness signal this oracle is looking for.
//
//     The freshness gate is load-bearing: multi-homed peers (the hub
//     joins both site_a and site_b networks) expose multiple IPs in
//     mDNS and the order is non-deterministic. If the peer-client's
//     walk-candidates path regresses, or a real network change makes a
//     previously-routable address unreachable, every PeerClient probe
//     times out (3000ms), the peer flips online→degraded on the first
//     probe, and STAYS degraded forever with `last_seen_at` frozen —
//     silent non-convergence. Without the gate, the chaos tolerance
//     ACCEPTS this stuck state. The gate rejects any `degraded` whose
//     last successful ping is older than the freshness window, surfacing
//     the regression instead of masking it.
//
//     The original tolerance was added in 8949c5b, dropped by the
//     polling rewrite (c45b536) on the theory that the window would
//     always catch an `online` tick, restored in 203b947 (oracle was
//     blocking on the very flake the BOM was meant to diagnose), and
//     freshness-gated here. Non-chaos runs keep the strict
//     `online`-only assertion.
//   - no cross-subnet peer is EVER observed `online` across the whole
//     window — the federation safety invariant, strictly stronger than
//     a single-instant check. This stays strict even under chaos.
//
// It exits early the moment every reachable peer has converged (the
// common case — convergence is usually already done after run-oracles'
// pre-wait, so this costs one poll), and bails fast if no viewer is
// reachable at all (nothing to wait for — also what keeps the vitest
// graceful-failure test against non-listening ports fast).
//
// What this catches:
//   - PeerClient never started / `recordPingResult` not flowing — no
//     reachable peer ever reaches `online`.
//   - A regression that promotes cross-network peers to `online`.
//
// Reachability is computed from the topology descriptor —
// `reachableFrom(viewerId)` returns the set of peer IDs the viewer
// shares a Docker network with.

import { setTimeout as sleep } from 'node:timers/promises';
import { getJson } from '../http-probe.mjs';
import { TOPOLOGY, reachableFrom } from '../topology.mjs';

// Chaos runs need a longer window: under continuous packet loss a peer
// is only seen `online` on a successful probe, and probes are ~60s
// apart. Clean runs converge on the first probe. Override with
// STAVR_BOMBARDMENT_CONVERGENCE_POLL_MS.
const UNDER_CHAOS = process.env.STAVR_BOMBARDMENT_UNDER_CHAOS === '1';
const POLL_DEADLINE_MS = Number(
  process.env.STAVR_BOMBARDMENT_CONVERGENCE_POLL_MS ?? (UNDER_CHAOS ? 180_000 : 90_000),
);
const POLL_INTERVAL_MS = 3_000;
// Max age of `last_seen_at` for a degraded reachable pair to count as
// converged under chaos. 2× the daemon's 60s probe interval — one
// missed probe is the transient the tolerance exists for, two missed
// probes in a row is a stuck state worth surfacing as a violation.
// Override with STAVR_BOMBARDMENT_LAST_SEEN_FRESHNESS_MS.
const LAST_SEEN_FRESHNESS_MS = Number(
  process.env.STAVR_BOMBARDMENT_LAST_SEEN_FRESHNESS_MS ?? 120_000,
);

export async function peerStateConvergence() {
  const start = Date.now();

  // One record per ordered (viewer, candidate) pair.
  const pairs = [];
  for (const viewer of TOPOLOGY.peers) {
    const reachableIds = reachableFrom(viewer.id);
    for (const candidate of TOPOLOGY.peers) {
      if (candidate.id === viewer.id) continue;
      pairs.push({
        viewer: viewer.id,
        candidate: candidate.id,
        expectReachable: reachableIds.has(candidate.id),
        everConverged: false, // reachable peer seen in a converged state >= once
        everUnexpectedOnline: false, // cross-subnet peer seen `online` (a breach)
        lastState: 'missing',
        lastSeenAt: 0, // most recent peer.last_seen_at observed across polls
      });
    }
  }

  // Per-viewer: did /api/federation/peers ever answer? A viewer that
  // answers at least once is fine even if a later poll blips; a viewer
  // that NEVER answers is a fetch_failed violation.
  const fetchedOk = new Map(TOPOLOGY.peers.map((p) => [p.id, false]));
  const lastFetchError = new Map();

  const deadline = start + POLL_DEADLINE_MS;
  let polls = 0;

  while (true) {
    polls += 1;
    for (const viewer of TOPOLOGY.peers) {
      let body;
      try {
        const r = await getJson(`${viewer.baseUrl}/api/federation/peers`);
        body = r.body;
        fetchedOk.set(viewer.id, true);
        lastFetchError.delete(viewer.id);
      } catch (err) {
        lastFetchError.set(viewer.id, err.message);
        continue;
      }
      const peerById = new Map((body?.peers ?? []).map((p) => [p.id, p]));
      const now = Date.now();
      for (const pair of pairs) {
        if (pair.viewer !== viewer.id) continue;
        const peerRow = peerById.get(pair.candidate);
        const state = peerRow?.state ?? 'missing';
        pair.lastState = state;
        if (typeof peerRow?.last_seen_at === 'number' && peerRow.last_seen_at > pair.lastSeenAt) {
          pair.lastSeenAt = peerRow.last_seen_at;
        }
        if (state === 'online') {
          if (pair.expectReachable) pair.everConverged = true;
          else pair.everUnexpectedOnline = true;
        } else if (state === 'degraded' && UNDER_CHAOS && pair.expectReachable) {
          // Under chaos, `degraded` only counts as converged if the
          // last successful ping is recent. Otherwise the peer is
          // stuck-degraded — see header for the peer-client multi-
          // homed-address bug this gate exists to surface.
          const ageMs = pair.lastSeenAt > 0 ? now - pair.lastSeenAt : Infinity;
          if (ageMs >= 0 && ageMs <= LAST_SEEN_FRESHNESS_MS) pair.everConverged = true;
        }
      }
    }

    // Converged: every reachable pair has been seen in a converged
    // state at least once AND is not currently stuck-degraded. The
    // second condition prevents the loop from exiting early under chaos
    // when a pair earned everConverged via a fresh-degraded reading but
    // then became stale — the oracle must keep polling until the pair
    // reaches `online` or the deadline expires so F1b can fire.
    const converged = pairs.every((p) => {
      if (!p.expectReachable) return true;
      if (!p.everConverged) return false;
      if (UNDER_CHAOS && p.lastState === 'degraded') return false;
      return true;
    });
    if (converged) break;

    // Bail fast if nothing is listening at all — no amount of waiting
    // brings up a topology that isn't there.
    const anyFetchEver = [...fetchedOk.values()].some(Boolean);
    if (!anyFetchEver) break;

    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const violations = [];
  const finalNow = Date.now();
  for (const p of pairs) {
    if (p.expectReachable && !p.everConverged) {
      // Distinguish the stuck-degraded case (PeerClient is misrouted,
      // pings stale) from the never-reached case (no probes at all).
      // Under chaos, a degraded pair with a stale last_seen_at is the
      // peer-client multi-homed-address bug; reported as its own kind
      // so triage doesn't conflate it with a true unreachability.
      const isStuckDegraded =
        UNDER_CHAOS && p.lastState === 'degraded' && p.lastSeenAt > 0;
      const ageMs = p.lastSeenAt > 0 ? finalNow - p.lastSeenAt : null;
      const violation = {
        viewer: p.viewer,
        candidate: p.candidate,
        kind: isStuckDegraded
          ? 'expected_converged_but_stale_last_seen'
          : UNDER_CHAOS
            ? 'expected_converged_but_not'
            : 'expected_online_but_not',
        last_state: p.lastState,
      };
      if (ageMs !== null) violation.age_ms = ageMs;
      if (isStuckDegraded) violation.freshness_threshold_ms = LAST_SEEN_FRESHNESS_MS;
      violations.push(violation);
    }
    // Under chaos: a pair that earned everConverged via a fresh-degraded
    // reading may later get stuck-degraded with a stale last_seen_at if
    // the peer-client walks back onto an unreachable candidate. The loop
    // (F1a fix) doesn't exit early for a degraded pair, but the deadline
    // may expire before recovery. Surface it separately from the
    // never-converged case so triage can distinguish a regression from
    // a peer that never responded at all.
    if (p.expectReachable && p.everConverged && UNDER_CHAOS && p.lastState === 'degraded') {
      const ageMs = p.lastSeenAt > 0 ? finalNow - p.lastSeenAt : Infinity;
      if (ageMs >= 0 && ageMs > LAST_SEEN_FRESHNESS_MS) {
        violations.push({
          viewer: p.viewer,
          candidate: p.candidate,
          kind: 'expected_converged_but_stale_last_seen',
          last_state: p.lastState,
          age_ms: ageMs,
          freshness_threshold_ms: LAST_SEEN_FRESHNESS_MS,
        });
      }
    }
    if (p.everUnexpectedOnline) {
      violations.push({
        viewer: p.viewer,
        candidate: p.candidate,
        kind: 'unexpected_reachable',
      });
    }
  }
  for (const [viewerId, ok] of fetchedOk) {
    if (!ok) {
      violations.push({
        viewer: viewerId,
        kind: 'fetch_failed',
        error: lastFetchError.get(viewerId) ?? 'unknown',
      });
    }
  }

  const ok = violations.length === 0;
  return {
    name: 'federation_peer_state_convergence',
    ok,
    reason: ok
      ? undefined
      : `${violations.length} state convergence violation(s) after ${polls} poll(s)`,
    evidence: {
      violations,
      polls,
      pairs: pairs.map((p) => ({
        viewer: p.viewer,
        candidate: p.candidate,
        expect_reachable: p.expectReachable,
        ever_converged: p.everConverged,
        last_state: p.lastState,
        last_seen_at: p.lastSeenAt,
      })),
    },
    durationMs: Date.now() - start,
  };
}
