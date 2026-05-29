/**
 * The job + binding type vocabulary (Phase 1 of proposed/worker-dispatch-bom.md).
 *
 * This is the GENERIC substrate. A `job` is a stavR-owned lifecycle record
 * (dispatched → running → heartbeating → terminal → result), decoupled from
 * the executor binding (how the actual work is reached). The binding is the
 * free axis with exactly four kinds; the catalogue of named targets within
 * each kind is open.
 *
 * The four binding kinds are a closed enum. The BOM is explicit: "if the
 * bindings regrow into a sprawling executor type taxonomy, the bespoke
 * worker runtime has been quietly rebuilt." Resist a fifth kind.
 */
import type { z } from 'zod';
import type { Broker } from '../broker.js';
import type { EventStore } from '../persistence.js';
import type { EventKindT } from '../event-types.js';
import type { JobLifecycleState } from './lifecycle.js';

/**
 * The four binding kinds. Closed enum.
 *
 *   - mcp-call            — call a genuine MCP server (e.g., a git MCP).
 *   - http                — local Ollama, or a remote HTTP endpoint.
 *   - process-spawn       — legacy CLI tool, or headless `claude -p` for CC.
 *   - cc-session-attach   — attach to an already-running Claude Code session
 *                           (no spawn, no lifecycle ownership). Preferred over
 *                           process-spawn for CC (2026-05-20 crash lesson).
 */
export const BINDING_KINDS = [
  'mcp-call',
  'http',
  'process-spawn',
  'cc-session-attach',
] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

/**
 * Job budget. Advisory at dispatch — the orchestrator enforces it by
 * terminating the binding handle when limits are exceeded. The credit_pool
 * field is the 2026-06-15 carve-out: `claude -p` / Agent-SDK on subscription
 * plans draws a separate monthly credit pool; we must record which pool a CC
 * job spends against.
 */
export interface JobBudget {
  max_runtime_ms?: number;
  max_steps?: number;
  /** Which credit pool this job's spend counts against. Free-form so we can
   *  add pools without a schema change; the current ones are
   *  'subscription-api' and 'subscription-cc' (post-2026-06-15). */
  credit_pool?: string;
}

/**
 * A binding event the orchestrator wires into the broker. Mirrors the shape
 * the existing worker `WorkerEventEmitter` uses so the cutover (Phase 3) is
 * a rename + re-pipe, not a re-design.
 */
export type JobEventName =
  | 'activity'
  | 'progress'
  | 'metadata'
  | 'log'
  | 'error'
  | 'exit';

export interface JobActivityInfo {
  detail?: string;
}
export interface JobProgressInfo {
  message: string;
  payload?: unknown;
}
export interface JobMetadataInfo {
  patch: Record<string, unknown>;
}
export interface JobLogInfo {
  stream: 'stdout' | 'stderr';
  line: string;
  format?: 'stream-json' | 'raw';
  event?: unknown;
  truncated?: boolean;
}
export interface JobErrorInfo {
  message: string;
  recoverable: boolean;
}
export interface JobExitInfo {
  exitCode?: number;
  reason: 'completed' | 'crashed' | 'terminated';
  result?: unknown;
}

export interface JobEventEmitter {
  on(event: 'activity', cb: (info: JobActivityInfo) => void): () => void;
  on(event: 'progress', cb: (info: JobProgressInfo) => void): () => void;
  on(event: 'metadata', cb: (info: JobMetadataInfo) => void): () => void;
  on(event: 'log', cb: (info: JobLogInfo) => void): () => void;
  on(event: 'error', cb: (info: JobErrorInfo) => void): () => void;
  on(event: 'exit', cb: (info: JobExitInfo) => void): () => void;
}

/**
 * Per-dispatch context the orchestrator hands to a binding. The binding uses
 * this to publish events on the broker as it runs.
 */
export interface BindingContext {
  jobId: string;
  jobName: string;
  broker: Broker;
  store: EventStore;
  /** Publish a broker event with this job as the source. Used by bindings that
   *  want to emit binding-specific structured events alongside the standard
   *  progress/log channel. */
  emit: (kind: EventKindT, payload: unknown, correlationId?: string) => Promise<void>;
}

