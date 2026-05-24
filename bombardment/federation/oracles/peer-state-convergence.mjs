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
//     with the viewer) is observed `online` AT LEAST ONCE. That proves
//     the PeerClient probe loop ran and `recordPingResult` flowed into
//     the registry. A clean probe always succeeds; even a chaos probe
//     succeeds ~90%, so across a couple of probe cycles every
//     reachable peer is seen online at some poll.
//   - no cross-subnet peer is EVER observed `online` across the whole
//     window — the federation safety invariant, strictly stronger than
//     a single-instant check.
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
        everOnline: false, // reachable peer seen `online` >= once
        everUnexpectedOnline: false, // cross-subnet peer seen `online` (a breach)
        lastState: 'missing',
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
      const stateById = new Map((body?.peers ?? []).map((p) => [p.id, p.state]));
      for (const pair of pairs) {
        if (pair.viewer !== viewer.id) continue;
        const state = stateById.get(pair.candidate) ?? 'missing';
        pair.lastState = state;
        if (state === 'online') {
          if (pair.expectReachable) pair.everOnline = true;
          else pair.everUnexpectedOnline = true;
        }
      }
    }

    // Converged: every reachable pair has been seen `online` at least
    // once. The cross-subnet safety check keeps running until then — a
    // cross-subnet `online` is a deterministic config break, so the
    // convergence window is ample to surface it.
    const converged = pairs.every((p) => !p.expectReachable || p.everOnline);
    if (converged) break;

    // Bail fast if nothing is listening at all — no amount of waiting
    // brings up a topology that isn't there.
    const anyFetchEver = [...fetchedOk.values()].some(Boolean);
    if (!anyFetchEver) break;

    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const violations = [];
  for (const p of pairs) {
    if (p.expectReachable && !p.everOnline) {
      violations.push({
        viewer: p.viewer,
        candidate: p.candidate,
        kind: 'expected_online_but_not',
        last_state: p.lastState,
      });
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
        ever_online: p.everOnline,
        last_state: p.lastState,
      })),
    },
    durationMs: Date.now() - start,
  };
}
