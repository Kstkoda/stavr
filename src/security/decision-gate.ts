/**
 * Chokepoint decision gate (Phase 2 of family-mode-phase-1).
 *
 * Routes a CONFIRM- or EXPLICIT-tier tool call through an `await_decision`
 * cycle on the broker. Used by the structural chokepoint in `server.ts` —
 * NOT by `gatedAction()`, which has its own scope-aware path. The two paths
 * coexist: gatedAction stays as the rich path for github-writes / trust
 * scopes (no-go, scope short-circuit, success-event mirroring); this helper
 * is the lean path the chokepoint uses for every tool the per-actor tier
 * matrix flags as CONFIRM / EXPLICIT.
 *
 * Phase 3 will layer a WebAuthn assertion check on top for EXPLICIT — that
 * check belongs HERE (or in a small wrapper around this), not at the call
 * site.
 *
 * Test seam (defense-in-depth, post-Phase-2 hardening): the bypass requires
 * BOTH conditions to be true to fire:
 *   1. STAVR_CHOKEPOINT_TEST_AUTO_APPROVE === '1'
 *   2. `isTestRun()` returns true (process.env.VITEST === 'true' or
 *      NODE_ENV === 'test')
 *
 * Setting only the env var (e.g., a malicious or accidental production
 * setting) does NOT enable the bypass — the gate runs the real decision
 * route. A boot-time guard in `src/daemon.ts` ALSO refuses to start the
 * daemon when the env var is set without the test signal, so the seam
 * cannot silently take effect in production at any layer. Every actual
 * bypass emits a `decision_chokepoint_test_bypass` audit event carrying
 * actor + tool + tier so its use is never silent. The vitest setup file
 * (`tests/setup.ts`) is what enables it for the ~30 existing tests that
 * exercise CONFIRM-tier tools; the negative-path tests in
 * `tests/security/chokepoint.test.ts` clear the env var inside beforeEach
 * to exercise the real decision route.
 */
import { randomUUID } from 'node:crypto';
import type { Broker } from '../broker.js';
import { DecisionTimeoutError } from '../persistence.js';
import type { Tier } from '../tools/categories.js';
import { APPROVE, REJECT } from '../tools/gated-action.js';
import type { RuntimeToolGate } from '../tools/registry.js';
import { checkNoGo } from '../trust/no-go-list.js';
import { logContext } from '../observability/logger.js';
import type { ActorPermissionStore } from './actor-permissions.js';
import type { CapabilityOverrideStore } from './capability-overrides.js';

const DEFAULT_TIMEOUT_SEC = 1800;
export const TEST_AUTO_APPROVE_ENV = 'STAVR_CHOKEPOINT_TEST_AUTO_APPROVE';

/**
 * Returns true iff the process is running inside a known test harness.
 * Vitest sets `VITEST=true` automatically; `NODE_ENV=test` is the broader
 * Node convention. Either signal is sufficient — the bypass guard checks
 * `isTestRun()` to refuse activation outside these conditions, and the
 * daemon boot guard in `src/daemon.ts` refuses to start when
 * `STAVR_CHOKEPOINT_TEST_AUTO_APPROVE` is set without it.
 */
