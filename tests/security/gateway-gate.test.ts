/**
 * family-son-mcp Phase 5 Phase 2 — unit tests for `gateAnthropicGatewayCall`.
 *
 * The HTTP integration in `tests/transports/anthropic-gateway.test.ts`
 * exercises the route handler end-to-end via fetch on 127.0.0.1, which
 * stamps the actor as `loopback:<corrId>` (operator-shape). To exercise
 * the actor-permissions layer's default-deny path for a non-operator
 * `peer:*` actor we wrap the gate call in `logContext.run({...})`
 * directly — equivalent to what the upstream middleware would have set
 * had the request arrived from a paired remote actor.
 *
 * BOM proposed/family-son-mcp-phase-5-llm-gateway-bom.md Phase 2.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { logContext } from '../../src/observability/logger.js';
import { gateAnthropicGatewayCall, GATEWAY_TOOL_ID } from '../../src/security/gateway-gate.js';
import { getOrCreateActorPermissionStore, getOrCreateCapabilityOverrideStore } from '../../src/server.js';

interface Harness {
  store: EventStore;
  broker: Broker;
}

function boot(): Harness {
  const store = new EventStore();
  store.init(':memory:');
  const broker = new Broker(store);
  return { store, broker };
}

const METADATA = { model: 'claude-opus-4-7', message_count: 1, max_tokens: 16 };

describe('gateAnthropicGatewayCall', () => {
  let h: Harness;
  beforeEach(() => {
    h = boot();
  });
  afterEach(() => {
    h.store.close();
  });

  it('GATEWAY_TOOL_ID is "llm.anthropic"', () => {
    expect(GATEWAY_TOOL_ID).toBe('llm.anthropic');
  });

  it('peer actor with NO matrix row → allowed=false (default-deny via actor-permissions)', async () => {
    const verdict = await logContext.run({ actor_id: 'peer:son-test' }, () =>
      gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.actor).toBe('peer:son-test');
    expect(verdict.tool_id).toBe('llm.anthropic');
    expect(verdict.reason).toMatch(/NO_GO/);
    expect(verdict.reason).toMatch(/peer:son-test/);
  });

  it('peer actor with AUTO matrix row → allowed=true', async () => {
    const perms = getOrCreateActorPermissionStore(h.broker);
    perms.set('peer:son-test', GATEWAY_TOOL_ID, 'AUTO', 'operator');

    const verdict = await logContext.run({ actor_id: 'peer:son-test' }, () =>
      gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.actor).toBe('peer:son-test');
    expect(verdict.tool_id).toBe('llm.anthropic');
  });

  it('peer actor with NO_GO matrix row → allowed=false (explicit per-actor NO_GO)', async () => {
    const perms = getOrCreateActorPermissionStore(h.broker);
    perms.set('peer:son-test', GATEWAY_TOOL_ID, 'NO_GO', 'operator');

    const verdict = await logContext.run({ actor_id: 'peer:son-test' }, () =>
      gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/NO_GO/);
    expect(verdict.reason).toMatch(/peer:son-test/);
  });

  it('Layer 0 capability disable wins over any matrix row', async () => {
    const perms = getOrCreateActorPermissionStore(h.broker);
    perms.set('peer:son-test', GATEWAY_TOOL_ID, 'AUTO', 'operator');
    const caps = getOrCreateCapabilityOverrideStore(h.broker);
    caps.disablePermanent(GATEWAY_TOOL_ID, { reason: 'operator killswitch — Anthropic gateway paused', setBy: 'operator' });

    const verdict = await logContext.run({ actor_id: 'peer:son-test' }, () =>
      gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/Anthropic gateway paused|killswitch|disabled permanently/);
  });

  it('loopback actor (operator-shape) with no row → falls through to default tier (test-bypass auto-approves CONFIRM)', async () => {
    // loopback:* is operator-shape → defaultTierFor('llm.anthropic') returns
    // CONFIRM (categories.ts fallback). runChokepointDecision sees the
    // vitest test-bypass (STAVR_CHOKEPOINT_TEST_AUTO_APPROVE=1 +
    // VITEST=true, both held by tests/setup.ts) and approves without
    // opening a real operator decision. End result: allowed=true.
    const verdict = await logContext.run({ actor_id: 'loopback:test-corr' }, () =>
      gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.actor).toBe('loopback:test-corr');
  });

  it('fallback actor matches the chokepoint gate (unstamped-loopback) when logContext has no actor_id', async () => {
    // gateway-gate intentionally mirrors decision-gate's fallback so the
    // actor we report back to the HTTP caller is the SAME identity the
    // chokepoint authorized. unstamped-loopback IS operator-shape, so it
    // falls through to defaultTierFor('llm.anthropic')=CONFIRM and the
    // test-bypass approves it.
    const verdict = await gateAnthropicGatewayCall(h.broker, { request_metadata: METADATA });
    expect(verdict.actor).toBe('unstamped-loopback');
    expect(verdict.allowed).toBe(true);
  });
});
