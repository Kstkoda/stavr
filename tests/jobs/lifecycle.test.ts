/**
 * tests/jobs/lifecycle.test.ts
 *
 * Coverage for the derived-state helpers ported into src/jobs/lifecycle.ts
 * (worker-dispatch Phase 3c.1 — the port; Phase 3c.2 — this test moves
 * with the deletion of src/workers/lifecycle.ts).
 *
 * JobLifecycleInput is slimmer than the legacy LifecycleInput because the
 * JobOrchestrator writes `lifecycle_state` authoritatively; derivation
 * here is mostly a stale-detection shim for the running/dispatched case
 * (the May-15 zombie shape). The same conservative-default invariants
 * from BOM v0.6.6 (active vs lifetime, killed-by-operator distinct from
 * crashed) carry forward.
 */
import { describe, expect, it } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  isValidJobLifecycleState,
  lifecycleHalo,
  lifecycleLabel,
  type JobLifecycleState,
} from '../../src/jobs/lifecycle.js';

// Anchor time chosen so tests are fully deterministic regardless of when
// the suite runs.
const NOW = Date.parse('2026-05-17T22:00:00Z');

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

describe('deriveLifecycleState', () => {
  it('returns the stored lifecycle_state verbatim for terminal states', () => {
    for (const s of [
      'completed-clean',
      'completed-error',
      'killed-by-operator',
      'killed-by-system',
      'crashed',
    ] as const) {
      expect(deriveLifecycleState({ lifecycle_state: s }, NOW)).toBe(s);
    }
  });

  it('returns dispatched/running verbatim with a recent heartbeat', () => {
    const recent = isoMinutesAgo(2);
    expect(deriveLifecycleState({ lifecycle_state: 'running', last_activity_at: recent }, NOW)).toBe('running');
    expect(deriveLifecycleState({ lifecycle_state: 'dispatched', last_activity_at: recent }, NOW)).toBe('dispatched');
  });

  it('returns the orchestrator value when no heartbeat history yet (fresh dispatch)', () => {
    // A job that just dispatched may have no last_activity_at and no
    // started_at on the slim input — orchestrator value wins.
    expect(deriveLifecycleState({ lifecycle_state: 'dispatched' }, NOW)).toBe('dispatched');
    expect(deriveLifecycleState({ lifecycle_state: 'running' }, NOW)).toBe('running');
  });

  it('returns stale when running/dispatched but heartbeat is older than threshold', () => {
    const oldMinutes = STALE_THRESHOLD_MS / 60_000 + 5;
    const aged = isoMinutesAgo(oldMinutes);
    expect(deriveLifecycleState({ lifecycle_state: 'running', last_activity_at: aged }, NOW)).toBe('stale');
    expect(deriveLifecycleState({ lifecycle_state: 'dispatched', last_activity_at: aged }, NOW)).toBe('stale');
  });

  it('returns stale for the May-15 zombie shape — running, no heartbeat, started long ago', () => {
    // BOM v0.6.6 footgun #4 carried forward to jobs: no last_activity_at +
    // started_at older than STALE_THRESHOLD_MS → stale, not running.
    const s = deriveLifecycleState(
      { lifecycle_state: 'running', started_at: '2026-05-15T08:00:00Z' },
      NOW,
    );
    expect(s).toBe('stale');
  });

  it('does NOT mark stale when running/dispatched + no heartbeat + fresh started_at', () => {
    // Just-dispatched, no heartbeat yet, started seconds ago — still running.
    const s = deriveLifecycleState(
      { lifecycle_state: 'dispatched', started_at: isoMinutesAgo(0.5) },
      NOW,
    );
    expect(s).toBe('dispatched');
  });

  it('falls back to running when lifecycle_state is missing / garbage', () => {
    // Bad input — derivation defaults to 'running' rather than throwing,
    // so a dashboard render never crashes on a malformed row.
    expect(deriveLifecycleState({}, NOW)).toBe('running');
    expect(deriveLifecycleState({ lifecycle_state: 'bogus' }, NOW)).toBe('running');
    expect(deriveLifecycleState({ lifecycle_state: null }, NOW)).toBe('running');
  });
});

