import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../../src/persistence.js';
import { Broker } from '../../src/broker.js';
import { mountTransports, type MountedTransports } from '../../src/transports.js';
import { runTail } from '../../src/tail.js';

describe('stavr tail', () => {
  let store: EventStore;
  let broker: Broker;
  let transports: MountedTransports;
  let port: number;

  beforeEach(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    // Port 0 → OS assigns a free port
    transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
    port = (transports.httpServer!.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await transports.shutdown();
  });

  it('replays events emitted before connection when --since covers them', async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      await broker.publish({
        kind: 'progress',
        at: new Date().toISOString(),
        source_agent: 'test-agent',
        payload: { message: `msg-${i}` },
      });
    }

    const lines: string[] = [];
    const ac = new AbortController();

    const done = runTail(
      {
        url: `http://127.0.0.1:${port}`,
        since: '1m',
        noColor: true,
        signal: ac.signal,
        initialBackoffMs: 100,
        giveUpAfterMs: 5_000,
      },
      (line) => {
        lines.push(line);
        if (lines.length >= N) ac.abort();
      },
    );

    await done.catch(() => {});

    expect(lines).toHaveLength(N);
    expect(lines[0]).toContain('progress');
    expect(lines[0]).toContain('test-agent');
    expect(lines[0]).toContain('msg-0');
    expect(lines[N - 1]).toContain('msg-4');
  });

  it('streams live events after connecting', async () => {
    const lines: string[] = [];
    const ac = new AbortController();

    // Connect and collect 3 events
    const done = runTail(
      {
        url: `http://127.0.0.1:${port}`,
        noColor: true,
        signal: ac.signal,
        initialBackoffMs: 100,
        giveUpAfterMs: 5_000,
      },
      (line) => {
        lines.push(line);
        if (lines.length >= 3) ac.abort();
      },
    );

    // Give the SSE connection a moment to establish, then emit
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) {
      await broker.publish({
        kind: 'progress',
        at: new Date().toISOString(),
        source_agent: 'live-agent',
        payload: { message: `live-${i}` },
      });
    }

    await done.catch(() => {});

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('live-0');
  });

  it('outputs raw JSON when --json flag is set', async () => {
    await broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'json-test',
      payload: { message: 'hello' },
    });

    const lines: string[] = [];
    const ac = new AbortController();

    await runTail(
      {
        url: `http://127.0.0.1:${port}`,
        since: '1m',
        json: true,
        signal: ac.signal,
        initialBackoffMs: 100,
        giveUpAfterMs: 5_000,
      },
      (line) => {
        lines.push(line);
        ac.abort();
      },
    ).catch(() => {});

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe('progress');
    expect(parsed.source_agent).toBe('json-test');
  });

  it('filters by kind when --kind is specified', async () => {
    await broker.publish({
      kind: 'progress',
      at: new Date().toISOString(),
      source_agent: 'filter-test',
      payload: { message: 'should-skip' },
    });
    await broker.publish({
      kind: 'error',
      at: new Date().toISOString(),
      source_agent: 'filter-test',
      payload: { message: 'should-appear', recoverable: true },
    });

    const lines: string[] = [];
    const ac = new AbortController();

    await runTail(
      {
        url: `http://127.0.0.1:${port}`,
        since: '1m',
        kinds: ['error'],
        noColor: true,
        signal: ac.signal,
        initialBackoffMs: 100,
        giveUpAfterMs: 5_000,
      },
      (line) => {
        lines.push(line);
        ac.abort();
      },
    ).catch(() => {});

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error');
    expect(lines[0]).toContain('should-appear');
  });
});
