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
});