/**
 * The running handle returned from `binding.dispatch()`. The orchestrator
 * subscribes to `events`, drives the lifecycle into the JobRecord, and calls
 * `terminate()` on operator request or budget exhaustion.
 *
 * Optional `inject()` replaces today's `WorkerSpawner.dispatch?` — present
 * only on bindings that support mid-flight injection (e.g. the MCP-call
 * binding when the target implements the optional `worker_inject` tool).
 * The process-spawn binding does NOT implement inject in Phase 1.
 */
export interface BindingHandle {
  /** OS pid for process-spawn / cc-session-attach bindings; undefined for the
   *  others. Surfaced on the JobRecord's metadata. */
  pid: number | undefined;
  /** Free-form metadata the binding wants pinned on the JobRecord at start
   *  (cwd, transport URL, attached session id, ...). */
  metadata: Record<string, unknown>;
  /** Event channel — orchestrator subscribes immediately on dispatch return. */
  events: JobEventEmitter;
  /** Terminate the running work. `force=true` maps to SIGKILL / immediate
   *  disconnect; `force=false` is a graceful request. The binding MUST emit
   *  an `exit` event before this promise resolves. */
  terminate(force: boolean): Promise<{ exitCode?: number }>;
  /** Optional mid-flight injection. Bindings advertise this via the
   *  `capabilities` field on the dispatch result. */
  inject?(message: { id: string; body: unknown }): Promise<void>;
}

/**
 * Capabilities the binding advertises at dispatch — what the orchestrator
 * can do with this handle beyond start/terminate.
 */
export interface BindingCapabilities {
  inject: boolean;
}

/**
 * The unified binding interface. Phase 1 ships the model end-to-end with ONE
 * binding (process-spawn — see binding-process-spawn.ts). Phase 2 adds the
 * other three (mcp-call, http, cc-session-attach). Phase 3 cuts the bespoke
 * worker subsystem over to bindings.
 *
 * Each binding declares:
 *   - kind   — one of the four closed kinds
 *   - target — the named target within the kind (e.g. 'claude-code-subprocess',
 *              'ollama-local', 'git-mcp', 'cowork-session'). Open catalogue.
 *   - paramsSchema — zod for the operator-supplied params (cwd, command, ...)
 *   - dispatch     — start the work, return a running handle
 */
export interface ExecutorBinding<TParams = unknown> {
  readonly kind: BindingKind;
  readonly target: string;
  readonly displayName: string;
  readonly description: string;
  readonly paramsSchema: z.ZodTypeAny;
  readonly capabilities: BindingCapabilities;
  /** Marker for TParams so the generic isn't erased. */
  readonly __tparams?: TParams;

  dispatch(params: TParams, ctx: BindingContext): Promise<BindingHandle>;
}

/**
 * The JobRecord — stavR-owned lifecycle record, persisted to the `jobs`
 * table (see persistence.ts). Read by the orchestrator, the dashboard,
 * watchdog, retention scheduler, and (Phase 5) the federation receiver.
 */
export interface JobRecord {
  id: string;
  name: string;
  binding_kind: BindingKind;
  binding_target: string;
  params_hash: string;
  lifecycle_state: JobLifecycleState;
  started_at: string;
  ended_at?: string;
  last_activity_at?: string;
  metadata: Record<string, unknown>;
  termination_reason?:
    | 'completed'
    | 'crashed'
    | 'terminated_by_user'
    | 'budget_exceeded'
    | 'shed_by_host';
  exit_code?: number;
  result?: unknown;
  budget?: JobBudget;
  audit_correlation_id?: string;
  /** Federation attribution. NULL for purely local jobs. */
  federation_role?: 'originator' | 'participant' | 'convener';
  originator_peer?: string;
  /** Phase 4 — the trust scope this job runs under. NULL when no scope is
   *  active (operator dispatching locally). */
  grant_id?: string;
}

export interface JobDescriptor {
  kind: BindingKind;
  target: string;
  displayName: string;
  description: string;
  paramsSchema: unknown;
  capabilities: BindingCapabilities;
}
