import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from './broker.js';
import { toolError, toolJson } from './server.js';

/**
 * Spec 49 Layer 2 — `mcp__cowire__steward_ask` tool.
 *
 * Lets external chat surfaces (Cowork, Claude.ai, custom MCP clients) post
 * prompts to the daemon-hosted Steward and (optionally) wait for the response.
 * Same flow as the dashboard chat panel and `cowire ask`, packaged as a tool
 * call so any MCP-speaking front-end can route through it.
 */
export function registerStewardAskTool(server: McpServer, broker: Broker): void {
  server.registerTool(
    'steward_ask',
    {
      description:
        'Post a prompt to the daemon-hosted Steward (spec 49). Emits steward_prompt with a fresh correlation_id. ' +
        'When wait_for_response is true (default), blocks for up to timeout_ms until a matching steward_response ' +
        'fires; otherwise returns the correlation_id immediately. The Steward never sees the underlying MCP ' +
        'client identity — only the prompt text + source.',
      inputSchema: {
        text: z.string().min(1),
        source: z.enum(['cli', 'dashboard', 'mcp', 'scheduled']).optional(),
        wait_for_response: z.boolean().optional().default(true),
        timeout_ms: z.number().int().positive().max(600_000).optional().default(300_000),
      },
    },
    async (args) => {
      const correlationId = `prompt-${randomUUID()}`;
      try {
        await broker.publish({
          kind: 'steward_prompt',
          at: new Date().toISOString(),
          correlation_id: correlationId,
          source_agent: 'mcp-client',
          payload: { text: args.text, source: args.source ?? 'mcp' },
        });
      } catch (err) {
        return toolError(`failed to emit steward_prompt: ${(err as Error).message}`);
      }
      if (!args.wait_for_response) {
        return toolJson({ ok: true, correlation_id: correlationId });
      }
      const response = await waitForResponse(broker, correlationId, args.timeout_ms);
      if (response.timeout) {
        return toolJson({
          ok: false,
          correlation_id: correlationId,
          timeout: true,
          waited_ms: args.timeout_ms,
        });
      }
      return toolJson({
        ok: true,
        correlation_id: correlationId,
        text: response.text,
      });
    },
  );
}

interface ResponseWaitResult {
  timeout?: boolean;
  text?: string;
}

function waitForResponse(broker: Broker, correlationId: string, timeoutMs: number): Promise<ResponseWaitResult> {
  return new Promise((resolve) => {
    const dispose = broker.onEvent((ev) => {
      if (ev.kind !== 'steward_response') return;
      if (ev.correlation_id !== correlationId) return;
      dispose();
      clearTimeout(timer);
      const payload = ev.payload as { text?: string };
      resolve({ text: payload?.text ?? '' });
    });
    const timer = setTimeout(() => {
      dispose();
      resolve({ timeout: true });
    }, timeoutMs);
  });
}
