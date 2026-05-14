import { z } from 'zod';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { toolError, toolJson } from '../server.js';
import { gatedAction } from '../tools/gated-action.js';
import type { TrustStore } from '../trust/store.js';
import {
  NoActiveStewardError,
  StewardAlreadyClaimedError,
  StewardTokenInvalidError,
  type StewardRecord,
} from './types.js';
import type { StewardStore } from './store.js';

export const STEWARD_MEMORY_ROOT = join(homedir(), '.stavr', 'steward-memory');

/** Per-steward memory directory. The daemon never reads/writes the contents. */
export function stewardMemoryPath(stewardId: string): string {
  return join(STEWARD_MEMORY_ROOT, stewardId);
}

export function ensureStewardMemoryDir(stewardId: string): string {
  const dir = stewardMemoryPath(stewardId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerStewardTools(
  server: McpServer,
  broker: Broker,
  store: StewardStore,
  trustStore: TrustStore,
): void {
  registerClaim(server, broker, store, trustStore);
  registerRelease(server, broker, store, trustStore);
  registerStatus(server, store);
  registerPulse(server, broker, store);
  registerTransfer(server, broker, store, trustStore);
}

function registerClaim(
  server: McpServer,
  broker: Broker,
  store: StewardStore,
  trustStore: TrustStore,
): void {
  server.registerTool(
    'steward_claim',
    {
      description:
        'Claim the Steward role for this MCP client. Requires a one-shot token from `stavr steward mint-token`. ' +
        'Tier: confirm — User approval required unless a covering trust scope is active. ' +
        'Refuses with StewardAlreadyClaimedError if another Steward holds the role.',
      inputSchema: {
        token: z.string().min(8),
        client_id: z.string().min(1),
        user_id: z.string().min(1),
        display_name: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      const question = `Allow MCP client "${args.display_name ?? args.client_id}" to claim the Steward role?`;
      const result = await gatedAction<{ record: StewardRecord; memory_path: string }>({
        broker,
        question,
        sourceAgent: args.client_id,
        scopeCheck: { tool: 'steward_claim', args, trustStore },
        performAction: async () => {
          const rec = store.claim(args.token, {
            client_id: args.client_id,
            user_id: args.user_id,
            display_name: args.display_name,
            model: args.model,
            provider: args.provider,
            metadata: args.metadata,
          });
          const memory_path = ensureStewardMemoryDir(rec.id);
          return { record: rec, memory_path };
        },
        successEvent: ({ record, memory_path }) => ({
          kind: 'steward_claimed',
          payload: {
            steward_id: record.id,
            client_id: record.client_id,
            user_id: record.user_id,
            display_name: record.display_name,
            model: record.model,
            provider: record.provider,
            claimed_at: record.claimed_at,
            memory_path,
          },
        }),
      });
      if (!result.ok) {
        if (result.reason === 'gh_failed') {
          if (result.message.includes('STEWARD_ALREADY_CLAIMED')) {
            return toolError(`StewardAlreadyClaimedError: ${result.message}`);
          }
          if (result.message.includes('STEWARD_TOKEN_INVALID')) {
            return toolError(`StewardTokenInvalidError: ${result.message}`);
          }
          return toolError(result.message);
        }
        return toolJson(result);
      }
      return toolJson({
        ok: true,
        correlation_id: result.correlation_id,
        steward_id: result.result.record.id,
        memory_path: result.result.memory_path,
        claimed_at: result.result.record.claimed_at,
      });
    },
  );
}

function registerRelease(
  server: McpServer,
  broker: Broker,
  store: StewardStore,
  trustStore: TrustStore,
): void {
  server.registerTool(
    'steward_release',
    {
      description:
        'End the active Steward session. The releasing client must be the active Steward. Tier: confirm.',
      inputSchema: {
        client_id: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async (args) => {
      const active = store.getActiveSteward();
      if (!active) return toolError('NoActiveStewardError: no active Steward session');
      if (active.client_id !== args.client_id) {
        return toolError(
          `client ${args.client_id} is not the active Steward (held by ${active.client_id})`,
        );
      }
      const question = `Release the active Steward session (requested by ${args.client_id})?`;
      const result = await gatedAction<StewardRecord>({
        broker,
        question,
        sourceAgent: args.client_id,
        scopeCheck: { tool: 'steward_release', args, trustStore },
        performAction: async () => store.release(args.reason),
        successEvent: (rec) => ({
          kind: 'steward_released',
          payload: {
            steward_id: rec.id,
            client_id: rec.client_id,
            released_at: rec.released_at!,
            released_by: 'steward' as const,
            reason: args.reason,
          },
        }),
      });
      if (!result.ok) return toolJson(result);
      return toolJson({
        ok: true,
        correlation_id: result.correlation_id,
        steward_id: result.result.id,
        released_at: result.result.released_at,
      });
    },
  );
}

function registerStatus(server: McpServer, store: StewardStore): void {
  server.registerTool(
    'steward_status',
    {
      description:
        'Return the active Steward (if any) plus recent steward sessions for audit. Tier: auto.',
      inputSchema: {
        history_limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const active = store.getActiveSteward();
      const recent = store.listStewards({ limit: args.history_limit ?? 10 });
      return toolJson({ active, recent });
    },
  );
}

function registerPulse(server: McpServer, broker: Broker, store: StewardStore): void {
  server.registerTool(
    'steward_pulse',
    {
      description:
        'Update the active Steward\'s last_pulse_at timestamp. Surfaces idle state in dashboards. Tier: auto.',
      inputSchema: {
        client_id: z.string().min(1),
        detail: z.string().optional(),
      },
    },
    async (args) => {
      const active = store.getActiveSteward();
      if (!active) return toolError('NoActiveStewardError: no active Steward session');
      if (active.client_id !== args.client_id) {
        return toolError(
          `client ${args.client_id} is not the active Steward (held by ${active.client_id})`,
        );
      }
      const updated = store.recordPulse(active.id);
      if (!updated) return toolError('failed to record pulse');
      await broker.publish({
        kind: 'steward_pulse',
        at: updated.last_pulse_at!,
        source_agent: args.client_id,
        payload: {
          steward_id: updated.id,
          at: updated.last_pulse_at!,
          detail: args.detail,
        },
      });
      return toolJson({ steward_id: updated.id, last_pulse_at: updated.last_pulse_at });
    },
  );
}

function registerTransfer(
  server: McpServer,
  broker: Broker,
  store: StewardStore,
  trustStore: TrustStore,
): void {
  server.registerTool(
    'steward_transfer',
    {
      description:
        'Transfer the Steward role to a new client using a fresh claim token. ' +
        'Atomic: old Steward released and new one claimed in a single transaction. Tier: confirm.',
      inputSchema: {
        token: z.string().min(8),
        client_id: z.string().min(1),
        user_id: z.string().min(1),
        display_name: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      const question = `Transfer the Steward role to "${args.display_name ?? args.client_id}"?`;
      const result = await gatedAction<{
        from: StewardRecord;
        to: StewardRecord;
        memory_path: string;
      }>({
        broker,
        question,
        sourceAgent: args.client_id,
        scopeCheck: { tool: 'steward_transfer', args, trustStore },
        performAction: async () => {
          const { from, to } = store.transfer(args.token, {
            client_id: args.client_id,
            user_id: args.user_id,
            display_name: args.display_name,
            model: args.model,
            provider: args.provider,
            metadata: args.metadata,
          });
          const memory_path = ensureStewardMemoryDir(to.id);
          return { from, to, memory_path };
        },
        successEvent: ({ from, to }) => ({
          kind: 'steward_handoff',
          payload: {
            from_steward_id: from.id,
            to_steward_id: to.id,
            from_client_id: from.client_id,
            to_client_id: to.client_id,
            at: new Date().toISOString(),
          },
        }),
      });
      if (!result.ok) return toolJson(result);
      return toolJson({
        ok: true,
        correlation_id: result.correlation_id,
        from_steward_id: result.result.from.id,
        to_steward_id: result.result.to.id,
        memory_path: result.result.memory_path,
      });
    },
  );
}

// Re-export errors so dependent code (and tests) can reference them.
export {
  NoActiveStewardError,
  StewardAlreadyClaimedError,
  StewardTokenInvalidError,
};
