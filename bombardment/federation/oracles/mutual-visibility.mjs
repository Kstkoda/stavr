// Bombardment Phase 3d — mutual visibility oracle.
//
// For every peer, /api/federation/peers MUST list every peer ID the
// container's peers.yaml declares. This is the cheapest and most
// fundamental federation invariant: did each daemon actually load
// its peers.yaml at startup and merge it into the registry?
//
// What this catches:
//   - peers.yaml not being read at startup (path resolution drift,
//     STAVR_HOME mis-resolution — the exact bug paths.ts §footnote
//     calls out).
//   - PeerRegistry.loadFromYaml() silently swallowing entries.
//   - The federation reload route not seeing fresh state on a
//     SIGHUP/reload (future regression).
//
// Reachability is a separate oracle (peer-state-convergence.mjs);
// this one only checks that the *registry* lists the peers — they
// can be `state: offline` and still satisfy this invariant.

import { getJson } from '../http-probe.mjs';
import { TOPOLOGY } from '../topology.mjs';

export async function mutualVisibility() {
  const start = Date.now();
  const violations = [];
  const evidence = {};

  for (const peer of TOPOLOGY.peers) {
    let body;
    try {
      const r = await getJson(`${peer.baseUrl}/api/federation/peers`);
      body = r.body;
    } catch (err) {
      violations.push({ peer: peer.id, kind: 'fetch_failed', error: err.message });
      continue;
    }

    if (!body || !Array.isArray(body.peers)) {
      violations.push({ peer: peer.id, kind: 'bad_shape', body });
      continue;
    }

    const reportedIds = new Set(body.peers.map((p) => p.id));
    const missing = peer.configured_peers.filter((id) => !reportedIds.has(id));
    evidence[peer.id] = {
      self_id: body.self_id,
      reported_peers: Array.from(reportedIds).sort(),
      expected_peers: peer.configured_peers,
      missing,
    };
    if (missing.length > 0) {
      violations.push({ peer: peer.id, kind: 'missing_peers', missing });
    }
  }

  const ok = violations.length === 0;
  return {
    name: 'federation_mutual_visibility',
    ok,
    reason: ok ? undefined : `${violations.length} peer(s) had visibility gaps`,
    evidence: { violations, perPeer: evidence },
    durationMs: Date.now() - start,
  };
}
