import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { CapabilityOverrideStore } from '../../src/security/capability-overrides.js';

describe('CapabilityOverrideStore', () => {
  let store: EventStore;
  let caps: CapabilityOverrideStore;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    caps = new CapabilityOverrideStore(store.rawDb);
  });

  afterEach(() => {
    store.close();
  });

  it('returns allowed=true for an unknown tool (no row → no override)', () => {
    const r = caps.check('worker_spawn');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('disablePermanent locks a tool until the operator re-enables it', () => {
    caps.disablePermanent('worker_spawn', { reason: 'audit pause', setBy: 'operator' });
    const r = caps.check('worker_spawn');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('audit pause');
    expect(caps.isDisabled('worker_spawn')).toBe(true);
  });

  it('disableTemporary blocks before the deadline + unblocks after', () => {
    const nowMs = 1_000_000;
    caps.disableTemporary('github_merge_pr', {
      untilMs: nowMs + 60_000,
      reason: 'release freeze',
      setBy: 'operator',
    });
    expect(caps.check('github_merge_pr', nowMs).allowed).toBe(false);
    expect(caps.check('github_merge_pr', nowMs + 30_000).allowed).toBe(false);
    // At-or-past the deadline → allowed, with the `expired` hint set
    const past = caps.check('github_merge_pr', nowMs + 60_000);
    expect(past.allowed).toBe(true);
    expect(past.expired).toBe(true);
  });

  it('enable() lifts a previous disable', () => {
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    expect(caps.isDisabled('worker_spawn')).toBe(true);
    caps.enable('worker_spawn', 'operator');
    expect(caps.isDisabled('worker_spawn')).toBe(false);
    expect(caps.check('worker_spawn').allowed).toBe(true);
  });

  it('upsert overwrites — disable then re-disable changes the reason', () => {
    caps.disablePermanent('host_exec', { reason: 'pause v1', setBy: 'operator' });
    caps.disablePermanent('host_exec', { reason: 'pause v2', setBy: 'operator' });
    const row = caps.get('host_exec');
    expect(row).toBeDefined();
    expect(row?.reason).toBe('pause v2');
    expect(caps.list()).toHaveLength(1);
  });

  it('remove() drops the row entirely (falls through to default)', () => {
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    caps.remove('worker_spawn');
    expect(caps.get('worker_spawn')).toBeUndefined();
    expect(caps.check('worker_spawn').allowed).toBe(true);
  });

  it('list() returns rows sorted by tool_id', () => {
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    caps.disablePermanent('emit_event', { setBy: 'operator' });
    caps.disablePermanent('host_exec', { setBy: 'operator' });
    expect(caps.list().map((r) => r.tool_id)).toEqual([
      'emit_event',
      'host_exec',
      'worker_spawn',
    ]);
  });

  it('activeDisabledCount excludes expired temporary disables', () => {
    const nowMs = 5_000_000;
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    caps.disableTemporary('host_exec', { untilMs: nowMs - 1, setBy: 'operator' });
    caps.disableTemporary('emit_event', { untilMs: nowMs + 60_000, setBy: 'operator' });
    expect(caps.activeDisabledCount(nowMs)).toBe(2); // worker_spawn + emit_event
  });

  it('records set_by + set_at on every write', () => {
    const before = Date.now();
    caps.disablePermanent('worker_spawn', { setBy: 'operator' });
    const row = caps.get('worker_spawn');
    expect(row?.set_by).toBe('operator');
    expect(row?.set_at).toBeGreaterThanOrEqual(before);
  });
});
