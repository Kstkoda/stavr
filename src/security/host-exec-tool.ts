// host_exec MCP tool registration (P2 skeleton — P3 adds the runner, P4
// adds scope gating + audit emission).
//
// The handler is intentionally separated from the runner: registration runs
// at every MCP-session open, the runner is invoked per-call. The runner
// (P3) does the actual spawn(); the trust-scope check (P4) sits between
// validation and run. This file owns ONLY the tool schema + orchestration.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolJson } from '../server.js';
import type { Broker } from '../broker.js';
import type { TrustStore } from '../trust/store.js';
import { loadHostExecConfig } from './host-exec-config.js';
import type { ResolvedAllowlist } from './host-exec-allowlist.js';

export interface HostExecToolOpts {
  /** Pre-resolved allowlist (tests). Defaults to loadHostExecConfig(). */
  allowlist?: ResolvedAllowlist;
  /** Trust-scope store; passed in so handler can call findActiveScopeFor. */
  trustStore: TrustStore;
}

/**
 * Register host_exec on the MCP server. The handler is wired in P2 as a
 * skeleton; P3 (runner) and P4 (scope-gate + audit) fill in real behaviour.
 */
export function registerHostExecTool(
  server: McpServer,
  _broker: Broker,
  opts: HostExecToolOpts,
): void {
  const allowlist = opts.allowlist ?? loadHostExecConfig();
  // Skeleton hands the allowlist + trust store through; full handler is
  // registered in P3/P4 (handleHostExec). For now this proves registration.
  server.registerTool(
    'host_exec',
    {
      description:
        'Run an allowlisted host command (git/npm/pm2/taskkill/kill/netstat). ' +
        'Requires an active trust scope covering host_exec. Audit-logged. ' +
        'shell:false — no metacharacter expansion. See allowlist for banned arg patterns.',
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('Binary name from the host_exec allowlist (no path).'),
        args: z
          .array(z.string())
          .default([])
          .describe('Positional args passed verbatim to spawn(). No shell.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory. Must be inside process.cwd(); defaults to it.'),
        timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(600_000)
          .optional()
          .describe('Kill after N ms. Default from allowlist entry.'),
      },
    },
    async (args) => {
      // P2 skeleton: prove the registration works. P3/P4 replace this body.
      return toolJson({
        ok: false,
        error: 'host_exec handler not yet implemented (P2 skeleton)',
        error_code: 'NOT_IMPLEMENTED',
        echoed: {
          command: args.command,
          args: args.args ?? [],
          allowlist_size: allowlist.length,
          trust_store_present: Boolean(opts.trustStore),
        },
      });
    },
  );
}

export const HOST_EXEC_TOOL_NAME = 'host_exec';
