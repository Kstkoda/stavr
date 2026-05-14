// src/tools/propose-plan.ts
//
// MCP tool `propose_plan` — wraps StewardPlanner.proposePlan. Flag-gated:
// only registered when experimental.planner is true (createSwitchServer
// looks up getV02Subsystem(broker) and only calls this when present).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolJson } from '../server.js';
import type {
  PlannerAvailableCapability,
  StewardPlanner,
} from '../steward/planner.js';
import type { ConnectorRegistry } from '../connectors/index.js';
import type { CapabilityTag } from '../types/stavr-bom.js';

const CapabilityTagEnum = z.enum([
  'reading',
  'cheap-classifier',
  'code-execution',
  'code-reasoning',
  'long-context',
  'multimodal-vision',
  'multimodal-audio',
  'tool-use-heavy',
  'simple-summary',
  'no-model',
]);

export interface ProposePlanToolDeps {
  planner: StewardPlanner;
  connectors: ConnectorRegistry;
  /** Daemon port — used to build the dashboard approval URL. */
  dashboardPort?: number;
}

/**
 * Register `propose_plan` on the given MCP server. Caller is responsible for
 * only invoking this when experimental.planner is on.
 */
export function registerProposePlanTool(server: McpServer, deps: ProposePlanToolDeps): void {
  server.registerTool(
    'propose_plan',
    {
      description:
        'v0.2 — Ask the steward planner to produce a Bill of Materials (BOM) for the given goal. ' +
        'Returns { bom_id, approval_url } once persisted. The BOM is emitted as a `bom_proposed` event ' +
        'and rendered in the dashboard at /dashboard/plans for human approval. Flag-gated behind ' +
        'experimental.planner in stavr.yaml — calls fail cleanly when off.',
      inputSchema: {
        goal: z.string().min(10),
        correlation_id: z.string().min(1),
        capability_hints: z.record(CapabilityTagEnum).optional(),
        profile_override: z.enum(['turbo', 'balanced', 'eco']).optional(),
      },
    },
    async (args) => {
      try {
        const available: PlannerAvailableCapability[] = deps.connectors.allCapabilities().map(
          ({ connectorId, capability }) => ({
            connectorId,
            capabilityId: capability.id,
            description: capability.description,
            capabilityTag: capability.capabilityTag as CapabilityTag,
            riskClass: capability.riskClass,
          }),
        );

        const result = await deps.planner.proposePlan({
          goal: args.goal,
          correlationId: args.correlation_id,
          capabilityHints: args.capability_hints as Record<string, CapabilityTag> | undefined,
          profileOverride: args.profile_override,
          availableCapabilities: available,
        });

        const port = deps.dashboardPort ?? 7777;
        const approvalUrl = `http://127.0.0.1:${port}/dashboard/plans?focus=${result.bomId}`;
        return toolJson({
          ok: true,
          bom_id: result.bomId,
          approval_url: approvalUrl,
          available_capabilities_count: available.length,
        });
      } catch (err) {
        return toolError(`propose_plan failed: ${(err as Error).message}`);
      }
    },
  );
}
