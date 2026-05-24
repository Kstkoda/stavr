// Bombardment Phase 3d — operator-identity propagation oracle.
//
// Today, peers.yaml's `self_id` IS the peer identity each daemon
// publishes. Full operator-identity propagation (ADR-042 §Decision 3
// — passkey-rooted operator identity flowing across the federation)
// is unimplemented today; this oracle asserts the slice that IS
// implemented and reserves the surface for when the operator-identity
// extension lands.
//
// What this asserts (what's implementable today):
//   1. Each peer's /api/federation/peers reports its own self_id
//      equal to the STAVR_PEER_ID env (and the topology descriptor's
//      `id`).
//   2. Each peer's view of another peer carries the *correct* peer
//      ID, hostname, and port — IDs don't get mangled in transit (no
//      mDNS collision, no peers.yaml reload race).
//
// What this defers (future ADR-042 work, OUT of Phase 3):
//   - Operator's passkey-rooted operator_id propagating from the
//     pairing handshake to every peer's view of "who's logged in".
//     That requires the eventStore + /api/federation/event surface
//     to be live; this oracle will be extended to assert it once
//     that lands.

import { getJson } from '../http-probe.mjs';
import { TOPOLOGY } from '../topology.mjs';

export async function identityPropagation() {
  const start = Date.now();
  const violations = [];
  const evidence = {};

  for (const viewer of TOPOLOGY.peers) {
    let peersBody;
    try {
      const r = await getJson(`${viewer.baseUrl}/api/federation/peers`);
      peersBody = r.body;
    } catch (err) {
      violations.push({ viewer: viewer.id, kind: 'fetch_failed', error: err.message });
      continue;
    }

    const perViewer = { reported_self_id: peersBody.self_id };

    // Invariant 1: self_id reported matches the configured peer id.
    if (peersBody.self_id !== viewer.id) {
      violations.push({
        viewer: viewer.id,
        kind: 'self_id_mismatch',
        expected: viewer.id,
        actual: peersBody.self_id,
      });
    }

    // Invariant 2: the peer's view of every other peer carries the
    // expected id+hostname+port (no munging in the registry merge).
    perViewer.view_of = {};
    for (const candidate of TOPOLOGY.peers) {
      if (candidate.id === viewer.id) continue;
      const view = peersBody.peers.find((p) => p.id === candidate.id);
      perViewer.view_of[candidate.id] = view ?? null;
      if (!view) {
        violations.push({
          viewer: viewer.id,
          candidate: candidate.id,
          kind: 'candidate_missing_from_view',
        });
        continue;
      }
      if (view.hostname !== candidate.id) {
        violations.push({
          viewer: viewer.id,
          candidate: candidate.id,
          kind: 'hostname_mismatch',
          expected: candidate.id,
          actual: view.hostname,
        });
      }
      if (view.port !== 7777) {
        violations.push({
          viewer: viewer.id,
          candidate: candidate.id,
          kind: 'port_mismatch',
          expected: 7777,
          actual: view.port,
        });
      }
    }

    evidence[viewer.id] = perViewer;
  }

  const ok = violations.length === 0;
  return {
    name: 'federation_identity_propagation',
    ok,
    reason: ok ? undefined : `${violations.length} identity-propagation violation(s)`,
    evidence: { violations, perViewer: evidence },
    durationMs: Date.now() - start,
  };
}
