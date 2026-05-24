// Bombardment Phase 3d — peer-state convergence oracle.
//
// After the daemon's PeerClient has had time to probe (default 60s
// interval), the registry's `state` field for each peer MUST converge
// to:
//
//   - `online` for peers reachable on a shared docker network (e.g.
//     peer-a's view of hub: same site_a network, Docker DNS resolves).
//   - `offline` or `degraded` for peers configured in peers.yaml but
//     not reachable at the IP layer (e.g. peer-a's view of peer-b:
//     they live on disjoint user networks).
//
// What this catches:
//   - PeerClient never being started (the `pingNow()` loop's
//     `setInterval` not firing — the seam that would silently leave
//     every configured peer stuck at startup state).
//   - recordPingResult not flowing into PeerRegistry.
//   - A regression that promotes cross-network peers to `online`
//     spuriously (which would mask a real federation breakage in
//     production).
//
// Reachability is computed from the topology descriptor —
// `reachableFrom(viewerId)` returns the set of peer IDs the viewer
// shares a Docker network with.

import { getJson } from '../http-probe.mjs';
import { TOPOLOGY, reachableFrom } from '../topology.mjs';

export async function peerStateConvergence() {
  const start = Date.now();
  const violations = [];
  const evidence = {};

  for (const viewer of TOPOLOGY.peers) {
    let body;
    try {
      const r = await getJson(`${viewer.baseUrl}/api/federation/peers`);
      body = r.body;
    } catch (err) {
      violations.push({ viewer: viewer.id, kind: 'fetch_failed', error: err.message });
      continue;
    }

    const reachableIds = reachableFrom(viewer.id);
    const stateById = new Map(body.peers.map((p) => [p.id, p.state]));
    const perPeer = {};

    for (const candidate of TOPOLOGY.peers) {
      if (candidate.id === viewer.id) continue;
      const state = stateById.get(candidate.id) ?? 'missing';
      const expectReachable = reachableIds.has(candidate.id);
      perPeer[candidate.id] = { state, expect_reachable: expectReachable };

      if (expectReachable && state !== 'online') {
        violations.push({
          viewer: viewer.id,
          candidate: candidate.id,
          kind: 'expected_online_but_not',
          state,
        });
      }
      // The inverse — cross-subnet peer reported online — would be a
      // silent federation safety violation. Flag it.
      if (!expectReachable && state === 'online') {
        violations.push({
          viewer: viewer.id,
          candidate: candidate.id,
          kind: 'unexpected_reachable',
          state,
        });
      }
    }

    evidence[viewer.id] = perPeer;
  }

  const ok = violations.length === 0;
  return {
    name: 'federation_peer_state_convergence',
    ok,
    reason: ok ? undefined : `${violations.length} state convergence violation(s)`,
    evidence: { violations, perViewer: evidence },
    durationMs: Date.now() - start,
  };
}
