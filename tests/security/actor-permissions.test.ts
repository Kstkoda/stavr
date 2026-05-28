import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';

describe('ActorPermissionStore', () => {
  let store: EventStore;
  let perms: ActorPermissionStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    perms = new ActorPermissionStore(store.rawDb);
  });

  afterEach(() => {
    store.close();
  });

  it('resolves to the registered default when no matrix row exists', () => {
    const r = perms.resolve('cowork-claude', 'worker_spawn');
    expect(r.tier).toBe('CONFIRM');
    expect(r.source).toBe('default');
  });

  it('returns the matrix-set tier when a row exists', () => {
    perms.set('cowork-claude', 'host_exec', 'NO_GO', 'operator');
    const r = perms.resolve('cowork-claude', 'host_exec');
    expect(r.tier).toBe('NO_GO');
    expect(r.source).toBe('matrix');
  });

  it('set() upserts — second call overrides the first', () => {
    perms.set('cowork-claude', 'host_exec', 'CONFIRM', 'operator');
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    expect(perms.resolve('cowork-claude', 'host_exec').tier).toBe('EXPLICIT');
    expect(perms.list()).toHaveLength(1);
  });

  it('reset() removes a single cell and falls back to default', () => {
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    perms.reset('cowork-claude', 'worker_spawn');
    expect(perms.resolve('cowork-claude', 'worker_spawn').source).toBe('default');
  });

  it('resetActor() drops every row for one actor only', () => {
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    perms.set('steward', 'host_exec', 'NO_GO', 'operator');
    perms.resetActor('cowork-claude');
    expect(perms.byActor('cowork-claude')).toEqual([]);
    expect(perms.byActor('steward')).toHaveLength(1);
  });

  it('byActor() returns rows for that actor only, sorted by tool', () => {
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    perms.set('cowork-claude', 'emit_event', 'AUTO', 'operator');
    perms.set('steward', 'host_exec', 'NO_GO', 'operator');
    expect(perms.byActor('cowork-claude').map((r) => r.tool_id)).toEqual([
      'emit_event',
      'host_exec',
      'worker_spawn',
    ]);
  });

  it('actors() returns distinct ids seen in the matrix', () => {
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    perms.set('steward', 'host_exec', 'NO_GO', 'operator');
    perms.set('peer:abc', 'host_exec', 'AUTO', 'operator');
    expect(perms.actors().sort()).toEqual(['cowork-claude', 'peer:abc', 'steward']);
  });

  it('Steward NO_GO for github_merge_pr stops Steward auto-merge even with scope', () => {
    // Acceptance scenario from BOM P4
    perms.set('steward', 'github_merge_pr', 'NO_GO', 'operator');
    const r = perms.resolve('steward', 'github_merge_pr');
    expect(r.tier).toBe('NO_GO');
    // Other actors unaffected — Cowork-Claude still gets default for the same tool
    const cwc = perms.resolve('cowork-claude', 'github_merge_pr');
    expect(cwc.source).toBe('default');
  });

  // family-mode-phase-1 Phase 5.6 — operator-shape is an EXPLICIT
  // ALLOWLIST; anything else falls through to default-deny.
  describe('default-deny catch-all for non-operator-shape actors', () => {
    it('returns NO_GO with source default-deny for a paired peer (peer:*)', () => {
      const r = perms.resolve('peer:fresh-laptop', 'emit_event');
      expect(r.tier).toBe('NO_GO');
      expect(r.source).toBe('default-deny');
    });

    it('returns NO_GO with source default-deny for the transport\'s `unknown` stamp', () => {
      // The transport stamps actor_id='unknown' for a non-loopback HTTP
      // request without a verified device — reachable via the
      // requireAuthWhenNonLocal: false escape hatch. Phase 5.5's
      // denylist let this fall through to defaultTierFor (AUTO on
      // get_events!); Phase 5.6's allowlist refuses it.
      const r = perms.resolve('unknown', 'get_events');
      expect(r.tier).toBe('NO_GO');
      expect(r.source).toBe('default-deny');
    });

    it('returns NO_GO with source default-deny for any unrecognized actor_id shape', () => {
      // Future-proofing: anything that isn't a loopback shape or a
      // member of KNOWN_ACTORS resolves to default-deny. The catch-all
      // means a new actor_id format introduced by a future BOM can't
      // silently inherit operator defaults — the operator must
      // explicitly grant tiers.
      for (const actor of ['arbitrary-string', 'mystery-actor', 'webrtc:fed-peer', 'oauth:1234']) {
        const r = perms.resolve(actor, 'emit_event');
        expect(r.tier, actor).toBe('NO_GO');
        expect(r.source, actor).toBe('default-deny');
      }
    });

    it('does NOT inherit the AUTO default that operator-shape actors get', () => {
      // Same tool, three actors: operator (default), peer (default-deny),
      // unknown (default-deny). The operator gets AUTO; the others get
      // NO_GO.
      expect(perms.resolve('operator', 'emit_event').tier).toBe('AUTO');
      expect(perms.resolve('peer:fresh-laptop', 'emit_event').tier).toBe('NO_GO');
      expect(perms.resolve('unknown', 'emit_event').tier).toBe('NO_GO');
    });

    it('an explicit matrix row beats the default-deny fall-through', () => {
      perms.set('peer:fresh-laptop', 'emit_event', 'AUTO', 'operator');
      perms.set('unknown', 'emit_event', 'CONFIRM', 'operator');
      expect(perms.resolve('peer:fresh-laptop', 'emit_event')).toEqual({
        tier: 'AUTO',
        source: 'matrix',
      });
      expect(perms.resolve('unknown', 'emit_event')).toEqual({
        tier: 'CONFIRM',
        source: 'matrix',
      });
    });

    it('reset() returns a peer to default-deny (not defaultTierFor)', () => {
      perms.set('peer:fresh-laptop', 'worker_spawn', 'CONFIRM', 'operator');
      perms.reset('peer:fresh-laptop', 'worker_spawn');
      const r = perms.resolve('peer:fresh-laptop', 'worker_spawn');
      expect(r.tier).toBe('NO_GO');
      expect(r.source).toBe('default-deny');
    });

    it('loopback-stamped actors resolve via defaultTierFor()', () => {
      // The HTTP transport stamps loopback:<corr> for verified /mcp
      // loopback callers; stdio sessions get unstamped-loopback. Both
      // are on the allowlist.
      expect(perms.resolve('unstamped-loopback', 'worker_spawn').source).toBe('default');
      expect(perms.resolve('unstamped-loopback', 'worker_spawn').tier).toBe('CONFIRM');
      expect(perms.resolve('loopback:abc-corr-1', 'host_exec').source).toBe('default');
      expect(perms.resolve('loopback:abc-corr-1', 'host_exec').tier).toBe('EXPLICIT');
      expect(perms.resolve('loopback:xyz', 'emit_event').tier).toBe('AUTO');
    });

    it('KNOWN_ACTORS members (operator, cc, cowork-claude, steward) resolve via defaultTierFor', () => {
      // Sanity: Phase 5.6 KEEPS these on the allowlist — the dashboard
      // matrix UI relies on them showing baseline tiers per row.
      expect(perms.resolve('operator', 'worker_spawn').source).toBe('default');
      expect(perms.resolve('cc', 'worker_spawn').source).toBe('default');
      expect(perms.resolve('cowork-claude', 'worker_spawn').source).toBe('default');
      expect(perms.resolve('steward', 'worker_spawn').source).toBe('default');
    });
  });

  // worker-dispatch Phase 3c.2 — the alias-aware fallback test block was
  // here. Deleted along with `aliasCounterpartFor` and the legacy
  // worker_* tool registrations. The legacy tool-ID strings (`worker_spawn`
  // etc) still appear in the tests above only as arbitrary string tokens
  // exercising the matrix-row CRUD + default-tier resolution — they no
  // longer correspond to any registered tool, but the matrix table accepts
  // any tool_id string and `defaultTierFor` returns the conservative
  // 'CONFIRM' for unknown ids via the 'other' category branch.
});
