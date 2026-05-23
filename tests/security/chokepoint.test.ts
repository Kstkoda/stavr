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
import { IdentityStore } from '../../src/security/identity-store.js';
import { buildChokepointGate } from '../../src/security/decision-gate.js';
import { APPROVE, REJECT } from '../../src/tools/gated-action.js';
import { logContext } from '../../src/observability/logger.js';

describe('chokepoint gate (Phase 2 — defining test)', () => {
  let store: EventStore;
  let broker: Broker;
  let capability: CapabilityOverrideStore;
  let actorPermissions: ActorPermissionStore;
  let identity: IdentityStore;
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
    identity = new IdentityStore(store.rawDb);
    gate = buildChokepointGate(broker, { capability, actorPermissions, identity });
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
            'unstamped-loopback',
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
            'unstamped-loopback',
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

    it('EXPLICIT denies without a recent WebAuthn assertion (Phase 3 — no decision opens)', async () => {
      // No assertion seeded in the identity store. The Tier-3 layer must
      // refuse the call BEFORE the operator-confirmation decision route.
      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      let sawDecisionRequest = false;
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request') sawDecisionRequest = true;
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:explicit' }, () =>
          gate.check('host_exec', { command: 'git', args: ['status'] }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/EXPLICIT denied/);
        expect(sawDecisionRequest).toBe(false);
        expect(broker.store.pendingDecisionCount()).toBe(0);
      } finally {
        off();
      }
    });

    it('EXPLICIT emits tier3_assertion_required so the dashboard can prompt the operator', async () => {
      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      const events: Array<{ kind: string; payload?: unknown }> = [];
      const off = broker.onEvent((ev) => events.push(ev));
      try {
        await logContext.run({ actor_id: 'peer:explicit' }, () =>
          gate.check('host_exec', { command: 'git', args: ['status'] }),
        );
      } finally {
        off();
      }
      const req = events.find((e) => e.kind === 'tier3_assertion_required');
      expect(req).toBeDefined();
      expect((req?.payload as { tool: string }).tool).toBe('host_exec');
      expect((req?.payload as { operator_id: string }).operator_id).toBe('operator');
    });

    it('EXPLICIT proceeds to the operator-confirmation decision once a recent assertion is on file', async () => {
      // Seed a recent assertion for the default operator.
      const now = Date.now();
      identity.register({
        credentialId: 'cred-test-1',
        operatorId: 'operator',
        publicKey: Buffer.from('test'),
        counter: 0,
        transports: ['internal'],
        deviceLabel: 'test',
      });
      identity.recordAssertion({
        id: 'assertion-test-1',
        operatorId: 'operator',
        credentialId: 'cred-test-1',
        createdAt: now - 1000,
        expiresAt: now + 60_000,
      });

      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          broker.store.respondToDecision(
            ev.correlation_id,
            APPROVE,
            'test approve',
            'unstamped-loopback',
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

    it('EXPLICIT denies if assertion exists but operator rejects the confirmation decision', async () => {
      const now = Date.now();
      identity.register({
        credentialId: 'cred-test-2',
        operatorId: 'operator',
        publicKey: Buffer.from('test'),
        counter: 0,
        transports: ['internal'],
        deviceLabel: 'test',
      });
      identity.recordAssertion({
        id: 'assertion-test-2',
        operatorId: 'operator',
        credentialId: 'cred-test-2',
        createdAt: now - 1000,
        expiresAt: now + 60_000,
      });

      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          broker.store.respondToDecision(
            ev.correlation_id,
            REJECT,
            'operator declined',
            'unstamped-loopback',
          );
        }
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:explicit' }, () =>
          gate.check('host_exec', { command: 'git', args: ['status'] }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/chokepoint denied/);
      } finally {
        off();
      }
    });

    it('EXPLICIT denies once the assertion has aged out of the freshness window', async () => {
      const now = Date.now();
      identity.register({
        credentialId: 'cred-test-stale',
        operatorId: 'operator',
        publicKey: Buffer.from('test'),
        counter: 0,
        transports: ['internal'],
        deviceLabel: 'test',
      });
      // Assertion was created well outside the freshness window — Identity-
      // Store's hasRecentAssertion filters by expires_at > now, so seeding
      // an already-expired assertion is the deterministic way to simulate
      // staleness without manipulating the clock.
      identity.recordAssertion({
        id: 'assertion-stale',
        operatorId: 'operator',
        credentialId: 'cred-test-stale',
        createdAt: now - 600_000,
        expiresAt: now - 1000,
      });
      actorPermissions.set('peer:explicit', 'host_exec', 'EXPLICIT', 'operator');
      const result = await logContext.run({ actor_id: 'peer:explicit' }, () =>
        gate.check('host_exec', {}),
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/EXPLICIT denied/);
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

describe('chokepoint test-bypass seam (Phase 2 hardening)', () => {
  // These tests deliberately do NOT delete the auto-approve env var; the
  // global setup leaves it as '1'. They toggle the test-run signal to
  // prove the bypass is two-key: env var alone does not enable it.
  let store: EventStore;
  let broker: Broker;
  let capability: CapabilityOverrideStore;
  let actorPermissions: ActorPermissionStore;
  let identity: IdentityStore;
  let gate: ReturnType<typeof buildChokepointGate>;
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    capability = new CapabilityOverrideStore(store.rawDb);
    actorPermissions = new ActorPermissionStore(store.rawDb);
    identity = new IdentityStore(store.rawDb);
    gate = buildChokepointGate(broker, { capability, actorPermissions, identity });
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    store.close();
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('emits a decision_chokepoint_test_bypass event each time the bypass fires', async () => {
    expect(process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE).toBe('1');
    // Vitest sets VITEST=true automatically; verify the bypass is active.
    actorPermissions.set('peer:bypass', 'worker_spawn', 'CONFIRM', 'operator');
    const events: Array<{ kind: string; source_agent?: string; payload?: unknown }> = [];
    const off = broker.onEvent((ev) => events.push(ev));
    try {
      const result = await logContext.run({ actor_id: 'peer:bypass' }, () =>
        gate.check('worker_spawn', { name: 'w1' }),
      );
      expect(result.allowed).toBe(true);
    } finally {
      off();
    }
    const bypass = events.find((e) => e.kind === 'decision_chokepoint_test_bypass');
    expect(bypass).toBeDefined();
    expect(bypass?.source_agent).toBe('peer:bypass');
    expect((bypass?.payload as { tool: string }).tool).toBe('worker_spawn');
    expect((bypass?.payload as { tier: string }).tier).toBe('CONFIRM');
  });

  it('does NOT bypass when env var is set but VITEST/NODE_ENV are unset (real decision opens)', async () => {
    // Strip the test-run signal — env var alone must not be enough.
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE).toBe('1');

    actorPermissions.set('peer:strict', 'worker_spawn', 'CONFIRM', 'operator');

    // Drive a real decision — if the bypass were active, no decision would
    // open; the call would resolve instantly without a decision_request
    // event firing.
    let sawDecisionRequest = false;
    const off = broker.onEvent((ev) => {
      if (ev.kind === 'decision_request' && ev.correlation_id) {
        sawDecisionRequest = true;
        broker.store.respondToDecision(ev.correlation_id, REJECT, 'test', 'unstamped-loopback');
      }
    });
    try {
      const result = await logContext.run({ actor_id: 'peer:strict' }, () =>
        gate.check('worker_spawn', {}),
      );
      expect(sawDecisionRequest).toBe(true); // a real decision was opened
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/chokepoint denied/);
    } finally {
      off();
    }
  });

  it('does NOT bypass when env var is unset, even with VITEST=true', async () => {
    const prevEnv = process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;
    delete process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;
    try {
      actorPermissions.set('peer:no-env', 'worker_spawn', 'CONFIRM', 'operator');
      let sawDecisionRequest = false;
      const off = broker.onEvent((ev) => {
        if (ev.kind === 'decision_request' && ev.correlation_id) {
          sawDecisionRequest = true;
          broker.store.respondToDecision(ev.correlation_id, REJECT, 'test', 'unstamped-loopback');
        }
      });
      try {
        const result = await logContext.run({ actor_id: 'peer:no-env' }, () =>
          gate.check('worker_spawn', {}),
        );
        expect(sawDecisionRequest).toBe(true);
        expect(result.allowed).toBe(false);
      } finally {
        off();
      }
    } finally {
      if (prevEnv === undefined) delete process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE;
      else process.env.STAVR_CHOKEPOINT_TEST_AUTO_APPROVE = prevEnv;
    }
  });
});
