import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolJson } from '../server.js';
import { OrchestratorError, type WorkerOrchestrator } from './orchestrator.js';

export function registerWorkerTools(server: McpServer, orch: WorkerOrchestrator): void {
  registerWorkerListTypes(server, orch);
  registerWorkerSpawn(server, orch);
  registerWorkerList(server, orch);
  registerWorkerStatus(server, orch);
  registerWorkerDispatch(server, orch);
  registerWorkerTerminate(server, orch);
}

function registerWorkerListTypes(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_list_types',
    {
      description: 'List registered worker types and their spawn parameter schemas. Auto-tier.',
      inputSchema: {},
    },
    async () => toolJson({ types: orch.listTypes() }),
  );
}

function registerWorkerSpawn(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_spawn',
    {
      description:
        'Spawn a worker of the given type. Tier comes from the spawner; confirm-tier spawners gate on await_decision.',
      inputSchema: {
        type: z.string().min(1),
        name: z.string().min(1).max(128),
        params: z.unknown(),
      },
    },
    async (args) => {
      try {
        const result = await orch.spawn(args.type, args.name, args.params);
        return toolJson({ worker: serializeWorker(result.worker), gated: result.gated });
      } catch (err) {
        return orchError(err);
      }
    },
  );
}

function registerWorkerList(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_list',
    {
      description: 'List workers, optionally filtered by type or status. Auto-tier.',
      inputSchema: {
        type: z.string().optional(),
        status: z.enum(['starting', 'running', 'idle', 'terminated', 'crashed']).optional(),
      },
    },
    async (args) => {
      const workers = orch.list({ type: args.type, status: args.status });
      return toolJson({ workers: workers.map(serializeWorker) });
    },
  );
}

function registerWorkerStatus(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_status',
    {
      description: 'Full state of a single worker by id or name. Auto-tier.',
      inputSchema: {
        id_or_name: z.string().min(1),
      },
    },
    async (args) => {
      const rec = orch.status(args.id_or_name);
      if (!rec) return toolJson({ worker: null });
      return toolJson({ worker: serializeWorker(rec) });
    },
  );
}

function registerWorkerDispatch(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_dispatch',
    {
      description: 'Deliver an instruction to a running worker. Per-spawner tier.',
      inputSchema: {
        id_or_name: z.string().min(1),
        body: z.unknown(),
      },
    },
    async (args) => {
      try {
        const result = await orch.dispatch(args.id_or_name, args.body);
        return toolJson(result);
      } catch (err) {
        return orchError(err);
      }
    },
  );
}

function registerWorkerTerminate(server: McpServer, orch: WorkerOrchestrator): void {
  server.registerTool(
    'worker_terminate',
    {
      description: 'Terminate a worker. Always confirm-tier.',
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

interface SerializedWorker {
  id: string;
  name: string;
  type: string;
  cwd: string;
  pid?: number;
  status: string;
  started_at: string;
  ended_at?: string;
  last_activity_at?: string;
  metadata: Record<string, unknown>;
  termination_reason?: string;
  exit_code?: number;
}

function serializeWorker(r: ReturnType<WorkerOrchestrator['status']> & object): SerializedWorker {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    cwd: r.cwd,
    pid: r.pid,
    status: r.status,
    started_at: r.started_at,
    ended_at: r.ended_at,
    last_activity_at: r.last_activity_at,
    metadata: r.metadata,
    termination_reason: r.termination_reason,
    exit_code: r.exit_code,
  };
}
