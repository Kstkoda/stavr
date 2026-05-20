/**
 * Worker spawner protocol — ADR-042 Decision 5.
 *
 * Every worker type is conceptually an MCP server implementing a small set of
 * tools. This file defines the contract those servers MUST satisfy and the
 * lifecycle that wraps it. The actual adapter that runs a worker MCP child as
 * a `WorkerSpawner` lives in `spawner-mcp.ts`.
 *
 * The protocol is intentionally minimal:
 *   - `worker_init(params)` → returns session_id + capabilities
 *   - `worker_step(session_id)` → returns one step (progress / log / done)
 *   - `worker_finalize(session_id, reason)` → cleanup
 *
 * Optional tools the orchestrator probes for via `tools/list`:
 *   - `worker_inject(session_id, instruction)` — operator directives mid-flight
 *   - `worker_inspect(session_id)` — current snapshot for Topology inspector
 *   - `worker_pause(session_id)` / `worker_resume(session_id)`
 *
 * Built-in workers (cc, shell, unity, av-detector) stay as in-process
 * spawners — they are already proven; this protocol is the path for
 * third-party / family-federation worker types that arrive as standalone
 * MCP server child processes.
 */
import { z } from 'zod';

/** Required tool names. Worker MCP servers MUST implement all three. */
export const REQUIRED_TOOLS = ['worker_init', 'worker_step', 'worker_finalize'] as const;

/** Optional tool names the orchestrator probes via `tools/list`. */
export const OPTIONAL_TOOLS = [
  'worker_inject',
  'worker_inspect',
  'worker_pause',
  'worker_resume',
] as const;

export type RequiredTool = (typeof REQUIRED_TOOLS)[number];
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];
export type ProtocolTool = RequiredTool | OptionalTool;

/** Lifecycle states a spawner-protocol session moves through. */
export const SESSION_STATES = [
  'initializing',
  'running',
  'paused',
  'completed',
  'errored',
  'terminated',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Step kinds returned from `worker_step`. */
export const STEP_KINDS = ['idle', 'progress', 'log', 'metadata', 'error', 'completed'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Federation role attribution passed into `worker_init` so the spawned
 * worker can tag its events correctly. Cross-decision tie to ADR-042
 * Decision 1; the worker MCP server doesn't enforce role semantics, it just
 * carries the label so downstream event consumers can attribute correctly. */
export const FEDERATION_ROLES = ['originator', 'participant', 'convener'] as const;
export type FederationRole = (typeof FEDERATION_ROLES)[number];

/** `worker_init` input — the operator's request shape. `params` is the
 * worker-type-specific config (matches the spawner's paramsSchema in the
 * existing in-process spawners). `context` is broker/correlation metadata
 * the worker may attach to its emitted events. `budget` is advisory only —
 * the orchestrator enforces it via terminate; the worker may use it to
 * self-throttle. */
export const WorkerInitInputSchema = z.object({
  params: z.unknown(),
  context: z
    .object({
      worker_id: z.string().min(1),
      worker_name: z.string().min(1),
      correlation_id: z.string().optional(),
      federation_role: z.enum(FEDERATION_ROLES).optional(),
      originator_peer: z.string().optional(),
    })
    .strict(),
  budget: z
    .object({
      max_runtime_ms: z.number().int().positive().optional(),
      max_steps: z.number().int().positive().optional(),
    })
    .optional(),
});

export type WorkerInitInput = z.infer<typeof WorkerInitInputSchema>;

/** `worker_init` result. `session_id` is opaque to the orchestrator; it just
 * round-trips on every subsequent call. `capabilities` echoes which optional
 * tools the worker actually supports (the orchestrator could also derive
 * this from tools/list, but echoing is safer — server may register a tool
 * without implementing it). */
export const WorkerInitResultSchema = z.object({
  session_id: z.string().min(1),
  capabilities: z.object({
    inject: z.boolean(),
    inspect: z.boolean(),
    pause_resume: z.boolean(),
  }),
  initial_metadata: z.record(z.unknown()).optional(),
});

export type WorkerInitResult = z.infer<typeof WorkerInitResultSchema>;

/** `worker_step` input. */
export const WorkerStepInputSchema = z.object({
  session_id: z.string().min(1),
  /** Max ms the worker may block waiting for progress before returning an
   *  `idle` step. Default 5s. Long-poll semantics keep CPU spend on the
   *  worker side, not the orchestrator. */
  max_wait_ms: z.number().int().nonnegative().max(60_000).default(5000),
});

export type WorkerStepInput = z.infer<typeof WorkerStepInputSchema>;

/** `worker_step` result. The `kind` field discriminates the payload shape.
 *  Workers that have finished MUST return `kind: "completed"` (or `errored`)
 *  exactly once; subsequent calls with the same session_id MUST return an
 *  error from the MCP layer (session no longer valid). */
export const WorkerStepResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('progress'),
    message: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    line: z.string(),
    format: z.enum(['raw', 'stream-json']).optional(),
    event: z.unknown().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('metadata'),
    patch: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    recoverable: z.boolean(),
  }),
  z.object({
    kind: z.literal('completed'),
    exit_code: z.number().int().optional(),
    final_metadata: z.record(z.unknown()).optional(),
  }),
]);

