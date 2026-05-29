/**
 * tests/trust/grant-resolve.test.ts
 *
 * worker-dispatch Phase 4 — TrustStore.resolveGrant + decrementBudget.
 * Covers every GrantDenialReason + the atomic concurrent-decrement
 * pattern that the JobOrchestrator gate relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { TrustStore } from '../../src/trust/store.js';
import type { ProposeInput, TrustScope } from '../../src/trust/types.js';

let store: EventStore;
let trustStore: TrustStore;

beforeEach(() => {
  store = new EventStore();
  store.init(':memory:');
  trustStore = new TrustStore(store);
});

afterEach(() => {
  store.close();
});

/** Create + grant a Phase-4 scope in a single call. Returns the active scope. */
function makeGrant(over: Partial<ProposeInput> = {}): TrustScope {
  const proposal = trustStore.createProposal({
    title: over.title ?? 'test grant',
    description: over.description ?? 'test',
    allowed_actions: over.allowed_actions ?? [{ tool: 'job_dispatch' }],
    expires_at: over.expires_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    expires_after_actions: over.expires_after_actions,
    spec_url: over.spec_url,
    actor_id: over.actor_id,
    covered_tools: over.covered_tools,
    covered_targets: over.covered_targets,
    budget_remaining: over.budget_remaining,
  });
  const granted = trustStore.grant(proposal.id, 'test-operator')!;
  // grant() bumps the expires_at when the proposal's expiry already passed
  // at grant time (defensive — keeps newly-granted scopes alive for at
  // least the declared TTL). For tests that need an EXPIRED active grant
  // shape (lazy-promote coverage), restore the operator-supplied
  // expires_at by direct DB write so we exercise the right code path.
  if (over.expires_at !== undefined && over.expires_at !== granted.expires_at) {
    store.rawDb
      .prepare(`UPDATE trust_scopes SET expires_at = ? WHERE id = ?`)
      .run(over.expires_at, granted.id);
    return trustStore.get(granted.id)!;
  }
  return granted;
}

describe('TrustStore.resolveGrant — explicit grant_id path (peer:*)', () => {
  it('returns kind=real on a valid grant for the requesting peer', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
      budget_remaining: 5,
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r.kind).toBe('real');
    if (r.kind !== 'real') throw new Error('unreachable');
    expect(r.grant_id).toBe(scope.id);
    expect(r.budget_before).toBe(5);
  });

  it('returns grant_required when peer:* dispatches with no grant_id', () => {
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r).toEqual({ kind: 'denied', reason: 'grant_required' });
  });

  it('returns grant_not_found for a non-existent grant_id', () => {
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: 'ts-does-not-exist',
    });
    expect(r).toEqual({ kind: 'denied', reason: 'grant_not_found', grant_id: 'ts-does-not-exist' });
  });

  it('returns grant_not_for_actor when peer:alice passes peer:bobs grant_id', () => {
    const scope = makeGrant({
      actor_id: 'peer:bob',
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'grant_not_for_actor', grant_id: scope.id });
  });

  it('returns tool_not_covered when grant.covered_tools does not include the MCP tool', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['job_inject'], // does NOT cover job_dispatch
      covered_targets: ['claude-code-subprocess'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'tool_not_covered', grant_id: scope.id });
  });

  it('returns target_not_covered when grant.covered_targets does not include the binding_target', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['job_dispatch'],
      covered_targets: ['ollama-local'], // does NOT cover claude-code-subprocess
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'target_not_covered', grant_id: scope.id });
  });

  it('returns grant_expired for a grant whose wall-clock expiry has passed (with lazy-promote)', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'grant_expired', grant_id: scope.id });
    // Lazy-promoted to expired status — same pattern as findActiveScopeFor.
    expect(trustStore.get(scope.id)?.status).toBe('expired');
  });

  it('returns grant_revoked for a revoked grant', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    trustStore.revoke(scope.id);
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'grant_revoked', grant_id: scope.id });
  });

  it('empty covered_tools=[] fails-closed (does NOT match anything)', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: [], // explicit fail-closed
      covered_targets: ['*'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'tool_not_covered', grant_id: scope.id });
  });

  it('empty covered_targets=[] fails-closed', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: [], // explicit fail-closed
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r).toEqual({ kind: 'denied', reason: 'target_not_covered', grant_id: scope.id });
  });

  it('back-compat: NULL covered_tools / covered_targets on a pre-Phase-4 grant matches anything', () => {
    // A pre-Phase-4-shaped grant: actor_id NULL, covered_* NULL — treated
    // as global capability with wildcard coverage. Caller still has to
    // pass the grant_id explicitly because peer:* path requires it.
    const scope = makeGrant({
      // no actor_id (global)
      // no covered_tools (NULL → wildcard)
      // no covered_targets (NULL → wildcard)
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r.kind).toBe('real');
  });

  it('explicit "*" membership in covered_tools matches any tool', () => {
    const scope = makeGrant({
      actor_id: 'peer:alice',
      covered_tools: ['*'],
      covered_targets: ['claude-code-subprocess'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'peer:alice',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
      grant_id: scope.id,
    });
    expect(r.kind).toBe('real');
  });
});

