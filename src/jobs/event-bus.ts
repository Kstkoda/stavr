/**
 * JobEventBus — internal helper bindings use to drive the JobEventEmitter
 * surface. The orchestrator sees the read-only `JobEventEmitter` shape; the
 * binding keeps the bus and calls `emit*()` from its event sources.
 *
 * Parallels src/workers/emitter.ts. Phase 3 cutover deletes the worker
 * emitter once nothing reads it.
 */
import { EventEmitter } from 'node:events';
import type {
  JobActivityInfo,
  JobErrorInfo,
  JobEventEmitter,
  JobExitInfo,
  JobLogInfo,
  JobMetadataInfo,
  JobProgressInfo,
} from './types.js';

export class JobEventBus implements JobEventEmitter {
  private bus = new EventEmitter();

  on(event: 'activity', cb: (info: JobActivityInfo) => void): () => void;
  on(event: 'progress', cb: (info: JobProgressInfo) => void): () => void;
  on(event: 'metadata', cb: (info: JobMetadataInfo) => void): () => void;
  on(event: 'log', cb: (info: JobLogInfo) => void): () => void;
  on(event: 'error', cb: (info: JobErrorInfo) => void): () => void;
  on(event: 'exit', cb: (info: JobExitInfo) => void): () => void;
  on(event: string, cb: (info: never) => void): () => void {
    const wrapped = cb as (...args: unknown[]) => void;
    this.bus.on(event, wrapped);
    return () => this.bus.off(event, wrapped);
  }

  emitActivity(info: JobActivityInfo): void {
    this.bus.emit('activity', info);
  }
  emitProgress(info: JobProgressInfo): void {
    this.bus.emit('progress', info);
  }
  emitMetadata(info: JobMetadataInfo): void {
    this.bus.emit('metadata', info);
  }
  emitLog(info: JobLogInfo): void {
    this.bus.emit('log', info);
  }
  emitError(info: JobErrorInfo): void {
    this.bus.emit('error', info);
  }
  emitExit(info: JobExitInfo): void {
    this.bus.emit('exit', info);
  }
}
