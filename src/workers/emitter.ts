import { EventEmitter } from 'node:events';
import type {
  WorkerActivityInfo,
  WorkerErrorInfo,
  WorkerEventEmitter,
  WorkerExitInfo,
  WorkerLogInfo,
  WorkerMetadataInfo,
  WorkerProgressInfo,
} from './types.js';

/**
 * Internal helper a spawner uses to drive lifecycle events.
 *
 * The orchestrator only ever sees the public `WorkerEventEmitter` shape
 * (subscribe-only). The spawner keeps the bus and calls `emit*()` from
 * its event sources (child_process, chokidar, readline, ...).
 */
export class WorkerEventBus implements WorkerEventEmitter {
  private bus = new EventEmitter();

  on(event: 'activity', cb: (info: WorkerActivityInfo) => void): () => void;
  on(event: 'progress', cb: (info: WorkerProgressInfo) => void): () => void;
  on(event: 'metadata', cb: (info: WorkerMetadataInfo) => void): () => void;
  on(event: 'exit', cb: (info: WorkerExitInfo) => void): () => void;
  on(event: 'error', cb: (info: WorkerErrorInfo) => void): () => void;
  on(event: 'log', cb: (info: WorkerLogInfo) => void): () => void;
  on(event: string, cb: (info: never) => void): () => void {
    const wrapped = cb as (...args: unknown[]) => void;
    this.bus.on(event, wrapped);
    return () => this.bus.off(event, wrapped);
  }

  emitActivity(info: WorkerActivityInfo): void {
    this.bus.emit('activity', info);
  }
  emitProgress(info: WorkerProgressInfo): void {
    this.bus.emit('progress', info);
  }
  emitMetadata(info: WorkerMetadataInfo): void {
    this.bus.emit('metadata', info);
  }
  emitExit(info: WorkerExitInfo): void {
    this.bus.emit('exit', info);
  }
  emitError(info: WorkerErrorInfo): void {
    this.bus.emit('error', info);
  }
  emitLog(info: WorkerLogInfo): void {
    this.bus.emit('log', info);
  }
}
