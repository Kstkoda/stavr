import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { toolError, toolJson } from '../server.js';
import { gatedAction } from '../tools/gated-action.js';
import type { TrustStore } from './store.js';
import type { ActionMatcher, ScopeReporting, TrustScope } from './types.js';

const ActionMatcherZ = z.object({
  tool: z.string().min(1),
  param_constraints: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

const ReportingZ = z.object({
  cadence: z.enum(['every-action', 'every-5-actions', 'every-15-min', 'on-completion-only']),
  channels: z.array(z.enum(['chat', 'event-log', 'dashboard', 'slack', 'email'])).min(1),
});

export function registerTrustScopeTools(
  server: McpServer,
  broker: Broker,
  store: TrustStore,
): void {
  registerPropose(server, broker, store);
  registerGrant(server, broker, store);
  registerRevoke(server, broker, store);
  registerList(server, store);
  registerStatus(server, store);
  registerExtend(server, broker, store);
}

function registerPropose(server: McpServer, broker: Broker, store: TrustStore): void {
  server.registerTool(
    'trust_scope_propose',
    {
      description:
        'Propose a trust scope (auto-tier). Logs trust_scope_proposed; does NOT activate. Use trust_scope_grant to activate.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().min(1),
        allowed_actions: z.array(ActionMatcherZ).min(1),
        forbidden_actions: z.array(ActionMatcherZ).optional(),
        reporting: ReportingZ.optional(),
        expires_at: z.string().datetime().optional(),
        expires_after_actions: z.number().int().positive().optional(),
        spec_url: z.string().optional(),
        source_agent: z.string().default('co'),
      },
    },
    async (args) => {
      const reporting: ScopeReporting = args.reporting ?? {
        cadence: 'every-5-actions',
        channels: ['chat', 'event-log'],
      };
      const scope = store.createProposal({
        title: args.title,
        description: args.description,
        allowed_actions: args.allowed_actions as ActionMatcher[],
        forbidden_actions: args.forbidden_actions as ActionMatcher[] | undefined,
        reporting,
        expires_at: args.expires_at,
        expires_after_actions: args.expires_after_actions,
        spec_url: args.spec_url,
      });
      await broker.publish({
        kind: 'trust_scope_proposed',
        at: new Date().toISOString(),
        source_agent: args.source_agent,
        payload: {
          scope_id: scope.id,
          title: scope.title,
          description: scope.description,
          allowed_actions: scope.allowed_actions,
          forbidden_actions: scope.forbidden_actions,
          expires_at: scope.expires_at,
          expires_after_actions: scope.expires_after_actions,
          reporting: scope.reporting,
          spec_url: scope.spec_url,
        },
      });
      return toolJson({ scope_id: scope.id, scope: serialize(scope) });
    },
  );
}

function registerGrant(server: McpServer, broker: Broker, store: TrustStore): void {
  server.registerTool(
    'trust_scope_grant',
    {
      description:
        'Activate a proposed trust scope. CONFIRM-tier: opens an await_decision; on approve, flips the scope to active and emits trust_scope_granted.',
      inputSchema: {
        id: z.string().min(1),
        granted_by: z.string().default('cowork-user-relayed'),
        timeout_sec: z.number().int().min(1).max(1800).optional(),
        source_agent: z.string().default('co'),
      },
    },
    async (args) => {
      const existing = store.get(args.id);
      if (!existing) {
        return toolError(`unknown scope id: ${args.id}`);
      }
      if (existing.status !== 'proposed') {
        return toolError(`scope ${args.id} is not in 'proposed' state (status=${existing.status})`);
      }
      const question = `Grant trust scope "${existing.title}"? ${existing.description.slice(0, 200)}`;
      const result = await gatedAction({
        broker,
        question,
        timeoutSec: args.timeout_sec,
        sourceAgent: args.source_agent,
        performAction: async () => {
          const granted = store.grant(args.id, args.granted_by);
          if (!granted) throw new Error(`failed to grant ${args.id}`);
          return granted;
        },
        successEvent: (scope) => ({
          kind: 'trust_scope_granted',
          payload: {
            scope_id: scope.id,
            title: scope.title,
            granted_by: scope.granted_by,
            granted_at: scope.granted_at,
            expires_at: scope.expires_at,
            expires_after_actions: scope.expires_after_actions,
          },
        }),
      });
      if (!result.ok) return toolJson(result);
      return toolJson({
        ok: true,
        correlation_id: result.correlation_id,
        scope: serialize(result.result),
      });
    },
  );
}

function registerRevoke(server: McpServer, broker: Broker, store: TrustStore): void {
  server.registerTool(
    'trust_scope_revoke',
    {
      description:
        'Revoke an active trust scope (auto-tier escape hatch). Emits trust_scope_revoked.',
      inputSchema: {
        id: z.string().min(1),
        reason: z.string().optional(),
        revoked_by: z.string().default('user-direct'),
        source_agent: z.string().default('cowork'),
      },
    },
    async (args) => {
      const scope = store.revoke(args.id);
      if (!scope) return toolError(`unknown scope id: ${args.id}`);
      await broker.publish({
        kind: 'trust_scope_revoked',
        at: new Date().toISOString(),
        source_agent: args.source_agent,
        payload: {
          scope_id: scope.id,
          revoked_by: args.revoked_by,
          reason: args.reason,
        },
      });
      return toolJson({ ok: true, scope: serialize(scope) });
    },
  );
}

function registerList(server: McpServer, store: TrustStore): void {
  server.registerTool(
    'trust_scope_list',
    {
      description: 'List trust scopes, optionally filtered by status. Auto-tier.',
      inputSchema: {
        status: z.enum(['proposed', 'active', 'expired', 'revoked', 'completed']).optional(),
      },
    },
    async (args) => {
      // Refresh expiry status before returning, so listings reflect wall-clock state.
      store.sweepExpired();
      const scopes = store.list(args.status ? { status: args.status } : undefined);
      const now = Date.now();
      return toolJson({
        scopes: scopes.map((s) => ({
          ...serialize(s),
          time_remaining_ms: Math.max(0, new Date(s.expires_at).getTime() - now),
          actions_remaining:
            s.expires_after_actions !== undefined
              ? Math.max(0, s.expires_after_actions - s.actions_executed)
              : null,
        })),
      });
    },
  );
}

function registerStatus(server: McpServer, store: TrustStore): void {
  server.registerTool(
    'trust_scope_status',
    {
      description:
        'Full state of one trust scope including action history. Auto-tier.',
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async (args) => {
      store.sweepExpired();
      const scope = store.get(args.id);
      if (!scope) return toolJson({ scope: null });
      const actions = store.listActions(args.id);
      const now = Date.now();
      return toolJson({
        scope: serialize(scope),
        time_remaining_ms: Math.max(0, new Date(scope.expires_at).getTime() - now),
        actions_remaining:
          scope.expires_after_actions !== undefined
            ? Math.max(0, scope.expires_after_actions - scope.actions_executed)
            : null,
        actions,
      });
    },
  );
}

function registerExtend(server: McpServer, broker: Broker, store: TrustStore): void {
  server.registerTool(
    'trust_scope_extend',
    {
      description:
        'Extend an active scope by bumping its expiry deadline or action cap. CONFIRM-tier (gates on await_decision).',
      inputSchema: {
        id: z.string().min(1),
        new_expires_at: z.string().datetime().optional(),
        new_expires_after_actions: z.number().int().positive().optional(),
        extended_by: z.string().default('cowork-user-relayed'),
        timeout_sec: z.number().int().min(1).max(1800).optional(),
        source_agent: z.string().default('co'),
      },
    },
    async (args) => {
      const existing = store.get(args.id);
      if (!existing) return toolError(`unknown scope id: ${args.id}`);
      if (existing.status !== 'active') {
        return toolError(`cannot extend scope ${args.id} (status=${existing.status})`);
      }
      if (!args.new_expires_at && args.new_expires_after_actions === undefined) {
        return toolError('extend requires new_expires_at and/or new_expires_after_actions');
      }
      const desc: string[] = [];
      if (args.new_expires_at) desc.push(`expires_at=${args.new_expires_at}`);
      if (args.new_expires_after_actions !== undefined)
        desc.push(`actions_cap=${args.new_expires_after_actions}`);
      const question = `Extend scope "${existing.title}" (${desc.join(', ')})?`;
      const result = await gatedAction({
        broker,
        question,
        timeoutSec: args.timeout_sec,
        sourceAgent: args.source_agent,
        performAction: async () => {
          const updated = store.extend(args.id, {
            expires_at: args.new_expires_at,
            expires_after_actions: args.new_expires_after_actions,
          });
          if (!updated) throw new Error(`failed to extend ${args.id}`);
          return updated;
        },
        successEvent: (scope) => ({
          kind: 'trust_scope_extended',
          payload: {
            scope_id: scope.id,
            new_expires_at: args.new_expires_at,
            new_expires_after_actions: args.new_expires_after_actions,
            extended_by: args.extended_by,
          },
        }),
      });
      if (!result.ok) return toolJson(result);
      return toolJson({
        ok: true,
        correlation_id: result.correlation_id,
        scope: serialize(result.result),
      });
    },
  );
}

function serialize(s: TrustScope): Record<string, unknown> {
  return { ...s };
}

export const TRUST_SCOPE_TOOL_NAMES = [
  'trust_scope_propose',
  'trust_scope_grant',
  'trust_scope_revoke',
  'trust_scope_list',
  'trust_scope_status',
  'trust_scope_extend',
] as const;
