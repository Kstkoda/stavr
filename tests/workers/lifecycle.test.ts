/**
 * tests/workers/lifecycle.test.ts
 *
 * Coverage for the derived-state helpers introduced in BOM v0.6.6 P1.
 *
 * The 2026-05-17 E2E session is the reference dataset — the helpers exist
 * so the Helm/Topology/Streams pages stop counting May-15 zombies as if
 * they were currently running. Every permutation here either replays a
 * row shape from that session or fills in a state transition that the
 * BOM open-question §1-§4 conservative defaults require.
 */
import { describe, expect, it } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  deriveLifecycleState,
  isCurrentlyActive,
  isHistoric,
  lifecycleHalo,
  lifecycleLabel,
  type LifecycleState,
} from '../../src/workers/lifecycle.js';

// Anchor time chosen so tests are fully deterministic regardless of when
// the suite runs. NOTE: deriveLifecycleState's `now` argument is the
// single point we read "current time" from.
const NOW = Date.parse('2026-05-17T22:00:00Z');

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

describe('deriveLifecycleState', () => {
  it('returns starting for status=starting', () => {
    expect(deriveLifecycleState({ status: 'starting' }, NOW)).toBe('starting');
  });

  it('returns running when status=running with recent heartbeat', () => {
    const s = deriveLifecycleState(
      { status: 'running', last_activity_at: isoMinutesAgo(2) },
      NOW,
    );
    expect(s).toBe('running');
  });

  it('returns running when status=running with no heartbeat yet', () => {
    // A worker that just spawned may have no last_activity_at; the
    // orchestrator's status='running' should be authoritative.
    expect(deriveLifecycleState({ status: 'running' }, NOW)).toBe('running');
  });

  it('returns stale when status=running but heartbeat is older than threshold', () => {
    const oldMinutes = STALE_THRESHOLD_MS / 60_000 + 5;
    const s = deriveLifecycleState(
      { status: 'running', last_activity_at: isoMinutesAgo(oldMinutes) },
      NOW,
    );
    expect(s).toBe('stale');
  });

  it('returns stale for status=idle with no heartbeat', () => {
    // Per BOM footgun #4 — May-15 zombies look exactly like this.
    expect(deriveLifecycleState({ status: 'idle' }, NOW)).toBe('stale');
  });

  it('returns stale for status=idle with old heartbeat', () => {
    const s = deriveLifecycleState(
      { status: 'idle', last_activity_at: isoMinutesAgo(120) },
      NOW,
    );
    expect(s).toBe('stale');
  });

  it('returns completed-clean for terminated rows with reason=completed and exit_code=0', () => {
    const s = deriveLifecycleState(
      {
        status: 'terminated',
        termination_reason: 'completed',
        exit_code: 0,
        ended_at: isoMinutesAgo(5),
      },
      NOW,
    );
    expect(s).toBe('completed-clean');
  });

  it('returns completed-clean when terminated with reason=completed and exit_code is undefined', () => {
    const s = deriveLifecycleState(
      { status: 'terminated', termination_reason: 'completed' },
      NOW,
    );
    expect(s).toBe('completed-clean');
  });

  it('returns completed-error for terminated rows with reason=completed and non-zero exit_code', () => {
    const s = deriveLifecycleState(
      {
        status: 'terminated',
        termination_reason: 'completed',
        exit_code: 137, // SIGKILL exit shape, but persisted as completed
      },
      NOW,
    );
    expect(s).toBe('completed-error');
  });

  it('returns killed-by-operator for terminated rows with reason=terminated_by_user', () => {
    // BOM hard rule #6: operator-initiated termination MUST be visually
    // distinct from clean-completed. The lifecycle bucket is what carries
    // that distinction through to the pill.
    const s = deriveLifecycleState(
      { status: 'terminated', termination_reason: 'terminated_by_user' },
      NOW,
    );
    expect(s).toBe('killed-by-operator');
  });

  it('returns crashed for status=crashed', () => {
    const s = deriveLifecycleState(
      { status: 'crashed', termination_reason: 'crashed', exit_code: -1 },
      NOW,
    );
    expect(s).toBe('crashed');
  });

  it('returns crashed for status=crashed with no exit_code (segfault-style)', () => {
    const s = deriveLifecycleState({ status: 'crashed' }, NOW);
    expect(s).toBe('crashed');
  });

  it('honors an explicit lifecycle_state when valid', () => {
    // If the orchestrator wrote a value, derivation should NOT second-
    // guess. This is the forward-compatible path: when v0.6.7 hooks up
    // killed-by-system detection, the orchestrator will write it
    // directly and the helpers will pass it through.
    const s = deriveLifecycleState(
      { status: 'crashed', lifecycle_state: 'killed-by-system' },
      NOW,
    );
    expect(s).toBe('killed-by-system');
  });

  it('falls back to derivation if stored lifecycle_state is garbage', () => {
    const s = deriveLifecycleState(
      // @ts-expect-error testing runtime resilience to bad data
      { status: 'terminated', termination_reason: 'completed', lifecycle_state: 'bogus' },
      NOW,
    );
    expect(s).toBe('completed-clean');
  });
});

describe('isCurrentlyActive', () => {
  const states: Array<[LifecycleState, boolean]> = [
    ['starting', true],
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

  it('does NOT treat running/starting/stale as historic', () => {
    expect(isHistoric('running')).toBe(false);
    expect(isHistoric('starting')).toBe(false);
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
    expect(lifecycleHalo('starting')).toBe('ok');
    expect(lifecycleHalo('running')).toBe('ok');
  });

  it('stale is warn (not crit) — it is a flag, not a kill', () => {
    // BOM open question §1 conservative default.
    expect(lifecycleHalo('stale')).toBe('warn');
  });

  it('every lifecycle state has a non-empty label', () => {
    const all: LifecycleState[] = [
      'starting', 'running',
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
