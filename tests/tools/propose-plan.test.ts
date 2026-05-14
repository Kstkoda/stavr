// tests/tools/propose-plan.test.ts
//
// Smoke test for the propose_plan MCP tool. Wires a real EventStore + Broker
// + wireV02Subsystem with a stub planner LLM, calls propose_plan, asserts
// the BOM lands in the boms table and bom_proposed fires.

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Broker } from '../../src/broker.js';
import { EventStore } from '../../src/persistence.js';
import { wireV02Subsystem } from '../../src/steward/v02-wiring.js';
import { registerProposePlanTool } from '../../src/tools/propose-plan.js';

describe('propose_plan tool', () => {
  it('persists a BOM and emits bom_proposed', async () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);

    const v02 = wireV02Subsystem({
      broker,
      store,
      plannerLlm: async () => ({
        text: JSON.stringify({
          steps: [
            {
              title: 'read README',
              description: 'list files in repo',
              capability: 'reading',
              risk_class: 'read-only',
              brick_id: 'files',
              depends_on: [],
            },
            {
              title: 'summarise',
              description: 'write a one-paragraph summary',
              capability: 'simple-summary',
              risk_class: 'write-local',
              brick_id: 'steward',
              depends_on: [1],
            },
          ],
        }),
        tokens_in: 200,
        tokens_out: 80,
        cost_usd: 0.001,
      }),
    });

    const captured: Array<{ kind: string; payload: unknown }> = [];
    broker.onEvent((ev) => captured.push({ kind: ev.kind, payload: ev.payload }));

    // Build a minimal McpServer and register the tool.
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerProposePlanTool(server, { planner: v02.planner, connectors: v02.connectors });

    // Drive the planner directly (skipping the MCP transport — the tool
    // is a thin wrapper around planner.proposePlan).
    const result = await v02.planner.proposePlan({
      goal: 'read the README and summarise it',
      correlationId: 'corr_test',
      availableCapabilities: [],
    });

    expect(result.bomId).toMatch(/^bom_/);
    const bom = store.getBom(result.bomId);
    expect(bom).toBeDefined();
    expect(bom?.status).toBe('proposed');
    expect(bom?.steps_total).toBe(2);
    expect(bom?.risk_envelope).toEqual(['read-only', 'write-local']);
    const proposed = captured.find((e) => e.kind === 'bom_proposed');
    expect(proposed).toBeDefined();
    expect((proposed?.payload as { goal: string }).goal).toBe('read the README and summarise it');

    v02.stop();
    store.close();
  });

  it('errors cleanly when planner LLM throws', async () => {
    const store = new EventStore();
    store.init(':memory:');
    const broker = new Broker(store);
    const v02 = wireV02Subsystem({
      broker,
      store,
      plannerLlm: async () => {
        throw new Error('boom');
      },
    });

    await expect(
      v02.planner.proposePlan({
        goal: 'do something',
        correlationId: 'corr_x',
        availableCapabilities: [],
      }),
    ).rejects.toThrow(/boom/);

    v02.stop();
    store.close();
  });
});
