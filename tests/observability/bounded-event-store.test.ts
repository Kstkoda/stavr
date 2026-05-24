import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BoundedEventStore } from '../../src/observability/bounded-event-store.js';

function mkMsg(n: number): JSONRPCMessage {
  return { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'debug', data: { n } } };
}

describe('BoundedEventStore', () => {
  it('honours documented defaults', () => {
    const s = new BoundedEventStore();
    expect(s.maxEventsPerStream).toBe(256);
    expect(s.maxAgeMs).toBe(5 * 60 * 1000);
  });

  it('returns unique, decodable eventIds keyed to the stream', async () => {
    const s = new BoundedEventStore();
    const e1 = await s.storeEvent('streamA', mkMsg(1));
    const e2 = await s.storeEvent('streamA', mkMsg(2));
    const e3 = await s.storeEvent('streamB', mkMsg(3));
    expect(e1).not.toBe(e2);
    expect(await s.getStreamIdForEventId(e1)).toBe('streamA');
    expect(await s.getStreamIdForEventId(e2)).toBe('streamA');
    expect(await s.getStreamIdForEventId(e3)).toBe('streamB');
    expect(await s.getStreamIdForEventId('not-a-real-id')).toBeUndefined();
  });

  it('enforces the count bound on every insert (no janitor)', async () => {
    const s = new BoundedEventStore({ maxEventsPerStream: 256, maxAgeMs: 60 * 60 * 1000 });
    // Push significantly more than the cap — the buffer must never exceed it.
    for (let i = 0; i < 1000; i++) {
      await s.storeEvent('stream', mkMsg(i));
      // The invariant is on EVERY insert, not just at the end.
      expect(s.sizeOf('stream')).toBeLessThanOrEqual(256);
    }
    expect(s.sizeOf('stream')).toBe(256);
  });

  it('enforces the age bound, evicting older events on insert', async () => {
    let t = 1_000_000;
    const s = new BoundedEventStore({ maxEventsPerStream: 1000, maxAgeMs: 5 * 60 * 1000, now: () => t });
    await s.storeEvent('stream', mkMsg(0));
    expect(s.sizeOf('stream')).toBe(1);
    // Advance 4 min — entry stays.
    t += 4 * 60 * 1000;
    await s.storeEvent('stream', mkMsg(1));
    expect(s.sizeOf('stream')).toBe(2);
    // Advance past the 5-min cutoff measured from the FIRST event.
    t += 2 * 60 * 1000;
    await s.storeEvent('stream', mkMsg(2));
    // Event 0 was ~6min old at insert time of event 2 — evicted.
    expect(s.sizeOf('stream')).toBe(2);
    // Advance well past the cutoff and insert again.
    t += 10 * 60 * 1000;
    await s.storeEvent('stream', mkMsg(3));
    expect(s.sizeOf('stream')).toBe(1);
  });

  it('frees the stream slot when its own buffer empties on insert', async () => {
    let t = 0;
    const s = new BoundedEventStore({ maxAgeMs: 1000, now: () => t });
    await s.storeEvent('stream', mkMsg(1));
    expect(s.streamCount()).toBe(1);
    // Advance well past the age cap, then insert into the SAME stream.
    // The age-prune drops the old event before the new one is appended.
    t = 1_000_000;
    await s.storeEvent('stream', mkMsg(2));
    expect(s.sizeOf('stream')).toBe(1);
    // Cross-stream is lazy by design — pruning happens on touch, not
    // globally. The whole store is GC'd when its owning transport closes,
    // so untouched stale buffers are not a leak.
  });

  it('replays exactly the events after the given lastEventId, same stream only', async () => {
    const s = new BoundedEventStore();
    const a1 = await s.storeEvent('A', mkMsg(1));
    const a2 = await s.storeEvent('A', mkMsg(2));
    const a3 = await s.storeEvent('A', mkMsg(3));
    await s.storeEvent('B', mkMsg(99));

    const sent: Array<{ id: string; n: number }> = [];
    const returnedStream = await s.replayEventsAfter(a1, {
      send: async (id, msg) => {
        const params = (msg as { params: { data: { n: number } } }).params;
        sent.push({ id, n: params.data.n });
      },
    });
    expect(returnedStream).toBe('A');
    expect(sent).toEqual([
      { id: a2, n: 2 },
      { id: a3, n: 3 },
    ]);
  });

  it('returns empty streamId when lastEventId is unknown', async () => {
    const s = new BoundedEventStore();
    await s.storeEvent('stream', mkMsg(1));
    const result = await s.replayEventsAfter('ghost:42', { send: async () => {} });
    expect(result).toBe('');
  });

  it('isolates streams: heavy load on one does not evict from another', async () => {
    const s = new BoundedEventStore({ maxEventsPerStream: 10, maxAgeMs: 60 * 60 * 1000 });
    await s.storeEvent('quiet', mkMsg(0));
    for (let i = 0; i < 100; i++) await s.storeEvent('busy', mkMsg(i));
    expect(s.sizeOf('quiet')).toBe(1);
    expect(s.sizeOf('busy')).toBe(10);
  });
});
