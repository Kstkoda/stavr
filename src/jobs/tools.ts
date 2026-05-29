/**
 * worker-dispatch Phase 3b — job_* MCP tool surface.
 *
 * Primary registration site for the six canonical job-vocabulary tools:
 *
 *   job_list_bindings  — list the registered binding catalogue
 *   job_dispatch       — start a new job under a binding + budget
 *   job_list           — list jobs (filterable by binding_kind / lifecycle_state)
 *   job_status         — full state of one job
 *   job_inject         — mid-flight injection (binding must advertise capability)
 *   job_terminate      — terminate a running job
 *
 * Legacy parity table lives in src/tools/categories.ts
 * (`WORKER_TO_JOB_TOOL_ID_ALIAS`). The pairs there share security tier
 * + reversibility classification with their worker_* counterparts so
 * actor_permissions grants keep working as callers migrate.
 *
 * The handlers here route through JobOrchestrator → jobs table. They do
 * NOT share a code path with src/workers/tools.ts during 3b — that
 * unification is 3c scope (it needs the binding-target catalogue and the
 * spawner-mcp consumer migration to land first). The two surfaces are
 * parallel during the deprecation window: worker_* writes to the workers
 * table via WorkerOrchestrator; job_* writes to the jobs table via
 * JobOrchestrator. Both are fully functional.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolJson } from '../server.js';
import { logContext } from '../observability/logger.js';
import { JobOrchestrator, OrchestratorError } from './orchestrator.js';
import type { JobRecord } from './types.js';

export function registerJobTools(server: McpServer, orch: JobOrchestrator): void {
  registerJobListBindings(server, orch);
  registerJobDispatch(server, orch);
  registerJobList(server, orch);
  registerJobStatus(server, orch);
  registerJobInject(server, orch);
  registerJobTerminate(server, orch);
}

function registerJobListBindings(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_list_bindings',
    {
      description:
        'List registered executor bindings (kind + target) and their dispatch parameter schemas. Auto-tier.',
      inputSchema: {},
    },
    async () => toolJson({ bindings: orch.listBindings() }),
  );
}

const JobBudgetSchema = z.object({
  max_runtime_ms: z.number().int().positive().optional(),
  max_steps: z.number().int().positive().optional(),
  credit_pool: z.string().optional(),
});

function registerJobDispatch(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_dispatch',
    {
      description:
        'Dispatch a new job under the given binding + target. Confirm-tier; admission control runs first (per-actor concurrency + host ceiling).',
      inputSchema: {
        binding_kind: z.enum(['mcp-call', 'http', 'process-spawn', 'cc-session-attach']),
        binding_target: z.string().min(1),
        name: z.string().min(1).max(128),
        params: z.unknown(),
        budget: JobBudgetSchema.optional(),
        audit_correlation_id: z.string().optional(),
        federation_role: z.enum(['originator', 'participant', 'convener']).optional(),
        originator_peer: z.string().optional(),
        grant_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const params = normalizeUnknownArg(args.params, 'params');
        // worker-dispatch Phase 4 — thread calling actor identity from
        // AsyncLocalStorage (HTTP middleware in transports.ts stamps it
        // per request; stdio sessions fall through to the same
        // `'unstamped-loopback'` default the chokepoint uses). The
        // orchestrator's grant gate keys peer:* vs operator-shape off
        // this; absent value defaults to operator-shape inside dispatch.
        const actorId = logContext.getStore()?.actor_id;
        const result = await orch.dispatch({
          binding_kind: args.binding_kind,
          binding_target: args.binding_target,
          name: args.name,
          params,
          budget: args.budget,
          audit_correlation_id: args.audit_correlation_id,
          federation_role: args.federation_role,
          originator_peer: args.originator_peer,
          grant_id: args.grant_id,
          actor_id: actorId,
        });
        return toolJson({ job: serializeJob(result.job) });
      } catch (err) {
        return orchError(err);
      }
    },
  );
}

function registerJobList(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_list',
    {
      description:
        'List jobs, optionally filtered by binding_kind or lifecycle_state. Auto-tier.',
      inputSchema: {
        binding_kind: z.enum(['mcp-call', 'http', 'process-spawn', 'cc-session-attach']).optional(),
        lifecycle_state: z
          .enum([
            'dispatched',
            'running',
            'completed-clean',
            'completed-error',
            'killed-by-operator',
            'killed-by-system',
            'crashed',
            'stale',
          ])
          .optional(),
      },
    },
    async (args) => {
      const jobs = orch.list({
        binding_kind: args.binding_kind,
        lifecycle_state: args.lifecycle_state,
      });
      return toolJson({ jobs: jobs.map(serializeJob) });
    },
  );
}

function registerJobStatus(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_status',
    {
      description: 'Full state of a single job by id or name. Auto-tier.',
      inputSchema: {
        id_or_name: z.string().min(1),
      },
    },
    async (args) => {
      const rec = orch.status(args.id_or_name);
      if (!rec) return toolJson({ job: null });
      return toolJson({ job: serializeJob(rec) });
    },
  );
}

function registerJobInject(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_inject',
    {
      description:
        'Inject a mid-flight message into a running job. Confirm-tier. The binding must advertise the `inject` capability (see job_list_bindings).',
      inputSchema: {
        id_or_name: z.string().min(1),
        body: z.unknown(),
      },
    },
    async (args) => {
      try {
        const body = normalizeUnknownArg(args.body, 'body');
        const result = await orch.inject(args.id_or_name, body);
        return toolJson(result);
      } catch (err) {
        return orchError(err);
      }
    },
  );
}

function registerJobTerminate(server: McpServer, orch: JobOrchestrator): void {
  server.registerTool(
    'job_terminate',
    {
      description: 'Terminate a job. Always confirm-tier.',
      inputSchema: {
        id_or_name: z.string().min(1),
        force: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        const result = await orch.terminate(args.id_or_name, args.force);
        return toolJson({ ok: true, exit_code: result.exitCode });
      } catch (err) {
        return orchError(err);
      }
    },
  );
}

/**
 * Some MCP clients (notably Cowork's current build) serialize z.unknown() schema fields
 * as JSON strings when sending over the wire. Accept both forms — same shim
 * as src/workers/tools.ts. CONTRACT: returns the parsed value, or throws if
 * a string was sent that doesn't parse.
 */
