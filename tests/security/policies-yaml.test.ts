import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../src/db/index.js';
import {
  buildPermissionsYaml,
  importPermissionsYaml,
  permissionsYamlString,
  PERMISSIONS_YAML_VERSION,
} from '../../src/security/policies-yaml.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';
import { CapabilityOverrideStore } from '../../src/security/capability-overrides.js';

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
    CREATE TABLE capability_overrides (
      tool_id        TEXT PRIMARY KEY,
      state          TEXT NOT NULL,
      disabled_until INTEGER,
      reason         TEXT,
      set_by         TEXT NOT NULL,
      set_at         INTEGER NOT NULL
    );
  `);
  return db;
}

describe('v0.6.9 P7 — YAML export', () => {
  let db: Database;
  let perms: ActorPermissionStore;
  let caps: CapabilityOverrideStore;

  beforeEach(() => {
    db = freshDb();
    perms = new ActorPermissionStore(db);
    caps = new CapabilityOverrideStore(db);
  });
  afterEach(() => db.close());

  it('returns an empty-payload doc with version when no rows exist', () => {
    const doc = buildPermissionsYaml({ caps, perms });
    expect(doc.version).toBe(PERMISSIONS_YAML_VERSION);
    expect(doc.capability_overrides).toBeUndefined();
    expect(doc.actor_permissions).toBeUndefined();
  });

  it('exports a permanent disable with reason', () => {
    caps.disablePermanent('host_exec', { reason: 'audit pending', setBy: 'operator' });
    const doc = buildPermissionsYaml({ caps, perms });
    expect(doc.capability_overrides?.host_exec).toEqual({
      state: 'disabled-permanent',
      reason: 'audit pending',
    });
  });

  it('exports a temporary disable with ISO disabled_until', () => {
    const until = Date.UTC(2026, 5, 1); // 2026-06-01T00:00:00Z
    caps.disableTemporary('github_merge_pr', { untilMs: until, setBy: 'operator' });
    const doc = buildPermissionsYaml({ caps, perms });
    const row = doc.capability_overrides?.github_merge_pr;
    expect(row?.state).toBe('disabled-temporary');
    expect(row?.disabled_until).toBe(new Date(until).toISOString());
  });

  it('skips enabled rows in capability export (no-op rows)', () => {
    caps.enable('worker_spawn', 'operator');
    const doc = buildPermissionsYaml({ caps, perms });
    expect(doc.capability_overrides ?? {}).not.toHaveProperty('worker_spawn');
  });

  it('groups actor permissions by actor → tool → tier', () => {
    perms.set('cowork-claude', 'worker_spawn', 'CONFIRM', 'operator');
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    perms.set('steward', 'worker_spawn', 'AUTO', 'operator');
    const doc = buildPermissionsYaml({ caps, perms });
    expect(doc.actor_permissions?.['cowork-claude']).toEqual({
      worker_spawn: 'CONFIRM',
      host_exec: 'EXPLICIT',
    });
    expect(doc.actor_permissions?.steward).toEqual({ worker_spawn: 'AUTO' });
  });

  it('produces deterministic YAML text (stable key ordering)', () => {
    perms.set('cowork-claude', 'host_exec', 'EXPLICIT', 'operator');
    perms.set('cowork-claude', 'worker_spawn', 'CONFIRM', 'operator');
    const text1 = permissionsYamlString(buildPermissionsYaml({ caps, perms }));
    const text2 = permissionsYamlString(buildPermissionsYaml({ caps, perms }));
    expect(text1).toBe(text2);
    expect(text1).toContain('actor_permissions:');
    expect(text1).toContain('cowork-claude:');
  });
});

describe('v0.6.9 P7 — YAML import', () => {
  let db: Database;
  let perms: ActorPermissionStore;
  let caps: CapabilityOverrideStore;

  beforeEach(() => {
    db = freshDb();
    perms = new ActorPermissionStore(db);
    caps = new CapabilityOverrideStore(db);
  });
  afterEach(() => db.close());

  it('round-trips: export → import → identical store state', () => {
    caps.disablePermanent('host_exec', { reason: 'frozen for audit', setBy: 'operator' });
    perms.set('cowork-claude', 'worker_spawn', 'NO_GO', 'operator');
    perms.set('steward', 'host_exec', 'EXPLICIT', 'operator');

    const yaml = permissionsYamlString(buildPermissionsYaml({ caps, perms }));

    // Fresh DB to import into.
    const db2 = freshDb();
    const caps2 = new CapabilityOverrideStore(db2);
    const perms2 = new ActorPermissionStore(db2);
    const result = importPermissionsYaml({ caps: caps2, perms: perms2, setBy: 'cli', yaml });
    expect(result.warnings).toEqual([]);
    expect(result.capabilityRowsWritten).toBe(1);
    expect(result.actorRowsWritten).toBe(2);

    expect(caps2.get('host_exec')?.state).toBe('disabled-permanent');
    expect(caps2.get('host_exec')?.reason).toBe('frozen for audit');
    expect(perms2.get('cowork-claude', 'worker_spawn')?.tier).toBe('NO_GO');
    expect(perms2.get('steward', 'host_exec')?.tier).toBe('EXPLICIT');

    db2.close();
  });

  it('warns and skips disabled-temporary rows without disabled_until', () => {
    const yaml = `version: 1
capability_overrides:
  host_exec:
    state: disabled-temporary
    reason: oops missing until
`;
    const result = importPermissionsYaml({ caps, perms, setBy: 'cli', yaml });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('disabled_until');
    expect(caps.get('host_exec')).toBeUndefined();
  });

  it('rejects malformed YAML', () => {
    expect(() =>
      importPermissionsYaml({ caps, perms, setBy: 'cli', yaml: '::: not yaml :::' }),
    ).toThrow();
  });

  it('rejects YAML with an unknown tier name', () => {
    const yaml = `version: 1
actor_permissions:
  cowork-claude:
    worker_spawn: SUPER_AUTO
`;
    expect(() =>
      importPermissionsYaml({ caps, perms, setBy: 'cli', yaml }),
    ).toThrow();
  });

  it('imports additively — existing matrix rows for tools not in YAML remain', () => {
    perms.set('cowork-claude', 'github_search_repositories', 'AUTO', 'operator');
    const yaml = `version: 1
actor_permissions:
  cowork-claude:
    worker_spawn: CONFIRM
`;
    importPermissionsYaml({ caps, perms, setBy: 'cli', yaml });
    expect(perms.get('cowork-claude', 'github_search_repositories')?.tier).toBe('AUTO');
    expect(perms.get('cowork-claude', 'worker_spawn')?.tier).toBe('CONFIRM');
  });
});
