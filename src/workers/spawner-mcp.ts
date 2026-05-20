/**
 * MCP-server-as-worker adapter — ADR-042 Decision 5.
 *
 * Wraps an external MCP server child process as a `WorkerSpawner`. The
 * orchestrator interacts with the result identically to the in-process
 * spawners (shell, cc, unity, av-detector). What's different is the
 * spawn implementation:
 *
 *   1. Spawn the MCP child via `StdioClientTransport` (command + args + env)
 *   2. Initialize the MCP client connection (handshake)
 *   3. Call `worker_init` to get a session_id + capabilities
 *   4. Run a long-poll loop calling `worker_step` and translating each
 *      step's payload into emissions on the local WorkerEventBus
 *   5. On terminate/exit, call `worker_finalize` and close the transport
 *
 * The poll loop runs detached as a Promise; the spawner returns the
 * WorkerInstance synchronously once worker_init succeeds. Step results
 * fan into the event bus which the orchestrator already wires to broker
 * events — no separate audit path.
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkerEventBus } from './emitter.js';
import type { WorkerInstance, WorkerSpawner, WorkerSpawnerContext } from './types.js';
import {
  WorkerInitResultSchema,
  WorkerStepResultSchema,
  WorkerMcpManifestEntrySchema,
  type WorkerInitResult,
  type WorkerMcpManifestEntry,
  type WorkerStepResult,
  type SpawnerMcpMetadata,
} from './spawner-protocol.js';
import { getLogger } from '../log.js';

/** Defaults the orchestrator can override per-test. */
const DEFAULT_STEP_MAX_WAIT_MS = 5000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_FINALIZE_TIMEOUT_MS = 10_000;

/** Params shape passed to spawn() — the operator's worker config is in
 *  `params`, fully opaque at this layer (the MCP child validates it). */
const McpSpawnParams = z.object({
  params: z.unknown().default({}),
});

type McpSpawnParamsT = z.infer<typeof McpSpawnParams>;

/** Options the adapter exposes for testing (lets tests inject a fake client
 *  + skip the actual child_process spawn). */
export interface McpSpawnerOptions {
  /** Override the client factory — used in tests with a mock MCP child. */
  clientFactory?: (entry: WorkerMcpManifestEntry) => Promise<Client>;
  /** Override the long-poll wait. Tests usually pass a very small value. */
  stepMaxWaitMs?: number;
  /** Override the worker_init timeout. */
  initTimeoutMs?: number;
  /** Override the worker_finalize timeout. */
  finalizeTimeoutMs?: number;
}

/** Build a `WorkerSpawner` from a manifest entry. The returned spawner
 *  conforms to the existing `WorkerSpawner` interface so the orchestrator
 *  treats it identically to in-process spawners. */