function normalizeUnknownArg(value: unknown, fieldName: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${fieldName}: expected object or JSON-encoded string, got unparseable string`);
  }
}

function orchError(err: unknown) {
  if (err instanceof OrchestratorError) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ code: err.code, message: err.message }) }],
      structuredContent: { code: err.code, message: err.message },
    };
  }
  return toolError((err as Error)?.message ?? 'unknown error');
}

interface SerializedJob {
  id: string;
  name: string;
  binding_kind: string;
  binding_target: string;
  params_hash: string;
  lifecycle_state: string;
  started_at: string;
  ended_at?: string;
  last_activity_at?: string;
  metadata: Record<string, unknown>;
  termination_reason?: string;
  exit_code?: number;
  result?: unknown;
  federation_role?: string;
  originator_peer?: string;
  grant_id?: string;
}

function serializeJob(r: JobRecord): SerializedJob {
  return {
    id: r.id,
    name: r.name,
    binding_kind: r.binding_kind,
    binding_target: r.binding_target,
    params_hash: r.params_hash,
    lifecycle_state: r.lifecycle_state,
    started_at: r.started_at,
    ended_at: r.ended_at,
    last_activity_at: r.last_activity_at,
    metadata: r.metadata,
    termination_reason: r.termination_reason,
    exit_code: r.exit_code,
    result: r.result,
    federation_role: r.federation_role,
    originator_peer: r.originator_peer,
    grant_id: r.grant_id,
  };
}
