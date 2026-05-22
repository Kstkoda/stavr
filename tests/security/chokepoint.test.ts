/**
 * Phase 2 of family-mode-phase-1 — the BOM's "defining test":
 *
 *   "A tool call that does NOT go through `gatedAction()` must still hit
 *    every check. Negative-path test per layer."
 *
 * We exercise `buildChokepointGate(broker, stores).check(toolId, args)`
 * directly — no MCP server / no `gatedAction` / no subsystem code in the
 * path. The gate is what `wrapServerForRegistry` runs in production
 * (`src/server.ts`), so testing it in isolation proves the chokepoint
 * enforces the layered policy regardless of which tool routes through it.
 *
 * The global test setup (`tests/setup.ts`) sets
 * `STAVR_CHOKEPOINT_TEST_AUTO_APPROVE=1` so existing tests don't hang on
 * the per-actor CONFIRM decision route. This file deletes that env var in
 * its own beforeEach so the real decision route runs — that's the whole
 * point of these cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { CapabilityOverrideStore } from '../../src/security/capability-overrides.js';
import { ActorPermissionStore } from '../../src/security/actor-permissions.js';
import { buildChokepointGate } from '../../src/security/decision-gate.js';
import { APPROVE, REJECT } from '../../src/tools/gated-action.js';
import { logContext } from '../../src/observability/logger.js';

describe('chokepoint gate (Phase 2 — defining test)', () => {
  let store: EventStore;
  let broker: Broker;
  let capability: CapabilityOverrideStore;
  let actorPermissions: ActorPermissionStore;
  let gate: ReturnType<typeof buildChokepointGate>;
  let prevAutoApprove: string | undefined;

  beforeEach(() => {
    // Turn OFF the global test-mode auto-approve so the CONFIRM/EXPLICIT
    // decision route runs for real. Each test that needs approve/reject
    // injects its own response via broker.store.respondToDecision().
    prevAutoApprove = process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;
    delete process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;

    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    capability = new CapabilityOverrideStore(store.rawDb);
    actorPermissions = new ActorPermissionStore(store.rawDb);
    gate = buildChokepointGate(broker, { capability, actorPermissions });
  });

  afterEach(() => {
    store.close();
    if (prevAutoApprove === undefined) {
      delete process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;
    } else {
      process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE = prevAutoApprove;
    }
  });

  describe('Layer 1 — No-Go list (identity-blind hard deny)', () => {
    it('denies a tool call whose args match a no-go pattern, regardless of actor tier', async () => {
      // Pre-grant the actor AUTO for this tool — the no-go layer should still
      // hard-deny BEFORE the per-actor tier is even consulted.
      actorPermissions.set('peer:lan-box', 'Bash', 'AUTO', 'operator');
      // free_text_pattern in no-go-list.ts:38 matches `rm -rf` as a single
      // string — collectStringy walks the args object, so the command
      // string is what we need to hit.
      const result = await logContext.run({ actor_id: 'peer:lan-box' }, () =>
        gate.check('Bash', { command: 'rm -rf /' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/no-go floor/);
    });

    it('emits a no_go_match audit event when a no-go pattern fires', async () => {
      const events: Array<{ kind: string }> = [];
      const tap = (ev: { kind: string }) => events.push(ev);
      const off = broker.onEvent(tap);
      try {
        await logContext.run({ actor_id: 'loopback:test' }, () =>
          gate.check('Bash', { command: 'rm -rf /' }),
        );
      } finally {
        off();
      }
      expect(events.some((e) => e.kind === 'no_go_match')).toBe(true);
    });

    it('lets a non-matching call past the no-go floor', async () => {
      actorPermissions.set('peer:safe', 'emit_event', 'AUTO', 'operator');
      const result = await logContext.run({ actor_id: 'peer:safe' }, () =>
        gate.check('emit_event', { payload: { kind: 'progress' } }),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('Layer 2 — capability master switch', () => {
    it('denies a permanently-disabled tool regardless of actor tier', async () => {
      capability.disablePermanent('worker_spawn', { reason: 'audit pause', setBy: 'operator' });
      actorPermissions.set('peer:trusted', 'worker_spawn', 'AUTO', 'operator');
      const result = await logContext.run({ actor_id: 'peer:trusted' }, () =>
        gate.check('worker_spawn', { name: 'w1' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('audit pause');
    });

    it('runs BEFORE the per-actor tier check (capability deny short-circuits)', async () => {
      // A NO_GO tier would normally produce a per-actor reason; capability
      // disable should fire first so we see the capability reason instead.
      capability.disablePermanent('worker_spawn', { reason: 'capability-deny', setBy: 'operator' });
      actorPermissions.set('peer:x', 'worker_spawn', 'NO_GO', 'operator');
      const result = await logContext.run({ actor_id: 'peer:x' }, () =>
        gate.check('worker_spawn', {}),
      );
      expect(result.reason).toContain('capability-deny');
      expect(result.reason).not.toMatch(/per-actor NO_GO/);
    });
  });

  describe('Layer 3 — per-actor permission tier', () => {
    it('AUTO passes through without opening a decision', async () => {
      actorPermissions.set('peer:auto', 'worker_spawn', 'AUTO', 'operator');
      const result = await logContext.run({ actor_id: 'peer:auto' }, () =>
        gate.check('worker_spawn', {}),
      );
      expect(result.allowed).toBe(true);
    });

    it('NO_GO denies immediately (no decision opened)', async () => {
      actorPermissions.set('peer:locked-out', 'worker_spawn', 'NO_GO', 'operator');
      const result = await logContext.run({ actor_id: 'peer:locked-out' }, () =>
        gate.check('worker_spawn', {}),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/per-actor NO_GO/);
      expect(broker.store.pendingDecisionCount()).toBe(0);
    });

    it('CONFIRM opens an await_decision; APPROVE allows the call', async () => {
      actorPermissions.set('peer:confirm', 'worker_spawn', 'CONFIRM', 'operator');
      // Drive the decision: watch for the decision_request, then approve it.
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          broker.store.respondToDecision(
            ev.correlation_id,
            APPROVE,
            'test approve',
            'user-direct',
          );
        }
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:confirm' }, () =>
          gate.check('worker_spawn', { name: 'w1' }),
        );
        expect(result.allowed).toBe(true);
      } finally {
        off();
      }
    });

    it('CONFIRM opens an await_decision; REJECT denies the call', async () => {
      actorPermissions.set('peer:confirm', 'worker_spawn', 'CONFIRM', 'operator');
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          broker.store.respondToDecision(
            ev.correlation_id,
            REJECT,
            'test reject',
            'user-direct',
          );
        }
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:confirm' }, () =>
          gate.check('worker_spawn', {}),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/chokepoint denied/);
      } finally {
        off();
      }
    });

    it('EXPLICIT routes through the same decision gate as CONFIRM in Phase 2 (WebAuthn lands Phase 3)', async () => {
      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          broker.store.respondToDecision(
            ev.correlation_id,
            APPROVE,
            'test approve',
            'user-direct',
          );
        }
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:explicit' }, () =>
          gate.check('host_exec', { command: 'git', args: ['status'] }),
        );
        expect(result.allowed).toBe(true);
      } finally {
        off();
      }
    });

    it("uses 'unstamped-loopback' when logContext has no actor_id; falls through to defaultTierFor()", async () => {
      // No logContext.run wrapper — actor falls through to the default. The
      // tool 'emit_event' is AUTO by default per categories.ts so it passes.
      const result = await gate.check('emit_event', {});
      expect(result.allowed).toBe(true);
    });
  });

  describe('chokepoint vs gatedAction independence', () => {
    it('a tool that has never called gatedAction() still hits every layer', async () => {
      // emit_event never goes through gatedAction — it's a Layer-0-only AUTO
      // tool today. The chokepoint must still consult no-go and the master
      // switch for it. Prove by disabling it via Layer 0 and watching the
      // gate deny without any gatedAction involvement.
      capability.disablePermanent('emit_event', { reason: 'no-emit during freeze', setBy: 'operator' });
      const result = await gate.check('emit_event', {});
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('no-emit during freeze');
    });
  });
});
