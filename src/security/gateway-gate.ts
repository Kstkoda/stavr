/**
 * family-son-mcp Phase 5 Phase 2 — chokepoint gate for the Anthropic
 * LLM gateway endpoint (`POST /anthropic/v1/messages`).
 *
 * The MCP transport composes the chokepoint inside `wrapServerForRegistry`
 * (see `src/server.ts:394-403`). The HTTP gateway route in `src/transports.ts`
 * is NOT an MCP tool, so it doesn't pass through that wrapper — but the
 * authorization invariants are identical, so it reuses the same gate.
 *
 * F3 from the Phase 0 recon (operator-decided 2026-05-27): expose the
 * composed gate from this new file rather than adding a one-off getter to
 * `src/server.ts`. Keeps the seam structurally identifiable and matches
 * the pattern of the other security adapters in this directory
 * (`actor-permissions.ts`, `capability-overrides.ts`, `decision-gate.ts`,
 * `respond-policy.ts`, `tier3-gate.ts`).
 *
 * The getOrCreate*Store() functions in `src/server.ts` are idempotent —
 * the "or create" branch only fires once per broker instance — so
 * composing the gate here returns the SAME store objects the MCP path
 * uses, not duplicates. Matrix rows the operator authors via the
 * dashboard or that the MCP path observes are immediately visible here,
 * and vice versa.
 *
 * Denial shaping is the route handler's responsibility. This module
 * returns a structured `GatewayDecision`; the HTTP layer maps
 * `allowed = false` to `403 + JSON` per the operator's F3-time decision.
 */
import type { Broker } from '../broker.js';
import { buildChokepointGate } from './decision-gate.js';
import {
  getOrCreateActorPermissionStore,
  getOrCreateCapabilityOverrideStore,
  getOrCreateIdentityStore,
} from '../server.js';
import { logContext } from '../observability/logger.js';

/**
 * Canonical tool id under which the Anthropic gateway is gated by the
 * per-actor permissions matrix (`actor_permissions` table).
 *
 * Free-form string per the matrix schema (`src/persistence.ts:597-606`).
 * Lowercase + dotted to match the convention emerging from the tools
 * registry (`github.create_pr`, `worker.spawn`, ...). The dashboard's
 * permissions UI buckets unknown ids under "other" — acceptable for
 * Phase 2; a future polish can add an `'llm'` ToolCategory if surfacing
 * matters more.
 */
export const GATEWAY_TOOL_ID = 'llm.anthropic';

/**
 * Metadata the route handler shapes from the incoming Anthropic request
 * body for chokepoint logging. Audit-safe by design — BOM hard invariant
 * #5: no request body in audit log by default (prompts may contain PII).
 * This shape is the equivalent of an MCP tool call's `args` and is what
 * a future `decision_request` payload would reference; no content here.
 */
export interface GatewayRequestMetadata {
  model?: unknown;
  message_count?: number;
  max_tokens?: unknown;
}

export interface GatewayDecision {
  allowed: boolean;
  reason?: string;
  /** The actor id resolved from `logContext.actor_id`. Stamped by the
   *  upstream middleware in `src/transports.ts:526-536`. */
  actor: string;
  /** Always {@link GATEWAY_TOOL_ID} — surfaced so the caller can echo it
   *  back in the denial body without re-importing the constant. */
  tool_id: string;
}

/**
 * Run the Anthropic-gateway request through the same chokepoint the MCP
 * transport applies to tool calls. Returns a structured verdict; the
 * caller is responsible for mapping `allowed = false` to an HTTP response
 * (the gateway route uses 403 + JSON per the F3 design call).
 *
 * NOTE: For `CONFIRM`-tier matrix rows this will block for up to
 * `DEFAULT_TIMEOUT_SEC` (1800s) awaiting operator approval —
 * `runChokepointDecision` opens a real decision and awaits it. The son's
 * HTTP client will time out long before; that is the canonical and
 * intended chokepoint behavior. For `AUTO` this returns immediately.
 * For `EXPLICIT` the operator must produce a fresh WebAuthn assertion
 * (`tier3-gate.ts`), which is not generally possible for a remote son
 * — `EXPLICIT @ llm.anthropic` for a peer actor is effectively a
 * structurally-enforced operator-only tier.
 */
export async function gateAnthropicGatewayCall(
  broker: Broker,
  args: { request_metadata: GatewayRequestMetadata },
): Promise<GatewayDecision> {
  // Mirror `buildChokepointGate`'s fallback (decision-gate.ts:224) so the
  // actor we report back to the HTTP caller is the SAME identity the
  // chokepoint actually authorized. On HTTP the actor-stamping middleware
  // (`transports.ts:526-536`) always sets an actor_id; this fallback only
  // matters for direct unit-test invocation that doesn't wrap the call in
  // `logContext.run(...)`.
  const actor = logContext.getStore()?.actor_id ?? 'unstamped-loopback';

  const gate = buildChokepointGate(broker, {
    capability: getOrCreateCapabilityOverrideStore(broker),
    actorPermissions: getOrCreateActorPermissionStore(broker),
    identity: getOrCreateIdentityStore(broker),
  });

  const verdict = await gate.check(GATEWAY_TOOL_ID, args.request_metadata);

  return {
    allowed: verdict.allowed,
    reason: verdict.reason,
    actor,
    tool_id: GATEWAY_TOOL_ID,
  };
}
