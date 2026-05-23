import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { DecisionTimeoutError } from '../persistence.js';
import { toolError, toolJson } from '../server.js';
import { logContext } from '../observability/logger.js';
import { mayRespond } from '../security/respond-policy.js';

export function registerDecisionTools(server: McpServer, broker: Broker): void {
  registerAwaitDecision(server, broker);
  registerRespondToDecision(server, broker);
}

function registerAwaitDecision(server: McpServer, broker: Broker): void {
  server.registerTool(
    'await_decision',
    {
      description:
        'Open a decision and block until a response arrives or the timeout fires. 30-min ceiling. If default_option_id is set, the call resolves with the default on timeout; otherwise it errors.',
      inputSchema: {
        question: z.string().min(1),
        options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1).max(8),
        default_option_id: z.string().optional(),
        timeout_sec: z.number().int().min(1).max(1800),
        correlation_id: z.string().optional(),
        tenant_id: z.string().optional(),
        source_agent: z.string().default('cc'),
      },
    },
    async (args) => {
      const correlationId = args.correlation_id ?? randomUUID();

      if (
        args.default_option_id !== undefined &&
        !args.options.some((o) => o.id === args.default_option_id)
      ) {
        return toolError(
          `default_option_id "${args.default_option_id}" is not one of the offered options`,
        );
      }

      broker.store.createDecision(
        correlationId,
        args.question,
        args.options,
        args.timeout_sec,
        args.default_option_id,
        args.source_agent,
      );

      await broker.publish({
        kind: 'decision_request',
        at: new Date().toISOString(),
        correlation_id: correlationId,
        tenant_id: args.tenant_id,
        source_agent: args.source_agent,
        payload: {
          question: args.question,
          options: args.options,
          default_option_id: args.default_option_id,
          deadline_seconds: args.timeout_sec,
        },
      });

      try {
        const result = await broker.store.awaitDecisionResponse(
          correlationId,
          args.timeout_sec * 1000,
        );
        return toolJson({
          correlation_id: correlationId,
          chosen_option_id: result.chosen_option_id,
          responder: result.responder,
          reason: result.reason,
          timed_out: false,
        });
      } catch (err) {
        if (err instanceof DecisionTimeoutError) {
          if (args.default_option_id) {
            const fallback = broker.store.respondToDecision(
              correlationId,
              args.default_option_id,
              'timeout fallback',
              'switch-default',
            );
            if (fallback.ok) {
              await broker.publish({
                kind: 'decision_response',
                at: fallback.result.responded_at,
                correlation_id: correlationId,
                tenant_id: args.tenant_id,
                source_agent: 'switch-default',
                payload: {
                  chosen_option_id: fallback.result.chosen_option_id,
                  reason: fallback.result.reason,
                  responder: fallback.result.responder,
                },
              });
              return toolJson({
                correlation_id: correlationId,
                chosen_option_id: fallback.result.chosen_option_id,
                responder: 'switch-default',
                reason: 'timeout fallback',
                timed_out: true,
              });
            }
            // Already responded between timeout-fire and fallback-write — read what landed.
            const current = broker.store.getDecision(correlationId);
            if (current?.status === 'responded' && current.chosen_option_id) {
              return toolJson({
                correlation_id: correlationId,
                chosen_option_id: current.chosen_option_id,
                responder: current.responded_by ?? 'unknown',
                reason: current.response_reason ?? '',
                timed_out: false,
              });
            }
          }
          return toolError(`decision ${correlationId} timed out and no default was provided`);
        }
        throw err;
      }
    },
  );
}