export type WorkerStepResult = z.infer<typeof WorkerStepResultSchema>;

/** `worker_finalize` input. */
export const WorkerFinalizeInputSchema = z.object({
  session_id: z.string().min(1),
  reason: z.enum(['completed', 'terminated', 'crashed', 'idle_timeout']),
  force: z.boolean().optional().default(false),
});

export type WorkerFinalizeInput = z.infer<typeof WorkerFinalizeInputSchema>;

/** `worker_inject` input — operator directives mid-flight. Optional capability;
 *  workers advertise support via `capabilities.inject` in worker_init result. */
export const WorkerInjectInputSchema = z.object({
  session_id: z.string().min(1),
  instruction: z.string().min(1),
  message_id: z.string().optional(),
});

export type WorkerInjectInput = z.infer<typeof WorkerInjectInputSchema>;

/** Manifest entry for a worker MCP server (loaded from
 *  `~/.stavr/worker-mcp-servers.yaml`). Mirrors the StdioClientTransport
 *  parameter shape so it can be passed straight through. */
export const WorkerMcpManifestEntrySchema = z.object({
  /** The worker `type` this MCP server backs (e.g., "python", "ollama-codegen"). */
  type: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'type must be kebab-case'),
  /** Short human label for the workers list UI. */
  display_name: z.string().min(1),
  /** One-line description shown in the spawn picker. */
  description: z.string().min(1),
  /** Tier gate applied at spawn time (AUTO/CONFIRM mapping to the worker_spawn
   *  tool gate in the orchestrator). Defaults to 'confirm' — MCP workers are
   *  third-party code by definition and deserve an explicit OK. */
  tier: z.enum(['auto', 'confirm', 'never']).default('confirm'),
  /** Executable to spawn the MCP server. */
  command: z.string().min(1),
  /** CLI args. */
  args: z.array(z.string()).optional().default([]),
  /** Optional cwd for the spawned MCP server. */
  cwd: z.string().optional(),
  /** Extra environment vars to pass (merged on top of inherited safe defaults). */
  env: z.record(z.string()).optional(),
  /** Optional zod-shape hint for the orchestrator's listTypes() — purely
   *  informational. The actual validation happens on the MCP child side
   *  via worker_init's params field, which is z.unknown() at this layer. */
  params_hint: z.record(z.unknown()).optional(),
});

export type WorkerMcpManifestEntry = z.infer<typeof WorkerMcpManifestEntrySchema>;

export const WorkerMcpManifestSchema = z.object({
  workers: z.array(WorkerMcpManifestEntrySchema).default([]),
});

export type WorkerMcpManifest = z.infer<typeof WorkerMcpManifestSchema>;

/** Adapter info attached to the worker record's metadata when the worker is
 *  backed by an MCP server. Lets the dashboard distinguish "in-process shell"
 *  from "MCP-backed python" without rendering the type string ad-hoc. */
export interface SpawnerMcpMetadata {
  spawner_kind: 'mcp';
  mcp_command: string;
  mcp_args: string[];
  mcp_session_id: string;
  capabilities: WorkerInitResult['capabilities'];
}