describe('isValidJobLifecycleState', () => {
  it('accepts every member of the JobLifecycleState union', () => {
    const all: JobLifecycleState[] = [
      'dispatched', 'running',
      'completed-clean', 'completed-error',
      'killed-by-operator', 'killed-by-system',
      'crashed', 'stale',
    ];
    for (const s of all) {
      expect(isValidJobLifecycleState(s)).toBe(true);
    }
  });

  it('rejects the legacy worker `starting` synonym', () => {
    // JobRecord uses `dispatched` instead of `starting`. The validator
    // treats `starting` as invalid so legacy DB rows that pre-date the
    // rename don't silently slip through.
    expect(isValidJobLifecycleState('starting')).toBe(false);
  });

  it('rejects unknown strings', () => {
    expect(isValidJobLifecycleState('bogus')).toBe(false);
    expect(isValidJobLifecycleState('')).toBe(false);
  });
});

describe('isCurrentlyActive', () => {
  const states: Array<[JobLifecycleState, boolean]> = [
    ['dispatched', true],
    ['running', true],
    ['stale', false], // BOM §1: stale is NOT active — that's the lie we're fixing
    ['completed-clean', false],
    ['completed-error', false],
    ['killed-by-operator', false],
    ['killed-by-system', false],
    ['crashed', false],
  ];

  it.each(states)('%s -> active=%s', (state, expected) => {
    expect(isCurrentlyActive(state)).toBe(expected);
  });
});

describe('isHistoric', () => {
  it('treats completed/killed/crashed as historic', () => {
    expect(isHistoric('completed-clean')).toBe(true);
    expect(isHistoric('completed-error')).toBe(true);
    expect(isHistoric('killed-by-operator')).toBe(true);
    expect(isHistoric('killed-by-system')).toBe(true);
    expect(isHistoric('crashed')).toBe(true);
  });

  it('does NOT treat running/dispatched/stale as historic', () => {
    expect(isHistoric('running')).toBe(false);
    expect(isHistoric('dispatched')).toBe(false);
    expect(isHistoric('stale')).toBe(false); // stale gets its own bucket
  });
});

describe('halo + label visual semantics', () => {
  it('killed-by-operator has its own halo distinct from crash/system-kill', () => {
    // BOM §5 + hard rule #6: operator kill MUST be visually distinct.
    expect(lifecycleHalo('killed-by-operator')).toBe('operator');
    expect(lifecycleHalo('killed-by-system')).toBe('crit');
    expect(lifecycleHalo('crashed')).toBe('crit');
  });

  it('active states share the ok halo', () => {
    expect(lifecycleHalo('dispatched')).toBe('ok');
    expect(lifecycleHalo('running')).toBe('ok');
  });

  it('stale is warn (not crit) — it is a flag, not a kill', () => {
    // BOM open question §1 conservative default.
    expect(lifecycleHalo('stale')).toBe('warn');
  });

  it('every lifecycle state has a non-empty label', () => {
    const all: JobLifecycleState[] = [
      'dispatched', 'running',
      'completed-clean', 'completed-error',
      'killed-by-operator', 'killed-by-system',
      'crashed', 'stale',
    ];
    for (const s of all) {
      expect(lifecycleLabel(s)).toMatch(/\w+/);
    }
  });

  it('labels for killed-by-operator and completed-clean read distinctly', () => {
    expect(lifecycleLabel('killed-by-operator')).not.toBe(lifecycleLabel('completed-clean'));
    expect(lifecycleLabel('killed-by-operator')).toMatch(/operator/i);
    expect(lifecycleLabel('completed-clean')).toMatch(/clean/i);
  });
});
