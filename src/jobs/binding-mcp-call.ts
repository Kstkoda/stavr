/**
 * mcp-call binding — Phase 2 of worker-dispatch-bom.md.
 *
 * Calls a configured tool on an MCP server, one call per dispatch. The result
 * of the tool becomes the job's terminal result; the binding emits a single
 * `progress` event with the tool's return value, then `exit` with
 * reason='completed'.
 *
 * Long-running MCP workers (the worker_init / worker_step / worker_finalize
 * pattern in src/workers/spawner-protocol.ts) are a DIFFERENT shape — they
 * stay in src/workers/spawner-mcp.ts until Phase 3 cutover. The BOM's word
 * on this: "MCP-call — to a genuine MCP server (e.g. a git MCP). A short
 * one is just an `invoke`." This binding IS the short one; the long form
 * gets handled by a higher-level pattern layered on top OR migrated at
 * Phase 3.
 *
 * Capability declaration:
 *   - inject = true  when the factory is given an `inject_tool_name` (a
 *                    tool on the same MCP server that accepts mid-flight
 *                    messages); the BindingHandle's inject() calls that
 *                    tool with `{ message_id, body }` arguments.
 *   - inject = false when no inject_tool_name is configured. The factory
 *                    omits the inject method on the returned binding.
 *
 * Connection:
 *   - The factory accepts either (a) an `mcp` stdio config that the binding
 *     uses to spawn an MCP server child via StdioClientTransport at dispatch
 *     time, OR (b) a `clientFactory()` callback for tests + advanced
 *     operator configs (already-connected client, custom transport).
 *   - One Client instance per dispatch — Phase 2 keeps connection management
 *     dumb. Later phases may pool / reuse.
 */
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { JobEventBus } from './event-bus.js';
import type {
  BindingCapabilities,
  BindingContext,
  BindingHandle,
  ExecutorBinding,
} from './types.js';

/** Operator-supplied per-dispatch params: the arguments to the configured
 *  MCP tool. Free-form on purpose — each named target has its own argument
 *  contract enforced by the MCP server. */
export const McpCallParams = z.object({
  arguments: z.record(z.unknown()).default({}),
});

export type McpCallParamsT = z.infer<typeof McpCallParams>;

export interface McpCallStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpCallBindingOptions {
  /** Named target inside the mcp-call kind (e.g. 'git-mcp', 'github-mcp'). */
  target: string;
  /** Human label shown in `listBindings()`. */
  displayName: string;
  /** One-line description for the listing. */
  description: string;
  /** The MCP tool to call on every dispatch. */
  tool_name: string;
  /** Optional tool the binding's inject() routes to. Setting this turns on
   *  the `inject` capability. */
  inject_tool_name?: string;
  /** How the binding obtains an MCP Client. Operators provide stdio config;
   *  tests inject a clientFactory. Exactly one MUST be set. */
  mcp?: McpCallStdioConfig;
  clientFactory?: () => Promise<Client>;
  /** Override the default per-call timeout (ms). Default 30s. */
  callTimeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export function createMcpCallBinding(
  opts: McpCallBindingOptions,
): ExecutorBinding<McpCallParamsT> {
  if (!opts.mcp && !opts.clientFactory) {
    throw new Error(
      `createMcpCallBinding(${opts.target}): exactly one of { mcp, clientFactory } must be set`,
    );
  }
  if (opts.mcp && opts.clientFactory) {
    throw new Error(
      `createMcpCallBinding(${opts.target}): provide only one of { mcp, clientFactory }, not both`,
    );
  }

  const capabilities: BindingCapabilities = {
    inject: !!opts.inject_tool_name,
  };
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return {
    kind: 'mcp-call',
    target: opts.target,
    displayName: opts.displayName,
    description: opts.description,
    capabilities,
    paramsSchema: McpCallParams,

    async dispatch(params, _ctx: BindingContext): Promise<BindingHandle> {
      const bus = new JobEventBus();
      const client = await connectClient(opts);

      let exited = false;
      let terminated = false;
      const callController = new AbortController();

      // Run the configured tool in the background; let dispatch() return so
      // the orchestrator can subscribe to events first.
      const callPromise = withTimeout(
        client.callTool({ name: opts.tool_name, arguments: params.arguments }),
        callTimeoutMs,
        callController.signal,
        `mcp-call:${opts.target} tool "${opts.tool_name}" timed out`,
      )
        .then((result) => {
          if (exited) return;
          // The MCP tool's return shape is { content: [...], isError?, ... };
          // we surface the full envelope as both a progress payload (for
          // streaming observers) and the terminal result.
          bus.emitProgress({
            message: `mcp-call:${opts.target}:${opts.tool_name} returned`,
            payload: result,
          });
          const isError = isToolErrorResult(result);
          exited = true;
          bus.emitExit({
            reason: isError ? 'crashed' : 'completed',
            result,
            exitCode: isError ? 1 : 0,
          });
        })
        .catch((err) => {
          if (exited) return;
          bus.emitError({ message: (err as Error).message, recoverable: false });
          exited = true;
          bus.emitExit({ reason: 'crashed' });
        })
        .finally(() => {
          void safeClose(client);
        });

      const handle: BindingHandle = {
        pid: undefined,
        metadata: {
          mcp_tool: opts.tool_name,
          ...(opts.mcp ? { mcp_command: opts.mcp.command } : {}),
        },
        events: bus,
        async terminate(_force: boolean) {
          if (terminated) return {};
          terminated = true;
          callController.abort();
          await callPromise.catch(() => {
            /* already swallowed */
          });
          // Only emit a synthetic terminated exit if the call didn't already
          // produce one (it usually will, because abort makes the in-flight
          // call reject which we map to an exit — but if the call was
          // resolving at exactly the moment we aborted, exited could be true
          // here).
          if (!exited) {
            exited = true;
            bus.emitExit({ reason: 'terminated' });
          }
          return {};
        },
        ...(opts.inject_tool_name
          ? {
              async inject(message): Promise<void> {
                if (terminated) {
                  throw new Error(`mcp-call:${opts.target} terminated; cannot inject`);
                }
                await client.callTool({
                  name: opts.inject_tool_name!,
                  arguments: {
                    message_id: message.id,
                    body: message.body,
                  },
                });
              },
            }
          : {}),
      };
      return handle;
    },
  };
}

async function connectClient(opts: McpCallBindingOptions): Promise<Client> {
  if (opts.clientFactory) return opts.clientFactory();
  if (!opts.mcp) {
    // Unreachable — guarded at construction time.
    throw new Error('mcp-call binding misconfigured: no client source');
  }
  // Defer the MCP SDK + stdio transport imports so tests using the
  // clientFactory path never load the real transport (and don't pay the
  // child_process spawn cost). The dynamic import is named so esbuild /
  // tsx keep it bundleable.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: opts.mcp.command,
    args: opts.mcp.args ?? [],
    env: opts.mcp.env,
    cwd: opts.mcp.cwd,
  });
  const client = new Client(
    { name: 'stavr-mcp-call', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    /* nothing useful to do — transport may have already torn down */
  }
}

/**
 * MCP tool-call results conventionally use `isError: true` to signal that the
 * call succeeded at the transport layer but the tool itself reported failure.
 * We treat that as a crashed-binding exit; the orchestrator marks the job
 * crashed and the operator sees the error payload in the terminal result.
 */
function isToolErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { isError?: unknown };
  return r.isError === true;
}

/**
 * Race a promise against (a) a deadline timer and (b) an abort signal.
 * Returns the promise's value, or throws on timeout / abort.
 */
function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
