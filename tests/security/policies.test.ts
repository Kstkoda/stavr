import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../src/db/index.js';
import {
  BUILT_IN_POLICIES,
  POLICY_PRESET_IDS,
  applyPolicyToActor,
  getPolicyPreset,
  listPolicyPresets,
} from '../../src/security/policies.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';

function freshDb(): Database {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE actor_permissions (
      actor_id TEXT NOT NULL,
      tool_id  TEXT NOT NULL,
      tier     TEXT NOT NULL,
      set_by   TEXT NOT NULL,
      set_at   INTEGER NOT NULL,
      PRIMARY KEY (actor_id, tool_id)
    );
  `);
  return db;
}

describe('v0.6.9 P6 — named policy presets', () => {
  it('ships exactly tight / developer / review-only', () => {
    expect(POLICY_PRESET_IDS).toEqual(['tight', 'developer', 'review-only']);
    for (const id of POLICY_PRESET_IDS) {
      expect(BUILT_IN_POLICIES[id].id).toBe(id);
      expect(BUILT_IN_POLICIES[id].label.length).toBeGreaterThan(0);
      expect(BUILT_IN_POLICIES[id].description.length).toBeGreaterThan(0);
    }
  });

  it('every preset keeps host_exec at EXPLICIT or NO_GO (never below)', () => {
    for (const id of POLICY_PRESET_IDS) {
      const tier = BUILT_IN_POLICIES[id].tiers.host_exec;
      expect(['EXPLICIT', 'NO_GO']).toContain(tier);
    }
  });

  it('tight downgrades worker_spawn to CONFIRM', () => {
    expect(BUILT_IN_POLICIES.tight.tiers.worker_spawn).toBe('CONFIRM');
  });

  it('developer lifts worker_spawn to AUTO but keeps host_exec EXPLICIT', () => {
    expect(BUILT_IN_POLICIES.developer.tiers.worker_spawn).toBe('AUTO');
    expect(BUILT_IN_POLICIES.developer.tiers.host_exec).toBe('EXPLICIT');
  });

  it('review-only locks down mutating tools to CONFIRM or NO_GO', () => {
    const r = BUILT_IN_POLICIES['review-only'].tiers;
    expect(r.worker_spawn).toBe('NO_GO');
    expect(r.worker_dispatch).toBe('NO_GO');
    expect(r.host_exec).toBe('NO_GO');
    expect(r.worker_terminate).toBe('CONFIRM');
  });

  // worker-dispatch Phase 3b — every preset MUST carry job_* parity entries
  // for each worker_* tier choice so applying a policy writes consistent
  // rows for both wire names. Otherwise an operator clicking 'review-only'
  // gets worker_spawn=NO_GO but job_dispatch silently falls back to the
  // baseline CONFIRM tier.
  describe('Phase 3b — worker_* / job_* preset parity', () => {
    const PAIRS: Array<[keyof typeof BUILT_IN_POLICIES.tight.tiers, keyof typeof BUILT_IN_POLICIES.tight.tiers]> = [
      ['worker_list_types', 'job_list_bindings'],
      ['worker_list', 'job_list'],
      ['worker_status', 'job_status'],
      ['worker_spawn', 'job_dispatch'],
      ['worker_dispatch', 'job_inject'],
      ['worker_terminate', 'job_terminate'],
    ];

    for (const presetId of POLICY_PRESET_IDS) {
      describe(`${presetId} preset`, () => {
        for (const [legacy, canonical] of PAIRS) {
          it(`${legacy} ≡ ${canonical}`, () => {
            const tiers = BUILT_IN_POLICIES[presetId].tiers as Record<string, string>;
            expect(tiers[canonical]).toBe(tiers[legacy]);
          });
        }
      });
    }
  });

  it('listPolicyPresets returns all three in stable order', () => {
    const presets = listPolicyPresets();
    expect(presets.map((p) => p.id)).toEqual(['tight', 'developer', 'review-only']);
  });

  it('getPolicyPreset throws on unknown id with a helpful message', () => {
    expect(() => getPolicyPreset('not-a-thing')).toThrow(/unknown policy preset/);
    expect(() => getPolicyPreset('not-a-thing')).toThrow(/tight, developer, review-only/);
  });
});

describe('v0.6.9 P6 — applyPolicyToActor', () => {
  let db: Database;
  let perms: ActorPermissionStore;

  beforeEach(() => {
    db = freshDb();
    perms = new ActorPermissionStore(db);
  });
  afterEach(() => {
    db.close();
  });

  it('writes every (actor, tool) cell named in the preset for the target actor', () => {
    const result = applyPolicyToActor(
      BUILT_IN_POLICIES.tight,
      'cowork-claude',
      perms,
      'operator',
    );
    expect(result.cellsWritten).toBeGreaterThan(0);
    expect(result.cellsWritten).toBe(Object.keys(BUILT_IN_POLICIES.tight.tiers).length);
    expect(perms.get('cowork-claude', 'worker_spawn')?.tier).toBe('CONFIRM');
    expect(perms.get('cowork-claude', 'host_exec')?.tier).toBe('EXPLICIT');
  });

  it('returns a per-tool changes list with from_tier=null for fresh writes', () => {
    const result = applyPolicyToActor(
      BUILT_IN_POLICIES.developer,
      'steward',
      perms,
      'operator',
    );
    const spawnChange = result.changes.find((c) => c.tool_id === 'worker_spawn');
    expect(spawnChange).toBeDefined();
    expect(spawnChange!.from_tier).toBeNull();
    expect(spawnChange!.to_tier).toBe('AUTO');
  });

  it('returns from_tier=<prior> when the cell already had a matrix row', () => {
    perms.set('cc', 'worker_spawn', 'EXPLICIT', 'operator');
    const result = applyPolicyToActor(
      BUILT_IN_POLICIES.developer,
      'cc',
      perms,
      'operator',
    );
    const spawnChange = result.changes.find((c) => c.tool_id === 'worker_spawn');
    expect(spawnChange?.from_tier).toBe('EXPLICIT');
    expect(spawnChange?.to_tier).toBe('AUTO');
    expect(perms.get('cc', 'worker_spawn')?.tier).toBe('AUTO');
  });

  it('skips no-op writes when the cell already matches the preset', () => {
    perms.set('operator', 'worker_spawn', 'AUTO', 'operator');
    const result = applyPolicyToActor(
      BUILT_IN_POLICIES.developer,
      'operator',
      perms,
      'operator',
    );
    const spawnChange = result.changes.find((c) => c.tool_id === 'worker_spawn');
    expect(spawnChange).toBeUndefined();
  });

  it('does not touch tools that are not mentioned in the preset', () => {
    // Pre-set a row for a tool NOT listed in the tight preset.
    perms.set('cowork-claude', 'github_search_repositories', 'AUTO', 'operator');
    applyPolicyToActor(
      BUILT_IN_POLICIES.tight,
      'cowork-claude',
      perms,
      'operator',
    );
    expect(perms.get('cowork-claude', 'github_search_repositories')?.tier).toBe('AUTO');
  });

  it('only affects the target actor — other actors are unchanged', () => {
    perms.set('steward', 'worker_spawn', 'EXPLICIT', 'operator');
    applyPolicyToActor(
      BUILT_IN_POLICIES.tight,
      'cowork-claude',
      perms,
      'operator',
    );
    expect(perms.get('steward', 'worker_spawn')?.tier).toBe('EXPLICIT');
    expect(perms.get('cowork-claude', 'worker_spawn')?.tier).toBe('CONFIRM');
  });
});
