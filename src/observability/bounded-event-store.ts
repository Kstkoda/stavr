/**
 * Bounded in-memory `EventStore` for `StreamableHTTPServerTransport`
 * resumability. Per-stream ring buffer; bounded BY CONSTRUCTION (count
 * + age), evicted on insert — never via a janitor sweep.
 *
 * Why bounded-by-construction matters: the v0.6.x memory-leak class came
 * from data structures that grew without an enforcement point on every
 * insert. The SDK's reference `InMemoryEventStore` is unbounded by design
 * ("primarily intended for examples and testing"). This implementation
 * is the production substitute.
 *
 * Per-session ownership: one `BoundedEventStore` per
 * `StreamableHTTPServerTransport` instance. When the transport closes
 * (transports.ts onclose), the store becomes unreachable and is GC'd
 * along with all its buffers — no explicit teardown needed.
 *
 * EventId encoding: `${streamId}:${seq}`. `getStreamIdForEventId` decodes
 * the streamId from the prefix so the SDK can locate the right per-stream
 * buffer on `last-event-id` replay. seq is monotonic across the whole
 * store so eventIds remain unique even after a buffer wraps.
 */
import type {
  EventStore,
  StreamId,
  EventId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface BoundedEventStoreOpts {
  /** Max events per stream. Default 256. */
  maxEventsPerStream?: number;
  /** Max event age per stream, in ms. Default 5 minutes. */
  maxAgeMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

interface StoredEvent {
  eventId: EventId;
  ts: number;
  message: JSONRPCMessage;
}

export class BoundedEventStore implements EventStore {
  readonly maxEventsPerStream: number;
  readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private seq = 0;

  constructor(opts: BoundedEventStoreOpts = {}) {
    this.maxEventsPerStream = opts.maxEventsPerStream ?? 256;
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const ts = this.now();
    const eventId = `${streamId}:${++this.seq}`;
    let buf = this.streams.get(streamId);
    if (!buf) {
      buf = [];
      this.streams.set(streamId, buf);
    }
    buf.push({ eventId, ts, message });
    this.prune(streamId, buf, ts);
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    // Walk back to the last ':' — streamIds the SDK passes us are opaque
    // UUIDs in practice but the contract doesn't forbid colons, so we
    // recover the seq from the tail rather than splitting once.
    const idx = eventId.lastIndexOf(':');
    if (idx <= 0) return undefined;
    const streamId = eventId.slice(0, idx);
    return this.streams.has(streamId) ? streamId : undefined;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = await this.getStreamIdForEventId(lastEventId);
    if (!streamId) return '';
    const buf = this.streams.get(streamId);
    if (!buf) return '';
    let found = false;
    for (const ev of buf) {
      if (!found) {
        if (ev.eventId === lastEventId) found = true;
        continue;
      }
      await send(ev.eventId, ev.message);
    }
    return streamId;
  }

  /** Returns the number of events currently buffered for `streamId`. */
  sizeOf(streamId: StreamId): number {
    return this.streams.get(streamId)?.length ?? 0;
  }

  /** Number of streams currently holding any events. */
  streamCount(): number {
    return this.streams.size;
  }

  private prune(streamId: StreamId, buf: StoredEvent[], now: number): void {
    // Age cap first — drop from the front while too old.
    const cutoff = now - this.maxAgeMs;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
    // Count cap — drop from the front while over limit.
    while (buf.length > this.maxEventsPerStream) buf.shift();
    if (buf.length === 0) this.streams.delete(streamId);
  }
}