export function createMcpSpawner(
  entry: WorkerMcpManifestEntry,
  opts: McpSpawnerOptions = {},
): WorkerSpawner<McpSpawnParamsT> {
  // Validate the manifest entry once at registration. Throws on bad shape
  // so the operator sees the error at boot rather than at spawn.
  const validated = WorkerMcpManifestEntrySchema.parse(entry);
  const stepMaxWaitMs = opts.stepMaxWaitMs ?? DEFAULT_STEP_MAX_WAIT_MS;
  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const finalizeTimeoutMs = opts.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  const clientFactory = opts.clientFactory ?? defaultClientFactory;

  return {
    type: validated.type,
    displayName: validated.display_name,
    description: validated.description,
    tier: validated.tier,
    paramsSchema: McpSpawnParams,

    async spawn(params, ctx): Promise<WorkerInstance> {
      const bus = new WorkerEventBus();
      const client = await withTimeout(
        clientFactory(validated),
        initTimeoutMs,
        `mcp worker "${validated.type}" connect timed out`,
      );

      let initResult: WorkerInitResult;
      try {
        const raw = await withTimeout(
          client.callTool({
            name: 'worker_init',
            arguments: {
              params: params.params,
              context: {
                worker_id: ctx.workerId,
                worker_name: ctx.workerName,
              },
            },
          }),
          initTimeoutMs,
          `mcp worker "${validated.type}" worker_init timed out`,
        );
        initResult = parseToolResult(WorkerInitResultSchema, raw, 'worker_init');
      } catch (err) {
        await safeClose(client);
        throw err;
      }

      const sessionId = initResult.session_id;
      const metadata: Record<string, unknown> = {
        spawner_kind: 'mcp',
        mcp_command: validated.command,
        mcp_args: validated.args,
        mcp_session_id: sessionId,
        capabilities: initResult.capabilities,
        ...(initResult.initial_metadata ?? {}),
      } satisfies SpawnerMcpMetadata & Record<string, unknown>;

      let stopped = false;
      const stopController = new AbortController();
      const poller = pollStepsUntilDone({
        client,
        sessionId,
        bus,
        stepMaxWaitMs,
        signal: stopController.signal,
      })
        .catch((err) => {
          // A poll loop failure is the worker crashing — emit an error
          // event and synthesize an exit so the orchestrator's lifecycle
          // wiring fires and the WorkerRecord transitions to crashed.
          if (!stopped) {
            bus.emitError({ message: (err as Error).message, recoverable: false });
            bus.emitExit({ reason: 'crashed' });
          }
        })
        .finally(() => {
          void safeClose(client);
        });

      return {
        pid: undefined,
        metadata,
        events: bus,
        async terminate(force) {
          if (stopped) return {};
          stopped = true;
          stopController.abort();
          try {
            await withTimeout(
              client.callTool({
                name: 'worker_finalize',
                arguments: {
                  session_id: sessionId,
                  reason: 'terminated',
                  force,
                },
              }),
              finalizeTimeoutMs,
              `mcp worker "${validated.type}" worker_finalize timed out`,
            );
          } catch (err) {
            // Finalize failure during terminate is non-fatal — we're tearing
            // down anyway. Log and continue to safeClose.
            getLogger().warn('mcp worker finalize failed during terminate', {
              type: validated.type,
              worker_id: ctx.workerId,
              error: (err as Error).message,
            });
          }
          await poller;
          await safeClose(client);
          bus.emitExit({ reason: 'terminated' });
          return {};
        },
      };
    },
  };
}

interface PollOptions {
  client: Client;
  sessionId: string;
  bus: WorkerEventBus;
  stepMaxWaitMs: number;
  signal: AbortSignal;
}

/** Long-poll worker_step until a terminal step is returned or the signal
 *  is aborted. Each non-terminal step fans into the event bus.
 *
 *  We defer the first iteration by one event-loop turn so the orchestrator
 *  (or test harness) has a chance to attach listeners between spawn()
 *  resolving and the first step result arriving. Node's EventEmitter
 *  treats `error` events as unhandled when emitted before any listener
 *  attaches, so the deferral is load-bearing for the synthesized-exit path.
 *
 *  We also yield to the macrotask queue at the bottom of every iteration —
 *  in production the MCP child's stdio response is naturally macrotask-paced
 *  (real IO), but a child returning `idle` synchronously could starve the
 *  daemon's event loop without this. Tests with synchronous mock clients
 *  depend on this yield to let terminate() / signal.abort() propagate. */