function registerRespondToDecision(server: McpServer, broker: Broker): void {
  server.registerTool(
    'respond_to_decision',
    {
      description:
        'Resolve a pending decision. Authorization is derived from VERIFIED identity (logContext.actor_id, stamped by the HTTP transport from the paired-device identity or loopback signal) — the `responder` input is advisory only and is NOT used to drive authorization. If the decision has already closed via switch-default fallback, the call is recorded as a decision_late_response event but does not override the fallback.',
      inputSchema: {
        correlation_id: z.string(),
        chosen_option_id: z.string(),
        reason: z.string().optional(),
        /** Advisory label — kept for backwards compatibility with existing
         *  callers. Phase 4.5 derives the actual authorization identity from
         *  logContext.actor_id (stamped by the HTTP transport). This field
         *  is captured in the audit trail as `attempted_responder` on a
         *  refusal but never drives the policy check. */
        responder: z.string(),
      },
    },
    async (args) => {
      const existing = broker.store.getDecision(args.correlation_id);
      if (!existing) {
        return toolJson({ ok: false, error: 'not_found' });
      }

      // family-mode-phase-1 Phase 4.5 — derive the verified caller from
      // the AsyncLocalStorage actor stamp. HTTP middleware sets it from
      // req.device.name (paired remote → `peer:<name>`) or the loopback
      // signal (local /mcp → `loopback:<corr>`); stdio sessions inherit
      // nothing and fall through to `unstamped-loopback` here, which the
      // policy treats as a loopback (operator) caller. The `args.responder`
      // string is ignored for authorization — it is recorded on a refusal
      // as `attempted_responder` for audit, and dropped from the success
      // path entirely (the audit event carries the verified identity).
      const verifiedCaller = logContext.getStore()?.actor_id ?? 'unstamped-loopback';
      const policy = mayRespond(existing, verifiedCaller);
      if (!policy.ok) {
        await broker.publish({
          kind: 'decision_self_approval_rejected',
          at: new Date().toISOString(),
          correlation_id: args.correlation_id,
          source_agent: verifiedCaller,
          payload: {
            error: policy.error,
            attempted_responder: args.responder,
            verified_caller: verifiedCaller,
            decision_source_agent: existing.source_agent,
            decision_tier: existing.tier,
            chosen_option_id: args.chosen_option_id,
            reason: policy.reason,
          },
        });
        return toolJson({ ok: false, error: policy.error });
      }

      const result = broker.store.respondToDecision(
        args.correlation_id,
        args.chosen_option_id,
        args.reason ?? '',
        verifiedCaller,
      );

      if (!result.ok) {
        if (result.error === 'already_responded') {
          // Late reply — log for housekeeping but the original response stands.
          await broker.publish({
            kind: 'decision_late_response',
            at: new Date().toISOString(),
            correlation_id: args.correlation_id,
            source_agent: verifiedCaller,
            payload: {
              chosen_option_id: args.chosen_option_id,
              reason: args.reason,
              responder: verifiedCaller,
              fallback_was: existing.chosen_option_id,
            },
          });
        }
        // Defense-in-depth: if mayRespond passed but the store still
        // refused for self-approval or operator-shape (e.g. the verified
        // caller was somehow not loopback-shaped, which should be
        // impossible given the mayRespond check above), surface that
        // mismatch to the audit trail too.
        if (
          result.error === 'responder_is_requester' ||
          result.error === 'operator_required'
        ) {
          await broker.publish({
            kind: 'decision_self_approval_rejected',
            at: new Date().toISOString(),
            correlation_id: args.correlation_id,
            source_agent: verifiedCaller,
            payload: {
              error: result.error,
              attempted_responder: args.responder,
              verified_caller: verifiedCaller,
              decision_source_agent: existing.source_agent,
              decision_tier: existing.tier,
              chosen_option_id: args.chosen_option_id,
            },
          });
        }
        return toolJson({ ok: false, error: result.error });
      }

      await broker.publish({
        kind: 'decision_response',
        at: result.result.responded_at,
        correlation_id: args.correlation_id,
        source_agent: verifiedCaller,
        payload: {
          chosen_option_id: args.chosen_option_id,
          reason: args.reason,
          responder: verifiedCaller,
        },
      });
      return toolJson({ ok: true, responded_at: result.result.responded_at });
    },
  );
}

export async function startupDecisionSweep(broker: Broker): Promise<number> {
  const expired = broker.store.sweepExpiredDecisions();
  for (const d of expired) {
    await broker.publish({
      kind: 'decision_late_response',
      at: new Date().toISOString(),
      correlation_id: d.correlation_id,
      source_agent: 'switch-startup-sweep',
      payload: {
        chosen_option_id: d.default_option_id ?? '',
        reason: 'expired before Switch restart',
        responder: 'switch-startup-sweep',
        fallback_was: d.default_option_id,
      },
    });
  }
  return expired.length;
}