export function isTestRun(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

/**
 * Returns true iff the test-only bypass is active in this process. Combines
 * the env-var opt-in with the test-mode signal — both must hold.
 */
export function isChokepointTestBypassActive(): boolean {
  return process.env[TEST_AUTO_APPROVE_ENV] === '1' && isTestRun();
}

export interface ChokepointDecisionOpts {
  toolId: string;
  actor: string;
  tier: Extract<Tier, 'CONFIRM' | 'EXPLICIT'>;
  args: unknown;
  timeoutSec?: number;
}

export interface ChokepointDecisionResult {
  allowed: boolean;
  reason?: string;
  correlation_id: string;
}

export async function runChokepointDecision(
  broker: Broker,
  opts: ChokepointDecisionOpts,
): Promise<ChokepointDecisionResult> {
  const correlationId = randomUUID();
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

  // Documented test-mode escape. Fires only when BOTH the env var AND the
  // test-run signal hold (see isChokepointTestBypassActive). A bare env
  // var set in production cannot enable it — and the daemon boot guard
  // refuses to start when that misconfiguration is present, so even a
  // mistaken set is caught loudly. Every bypass emits an audit event
  // carrying actor + tool + tier; the negative-path tests in
  // tests/security/chokepoint.test.ts clear the env var to exercise the
  // real decision route.
  if (isChokepointTestBypassActive()) {
    await broker.publish({
      kind: 'decision_chokepoint_test_bypass',
      at: new Date().toISOString(),
      correlation_id: correlationId,
      source_agent: opts.actor,
      payload: {
        tool: opts.toolId,
        tier: opts.tier,
        args: opts.args,
      },
    });
    return { allowed: true, correlation_id: correlationId };
  }

  const question = `Approve ${opts.toolId} call (tier=${opts.tier}, actor=${opts.actor})?`;
  const options = [
    { id: APPROVE, label: 'Approve' },
    { id: REJECT, label: 'Reject' },
  ];

  broker.store.createDecision(correlationId, question, options, timeoutSec, REJECT);

  await broker.publish({
    kind: 'decision_request',
    at: new Date().toISOString(),
    correlation_id: correlationId,
    source_agent: opts.actor,
    payload: {
      question,
      options,
      default_option_id: REJECT,
      deadline_seconds: timeoutSec,
      gate_source: 'chokepoint',
      tool: opts.toolId,
      tier: opts.tier,
    },
  });

  let chosen: string;
  let responder = 'unknown';
  try {
    const resp = await broker.store.awaitDecisionResponse(correlationId, timeoutSec * 1000);
    chosen = resp.chosen_option_id;
    responder = resp.responder;
  } catch (err) {
    if (!(err instanceof DecisionTimeoutError)) throw err;
    const fb = broker.store.respondToDecision(
      correlationId,
      REJECT,
      'timeout fallback',
      'switch-default',
    );
    if (fb.ok) {
      await broker.publish({
        kind: 'decision_response',
        at: fb.result.responded_at,
        correlation_id: correlationId,
        source_agent: 'switch-default',
        payload: {
          chosen_option_id: REJECT,
          reason: 'timeout fallback',
          responder: 'switch-default',
        },
      });
      chosen = REJECT;
      responder = 'switch-default';
    } else {
      const current = broker.store.getDecision(correlationId);
      chosen = current?.chosen_option_id ?? REJECT;
    }
  }

  if (chosen === APPROVE) return { allowed: true, correlation_id: correlationId };
  return {
    allowed: false,
    reason: `chokepoint denied: ${opts.tier}-tier decision was ${chosen} (responder=${responder})`,
    correlation_id: correlationId,
  };
}

/**
 * Build the structural chokepoint gate. This is what `wrapServerForRegistry`
 * runs before every tool handler — see `src/server.ts`. Extracted into this
 * module so it has one canonical owner and a stable surface for the
 * chokepoint integration test in `tests/security/chokepoint.test.ts`.
 *
 * Layer order (top denies first):
 *   1. No-Go list                  — identity-blind hard deny
 *   2. Layer 0 capability switch   — operator runtime kill switch
 *   3. Per-actor permission tier   — AUTO / CONFIRM / EXPLICIT / NO_GO
 *
 * The gate reads the calling actor from `logContext.actor_id`
 * (AsyncLocalStorage). HTTP middleware stamps it per request; stdio falls
 * through to `'unstamped-loopback'` and the per-actor matrix resolves via
 * `defaultTierFor()` against the conservative bias in `categories.ts`.
 */
export function buildChokepointGate(
  broker: Broker,
  stores: {
    capability: CapabilityOverrideStore;
    actorPermissions: ActorPermissionStore;
  },
): RuntimeToolGate {
  return {
    async check(
      toolId: string,
      args: unknown,
    ): Promise<{ allowed: boolean; reason?: string }> {
      const ctx = logContext.getStore();
      const actor = ctx?.actor_id ?? 'unstamped-loopback';

      // Layer 1 — No-Go list (identity-blind hard deny).
      const noGo = checkNoGo(toolId, args);
      if (noGo) {
        await broker.publish({
          kind: 'no_go_match',
          at: new Date().toISOString(),
          source_agent: actor,
          payload: {
            entry_id: noGo.id,
            tool: toolId,
            args,
            severity: noGo.severity,
            reason: noGo.reason,
          },
        });
        return {
          allowed: false,
          reason: `no-go floor: ${noGo.description} — ${noGo.reason}`,
        };
      }

      // Layer 2 — capability master switch (operator runtime kill).
      const cap = stores.capability.check(toolId);
      if (!cap.allowed) {
        return { allowed: false, reason: cap.reason };
      }

      // Layer 3 — per-actor permission tier.
      const resolved = stores.actorPermissions.resolve(actor, toolId);
      switch (resolved.tier) {
        case 'AUTO':
          return { allowed: true };
        case 'NO_GO':
          return {
            allowed: false,
            reason:
              `per-actor NO_GO: actor "${actor}" cannot invoke ${toolId} ` +
              `(source=${resolved.source})`,
          };
        case 'CONFIRM':
        case 'EXPLICIT': {
          const result = await runChokepointDecision(broker, {
            toolId,
            actor,
            tier: resolved.tier,
            args,
          });
          if (result.allowed) return { allowed: true };
          return {
            allowed: false,
            reason: result.reason ?? `chokepoint decision denied for ${toolId}`,
          };
        }
      }
    },
  };
}
