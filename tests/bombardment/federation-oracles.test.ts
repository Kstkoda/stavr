/**
 * Bombardment Phase 3d — federation oracle shape tests.
 *
 * These are NOT the live-topology tests — those run in the
 * bombardment-docker CI workflow against the real docker-compose
 * federation. This file asserts the local invariants we can check
 * without Docker:
 *
 *   1. Each federation oracle module is importable and exports a
 *      callable function with the right shape.
 *   2. Each oracle returns the structured OracleResult contract
 *      (name, ok, durationMs, optional reason + evidence).
 *   3. Against nothing-listening, every oracle exits with
 *      ok=false and a reason that points at the fetch failure
 *      (it must not throw — the runner depends on graceful
 *      failure to aggregate the run).
 *   4. The topology descriptor's reachableFrom() agrees with
 *      the compose file's network layout.
 *
 * Catches: the runner shape regressing, an oracle file silently
 * dropping its default export, the topology descriptor getting out
 * of sync with the compose-file network shape.
 */

import { describe, expect, it } from 'vitest';
import { TOPOLOGY, reachableFrom } from '../../bombardment/federation/topology.mjs';
import {
  defaultFederationOracles,
  destructiveFederationOracles,
  identityPropagation,
  mutualVisibility,
  peerStateConvergence,
} from '../../bombardment/federation/oracles/index.mjs';

interface OracleResult {
  name: string;
  ok: boolean | null;
  reason?: string;
  evidence?: Record<string, unknown>;
  durationMs: number;
}

function expectResultShape(r: OracleResult): void {
  expect(typeof r.name).toBe('string');
  expect(r.name.length).toBeGreaterThan(0);
  expect([true, false, null]).toContain(r.ok);
  expect(typeof r.durationMs).toBe('number');
  if (r.ok !== true) {
    expect(typeof r.reason).toBe('string');
  }
}

describe('bombardment/federation/topology', () => {
  it('declares three peers across the expected networks', () => {
    expect(TOPOLOGY.peers.map((p) => p.id).sort()).toEqual(['hub', 'peer-a', 'peer-b']);
    const networks = new Set(TOPOLOGY.peers.map((p) => p.network));
    expect(networks.has('site_a')).toBe(true);
    expect(networks.has('site_b')).toBe(true);
    expect(networks.has('both')).toBe(true);
  });

  it('reachableFrom(peer-a) includes hub but not peer-b (cross-subnet block)', () => {
    const reach = reachableFrom('peer-a');
    expect(reach.has('hub')).toBe(true);
    expect(reach.has('peer-b')).toBe(false);
  });

  it('reachableFrom(peer-b) includes hub but not peer-a', () => {
    const reach = reachableFrom('peer-b');
    expect(reach.has('hub')).toBe(true);
    expect(reach.has('peer-a')).toBe(false);
  });

  it('reachableFrom(hub) sees both peers (hub is multi-homed)', () => {
    const reach = reachableFrom('hub');
    expect(reach.has('peer-a')).toBe(true);
    expect(reach.has('peer-b')).toBe(true);
  });

  it('reachableFrom(unknown) returns empty set', () => {
    expect(reachableFrom('ghost').size).toBe(0);
  });
});

describe('bombardment/federation/oracles registry', () => {
  it('defaultFederationOracles returns three callables', () => {
    const oracles = defaultFederationOracles();
    expect(oracles).toHaveLength(3);
    for (const o of oracles) {
      expect(typeof o).toBe('function');
    }
  });

  it('destructiveFederationOracles is non-empty and separate from the default set', () => {
    const destructive = destructiveFederationOracles();
    expect(destructive.length).toBeGreaterThan(0);
    const defaults = new Set(defaultFederationOracles().map((o) => o.name));
    for (const o of destructive) {
      expect(defaults.has(o.name)).toBe(false);
    }
  });
});

// Hitting non-listening ports is the easiest way to assert the
// graceful-failure contract without standing up the full compose.
// We use 0.0.0.0:1 — guaranteed-closed on a normal host — by
// monkey-patching the http-probe at the topology layer (the oracles
// read TOPOLOGY directly). Since topology.mjs is module-scoped,
// we cannot rewrite it here; instead we just run the oracles and
// expect graceful failures pointing at the configured 127.0.0.1
// host ports (which are not listening in a vitest run).
describe('bombardment/federation/oracles graceful failure', () => {
  it('mutualVisibility returns ok=false (not throws) when peers are unreachable', async () => {
    const r = await mutualVisibility();
    expectResultShape(r);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeDefined();
  }, 30_000);

  it('peerStateConvergence returns ok=false on unreachable peers', async () => {
    const r = await peerStateConvergence();
    expectResultShape(r);
    expect(r.ok).toBe(false);
  }, 30_000);

  it('identityPropagation returns ok=false on unreachable peers', async () => {
    const r = await identityPropagation();
    expectResultShape(r);
    expect(r.ok).toBe(false);
  }, 30_000);
});
