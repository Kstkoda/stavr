// Bombardment Phase 3d — federation topology descriptor.
//
// Single source of truth for which peers exist + who-can-reach-whom
// in the docker-compose rig. Oracles + the runner read this; if the
// compose file changes shape, this descriptor changes with it.

export const TOPOLOGY = {
  peers: [
    {
      id: 'peer-a',
      container: 'stavr-peer-a',
      // The HEALTHCHECK port is the internal one (7777); the host-side
      // port mapping is what the oracle runner uses to probe from the
      // CI runner's network namespace.
      baseUrl: 'http://127.0.0.1:17777',
      network: 'site_a',
      configured_peers: ['hub', 'peer-b'],
    },
    {
      id: 'peer-b',
      container: 'stavr-peer-b',
      baseUrl: 'http://127.0.0.1:17778',
      network: 'site_b',
      configured_peers: ['hub', 'peer-a'],
    },
    {
      id: 'hub',
      container: 'stavr-hub',
      baseUrl: 'http://127.0.0.1:17779',
      network: 'both',
      configured_peers: ['peer-a', 'peer-b'],
    },
  ],
};

// Returns the set of peer IDs that `viewer` can reach over the docker
// network at the IP layer. The cross-subnet block is the BOM's "real
// cross-subnet failure shape": peer-a cannot reach peer-b directly,
// and neither will the federation register the other as `online`
// (Phase 2-trimmed federation has no app-layer relay yet — that ships
// with eventStore + /api/federation/event in a later cycle).
export function reachableFrom(viewerId) {
  const viewer = TOPOLOGY.peers.find((p) => p.id === viewerId);
  if (!viewer) return new Set();
  const reachable = new Set();
  for (const candidate of TOPOLOGY.peers) {
    if (candidate.id === viewer.id) continue;
    const sharesNetwork =
      candidate.network === viewer.network ||
      candidate.network === 'both' ||
      viewer.network === 'both';
    if (sharesNetwork) reachable.add(candidate.id);
  }
  return reachable;
}