describe('TrustStore.resolveGrant — operator-shape auto-resolve path', () => {
  it('returns kind=sentinel for unstamped-loopback with no covering grant', () => {
    const r = trustStore.resolveGrant({
      actor_id: 'unstamped-loopback',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r).toEqual({ kind: 'sentinel' });
  });

  it('returns kind=sentinel for KNOWN_ACTORS with no covering grant', () => {
    for (const actor of ['operator', 'cowork-claude', 'cc', 'steward']) {
      const r = trustStore.resolveGrant({
        actor_id: actor,
        tool: 'job_dispatch',
        binding_target: 'claude-code-subprocess',
      });
      expect(r, actor).toEqual({ kind: 'sentinel' });
    }
  });

  it('returns kind=sentinel for loopback:<corr> stamped actors with no covering grant', () => {
    const r = trustStore.resolveGrant({
      actor_id: 'loopback:abc-corr-1',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r).toEqual({ kind: 'sentinel' });
  });

  it('auto-resolves to a global grant (actor_id NULL) when one matches', () => {
    const scope = makeGrant({
      // actor_id NULL — global capability
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
      budget_remaining: 3,
    });
    const r = trustStore.resolveGrant({
      actor_id: 'operator',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r.kind).toBe('real');
    if (r.kind !== 'real') throw new Error('unreachable');
    expect(r.grant_id).toBe(scope.id);
    expect(r.budget_before).toBe(3);
  });

  it('auto-resolves to an actor-specific grant when one matches', () => {
    // Operator can be a target of an explicit actor_id binding too.
    const scope = makeGrant({
      actor_id: 'operator',
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'operator',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r.kind).toBe('real');
    if (r.kind !== 'real') throw new Error('unreachable');
    expect(r.grant_id).toBe(scope.id);
  });

  it('skips grants bound to a different actor when auto-resolving', () => {
    makeGrant({
      actor_id: 'cc', // bound to cc, not operator
      covered_tools: ['*'],
      covered_targets: ['*'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'operator',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    // operator can't see cc's grant — falls through to sentinel
    expect(r).toEqual({ kind: 'sentinel' });
  });

  it('skips coverage-mismatched grants when auto-resolving', () => {
    makeGrant({
      covered_tools: ['job_inject'], // doesn't cover job_dispatch
      covered_targets: ['*'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'operator',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r).toEqual({ kind: 'sentinel' });
  });

  it('lazy-promotes time-expired grants during auto-resolve and continues to next', () => {
    const expired = makeGrant({
      covered_tools: ['*'],
      covered_targets: ['*'],
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    // Add a second, still-active grant to verify the iteration continues.
    const live = makeGrant({
      covered_tools: ['job_dispatch'],
      covered_targets: ['claude-code-subprocess'],
    });
    const r = trustStore.resolveGrant({
      actor_id: 'operator',
      tool: 'job_dispatch',
      binding_target: 'claude-code-subprocess',
    });
    expect(r.kind).toBe('real');
    if (r.kind !== 'real') throw new Error('unreachable');
    expect(r.grant_id).toBe(live.id);
    // First grant was lazy-promoted.
    expect(trustStore.get(expired.id)?.status).toBe('expired');
  });
});

describe('TrustStore.decrementBudget', () => {
  it('decrements budget by 1 on a budgeted grant', () => {
    const scope = makeGrant({ budget_remaining: 5 });
    const r = trustStore.decrementBudget(scope.id);
    expect(r).toEqual({ ok: true, budget_after: 4 });
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(4);
  });

  it('returns ok with null budget_after for an unbudgeted (NULL) grant', () => {
    const scope = makeGrant({ /* no budget_remaining */ });
    const r = trustStore.decrementBudget(scope.id);
    expect(r).toEqual({ ok: true, budget_after: null });
    expect(trustStore.get(scope.id)?.budget_remaining).toBeUndefined();
  });

  it('returns budget_exhausted when budget_remaining = 0', () => {
    const scope = makeGrant({ budget_remaining: 0 });
    const r = trustStore.decrementBudget(scope.id);
    expect(r).toEqual({ ok: false, reason: 'budget_exhausted' });
  });

  it('returns grant_not_found for a non-existent grant_id', () => {
    const r = trustStore.decrementBudget('ts-does-not-exist');
    expect(r).toEqual({ ok: false, reason: 'grant_not_found' });
  });

  it('returns grant_expired and lazy-promotes when wall-clock passes between resolve and decrement', () => {
    const scope = makeGrant({
      budget_remaining: 5,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const r = trustStore.decrementBudget(scope.id);
    expect(r).toEqual({ ok: false, reason: 'grant_expired' });
    expect(trustStore.get(scope.id)?.status).toBe('expired');
  });

  it('returns grant_revoked when grant is revoked', () => {
    const scope = makeGrant({ budget_remaining: 5 });
    trustStore.revoke(scope.id);
    const r = trustStore.decrementBudget(scope.id);
    expect(r).toEqual({ ok: false, reason: 'grant_revoked' });
  });

  it('atomic: N parallel decrements on a grant with budget=N/2 — exactly N/2 succeed', async () => {
    // The operator's lock #5/atomic test pattern: fire 2*N concurrent
    // decrements via Promise.all on a grant with budget=N; assert exactly
    // N return ok and exactly N return budget_exhausted; assert final
    // stored budget = 0.
    const N = 10;
    const scope = makeGrant({ budget_remaining: N });

    const results = await Promise.all(
      Array.from({ length: N * 2 }, () =>
        Promise.resolve(trustStore.decrementBudget(scope.id)),
      ),
    );
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(N);
    expect(failures).toHaveLength(N);
    // Every failure was budget_exhausted (none was grant_not_found / etc).
    for (const f of failures) {
      if (f.ok) throw new Error('unreachable');
      expect(f.reason).toBe('budget_exhausted');
    }
    // Final state: budget zeroed exactly.
    expect(trustStore.get(scope.id)?.budget_remaining).toBe(0);
  });
});
