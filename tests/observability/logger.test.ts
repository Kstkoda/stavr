import { describe, expect, it } from 'vitest';
import {
  logContext,
  makePinoForSink,
  runWithCorrelation,
  withLogContext,
} from '../../src/observability/logger.js';
import { makeLogger } from '../../src/log.js';

describe('logContext / runWithCorrelation', () => {
  it('exposes correlation_id within the scope', () => {
    expect(logContext.getStore()).toBeUndefined();
    runWithCorrelation('cid-1', () => {
      expect(logContext.getStore()?.correlation_id).toBe('cid-1');
    });
    expect(logContext.getStore()).toBeUndefined();
  });

  it('propagates correlation_id through nested async hops', async () => {
    const observed: Array<string | undefined> = [];
    await new Promise<void>((resolve) => {
      runWithCorrelation('cid-async', async () => {
        observed.push(logContext.getStore()?.correlation_id);
        await Promise.resolve();
        observed.push(logContext.getStore()?.correlation_id);
        await new Promise((r) => setTimeout(r, 5));
        observed.push(logContext.getStore()?.correlation_id);
        resolve();
      });
    });
    expect(observed).toEqual(['cid-async', 'cid-async', 'cid-async']);
  });

  it('merges fields when nesting withLogContext under runWithCorrelation', () => {
    runWithCorrelation('outer-cid', () => {
      withLogContext({ source_agent: 'inner-agent' }, () => {
        const store = logContext.getStore();
        expect(store?.correlation_id).toBe('outer-cid');
        expect(store?.source_agent).toBe('inner-agent');
      });
    });
  });
});

describe('pino logger output', () => {
  it('emits one JSON object per line including correlation_id when in scope', () => {
    const lines: string[] = [];
    const sink = (raw: string) => lines.push(raw.trim());
    const pino = makePinoForSink(sink);

    pino.info('no correlation here');
    runWithCorrelation('abc-123', () => {
      pino.info({ k: 'v' }, 'inside scope');
    });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.service).toBe('stavr');
      expect(typeof parsed.pid).toBe('number');
      expect(parsed.level).toBeDefined();
    }
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(first.correlation_id).toBeUndefined();
    expect(second.correlation_id).toBe('abc-123');
    expect(second.msg).toBe('inside scope');
    expect(second.k).toBe('v');
  });
});

describe('legacy makeLogger', () => {
  it('text mode produces "[stavr] <msg>" lines (backward compatible)', () => {
    const out: string[] = [];
    const logger = makeLogger({ format: 'text', sink: (line) => out.push(line) });
    logger.info('hello');
    logger.warn('warn', { x: 1 });
    expect(out[0]).toBe('[stavr] hello');
    expect(out[1]).toContain('[stavr] WARN: warn');
    expect(out[1]).toContain('"x":1');
  });

  it('json mode with custom sink keeps using the legacy in-process formatter', () => {
    const out: string[] = [];
    const logger = makeLogger({ format: 'json', sink: (line) => out.push(line) });
    logger.info('hello', { k: 'v' });
    const parsed = JSON.parse(out[0]) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect((parsed.metadata as Record<string, unknown>).k).toBe('v');
  });
});
