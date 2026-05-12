import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { DecisionTimeoutError } from '../persistence.js';
import { toolError, toolJson } from '../server.js';

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
        'Resolve a pending decision. If the decision has already closed via switch-default fallback, this is recorded as a decision_late_response event but does not override the fallback.',
      inputSchema: {
        correlation_id: z.string(),
        chosen_option_id: z.string(),
        reason: z.string().optional(),
        responder: z.string(),
      },
    },
    async (args) => {
      const existing = broker.store.getDecision(args.correlation_id);
      if (!existing) {
        return toolJson({ ok: false, error: 'not_found' });
      }

      const result = broker.store.respondToDecision(
        args.correlation_id,
        args.chosen_option_id,
        args.reason ?? '',
        args.responder,
      );

      if (!result.ok) {
        if (result.error === 'already_responded') {
          // Late reply — log for housekeeping but the original response stands.
          await broker.publish({
            kind: 'decision_late_response',
            at: new Date().toISOString(),
            correlation_id: args.correlation_id,
            source_agent: args.responder,
            payload: {
              chosen_option_id: args.chosen_option_id,
              reason: args.reason,
              responder: args.responder,
              fallback_was: existing.chosen_option_id,
            },
          });
        }
        return toolJson({ ok: false, error: result.error });
      }

      await broker.publish({
        kind: 'decision_response',
        at: result.result.responded_at,
        correlation_id: args.correlation_id,
        source_agent: args.responder,
        payload: {
          chosen_option_id: args.chosen_option_id,
          reason: args.reason,
          responder: args.responder,
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
