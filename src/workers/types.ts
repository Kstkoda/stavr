import type { z } from 'zod';
import type { Broker } from '../broker.js';
import type { EventStore, WorkerRecord, WorkerStatusT } from '../persistence.js';
import type { EventKindT } from '../event-types.js';

export type WorkerStatus = WorkerStatusT;
export type { WorkerRecord } from '../persistence.js';

export type WorkerEventName = 'activity' | 'progress' | 'metadata' | 'exit' | 'error';

export interface WorkerActivityInfo {
  detail?: string;
}
export interface WorkerProgressInfo {
  message: string;
  payload?: unknown;
}
export interface WorkerMetadataInfo {
  patch: Record<string, unknown>;
}
export interface WorkerExitInfo {
  exitCode?: number;
  reason: 'completed' | 'crashed' | 'terminated';
}
export interface WorkerErrorInfo {
  message: string;
  recoverable: boolean;
}

export interface WorkerEventEmitter {
  on(event: 'activity', cb: (info: WorkerActivityInfo) => void): () => void;
  on(event: 'progress', cb: (info: WorkerProgressInfo) => void): () => void;
  on(event: 'metadata', cb: (info: WorkerMetadataInfo) => void): () => void;
  on(event: 'exit', cb: (info: WorkerExitInfo) => void): () => void;
  on(event: 'error', cb: (info: WorkerErrorInfo) => void): () => void;
}

export interface WorkerSpawnerContext {
  workerId: string;
  workerName: string;
  broker: Broker;
  store: EventStore;
  emit: (kind: EventKindT, payload: unknown, correlationId?: string) => Promise<void>;
}

export interface WorkerInstance {
  pid: number | undefined;
  metadata: Record<string, unknown>;
  events: WorkerEventEmitter;
  terminate(force: boolean): Promise<{ exitCode?: number }>;
}

export interface WorkerSpawner<TParams = unknown> {
  readonly type: string;
  readonly displayName: string;
  readonly description: string;
  readonly tier: 'auto' | 'confirm' | 'never';
  readonly paramsSchema: z.ZodTypeAny;
  /** Marker for TParams so the generic isn't erased. */
  readonly __tparams?: TParams;

  spawn(params: TParams, ctx: WorkerSpawnerContext): Promise<WorkerInstance>;

  dispatch?(
    worker: WorkerRecord,
    message: { id: string; body: unknown },
    ctx: WorkerSpawnerContext,
  ): Promise<void>;
}

export class DispatchNotSupportedError extends Error {
  code = 'dispatch_not_supported' as const;
  constructor(public readonly type: string) {
    super(`worker type "${type}" does not support dispatch`);
  }
}