async function pollStepsUntilDone(opts: PollOptions): Promise<void> {
  await yieldMacrotask();
  const { client, sessionId, bus, stepMaxWaitMs, signal } = opts;
  while (!signal.aborted) {
    let stepResult: WorkerStepResult;
    try {
      const raw = await client.callTool({
        name: 'worker_step',
        arguments: { session_id: sessionId, max_wait_ms: stepMaxWaitMs },
      });
      stepResult = parseToolResult(WorkerStepResultSchema, raw, 'worker_step');
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }

    if (signal.aborted) return;

    switch (stepResult.kind) {
      case 'idle':
        // No progress this window — loop again. The MCP child is responsible
        // for the actual wait (`max_wait_ms`); the macrotask yield below
        // ensures the daemon's other work gets fair scheduling even when
        // the child returns idle immediately.
        break;
      case 'progress':
        bus.emitProgress({
          message: stepResult.message,
          ...(stepResult.payload !== undefined ? { payload: stepResult.payload } : {}),
        });
        break;
      case 'log':
        bus.emitLog({
          stream: stepResult.stream,
          line: stepResult.line,
          ...(stepResult.format ? { format: stepResult.format } : {}),
          ...(stepResult.event !== undefined ? { event: stepResult.event } : {}),
          ...(stepResult.truncated ? { truncated: stepResult.truncated } : {}),
        });
        break;
      case 'metadata':
        bus.emitMetadata({ patch: stepResult.patch });
        break;
      case 'error':
        bus.emitError({ message: stepResult.message, recoverable: stepResult.recoverable });
        // We let the loop continue regardless of recoverable — non-recoverable
        // errors usually arrive immediately before a `completed` (the worker
        // reports the cause then closes) and the orchestrator's exit handler
        // is the canonical "mark record crashed" path. A future iteration
        // returning `completed` ends the loop normally.
        break;
      case 'completed':
        bus.emitExit({
          ...(stepResult.exit_code !== undefined ? { exitCode: stepResult.exit_code } : {}),
          reason: 'completed',
        });
        if (stepResult.final_metadata) {
          bus.emitMetadata({ patch: stepResult.final_metadata });
        }
        // After completed, call worker_finalize (best-effort) so the child
        // has a chance to clean up. We don't await it from the public path —
        // poller resolution is what the orchestrator waits on. Fire-and-
        // forget here is fine because safeClose at the end of the .finally()
        // chain will also shut down the transport.
        try {
          await client.callTool({
            name: 'worker_finalize',
            arguments: { session_id: sessionId, reason: 'completed' },
          });
        } catch {
          /* finalize-after-completed errors are non-fatal */
        }
        return;
    }
    // Yield between iterations so terminate()/signal.abort() and other
    // event-loop work can interleave even when the MCP child returns
    // synchronously (test mocks and very fast real workers).
    await yieldMacrotask();
  }
}

function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Default factory: spawns the MCP child via stdio. Tests override this. */
async function defaultClientFactory(entry: WorkerMcpManifestEntry): Promise<Client> {
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  });
  const client = new Client({
    name: 'stavr-worker-orchestrator',
    version: '0.7.0',
  });
  await client.connect(transport);
  return client;
}

/** MCP `callTool` returns `{ content: [{ type: 'text', text: '...' }, ...], structuredContent?: ... }`.
 *  Worker protocol responses MUST come back as the FIRST text content block
 *  as JSON. We accept either structuredContent (preferred — survives the
 *  round-trip cleanly) or parse the first text block. */
function parseToolResult<T>(
  schema: z.ZodSchema<T>,
  raw: unknown,
  toolName: string,
): T {
  const obj = raw as
    | {
        structuredContent?: unknown;
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      }
    | undefined;
  if (!obj) {
    throw new McpProtocolError(toolName, 'empty result');
  }
  if (obj.isError) {
    const msg = firstText(obj.content) ?? 'mcp tool returned isError=true';
    throw new McpProtocolError(toolName, msg);
  }
  let payload: unknown;
  if (obj.structuredContent !== undefined) {
    payload = obj.structuredContent;
  } else {
    const text = firstText(obj.content);
    if (!text) {
      throw new McpProtocolError(toolName, 'no structuredContent and no text content');
    }
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new McpProtocolError(toolName, `text content not JSON: ${(err as Error).message}`);
    }
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new McpProtocolError(toolName, `result failed schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

function firstText(content: Array<{ type: string; text?: string }> | undefined): string | undefined {
  if (!content) return undefined;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    /* swallow — transport teardown best-effort */
  }
}

export class McpProtocolError extends Error {
  readonly code = 'mcp_protocol_error' as const;
  constructor(public readonly tool: string, message: string) {
    super(`[${tool}] ${message}`);
  }
}
