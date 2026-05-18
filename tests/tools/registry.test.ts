import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  buildMetadata,
  wrapServerForRegistry,
} from '../../src/tools/registry.js';

describe('ToolRegistry', () => {
  it('records a tool and returns it via get()', () => {
    const r = new ToolRegistry();
    const m = buildMetadata(
      'worker_spawn',
      { description: 'spawn a worker', inputSchema: {} },
      'workers/tools.ts',
    );
    r.record(m);
    const stored = r.get('worker_spawn');
    expect(stored).toBeDefined();
    expect(stored?.id).toBe('worker_spawn');
    expect(stored?.category).toBe('worker');
    expect(stored?.defaultTier).toBe('CONFIRM');
    expect(stored?.reversibility).toBe('irreversible');
    expect(stored?.description).toBe('spawn a worker');
    expect(stored?.registered_by).toBe('workers/tools.ts');
  });

  it('is idempotent — second record() with the same id is a no-op', () => {
    const r = new ToolRegistry();
    const first = buildMetadata('emit_event', { description: 'v1' }, 'a');
    const second = buildMetadata('emit_event', { description: 'v2' }, 'b');
    r.record(first);
    r.record(second);
    const stored = r.get('emit_event');
    // First-write-wins so subsystem boot order can't reshuffle metadata
    expect(stored?.description).toBe('v1');
    expect(stored?.registered_by).toBe('a');
    expect(r.size()).toBe(1);
  });

  it('returns defensive copies — caller mutation does not affect storage', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('emit_event', { description: 'orig' }, 'server'));
    const stored = r.get('emit_event');
    if (!stored) throw new Error('expected stored');
    stored.description = 'mutated';
    expect(r.get('emit_event')?.description).toBe('orig');
  });

  it('all() returns id-sorted snapshots', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('zeta', {}, 'x'));
    r.record(buildMetadata('alpha', {}, 'x'));
    r.record(buildMetadata('omega', {}, 'x'));
    const ids = r.all().map((m) => m.id);
    expect(ids).toEqual(['alpha', 'omega', 'zeta']);
  });

  it('byCategory() returns only tools in that category', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('worker_spawn', {}, 'x'));
    r.record(buildMetadata('worker_status', {}, 'x'));
    r.record(buildMetadata('emit_event', {}, 'x'));
    expect(r.byCategory('worker').map((m) => m.id).sort()).toEqual([
      'worker_spawn',
      'worker_status',
    ]);
    expect(r.byCategory('event').map((m) => m.id)).toEqual(['emit_event']);
  });

  it('categories() lists distinct categories sorted', () => {
    const r = new ToolRegistry();
    r.record(buildMetadata('worker_spawn', {}, 'x'));
    r.record(buildMetadata('emit_event', {}, 'x'));
    r.record(buildMetadata('worker_list', {}, 'x'));
    expect(r.categories()).toEqual(['event', 'worker']);
  });

  it('size() reflects de-duplicated tool count', () => {
    const r = new ToolRegistry();
    expect(r.size()).toBe(0);
    r.record(buildMetadata('a_tool_x', {}, 's'));
    r.record(buildMetadata('a_tool_x', {}, 's'));
    r.record(buildMetadata('a_tool_y', {}, 's'));
    expect(r.size()).toBe(2);
  });
});

describe('wrapServerForRegistry', () => {
  function makeFakeServer() {
    // Mimic the minimal surface our wrapper touches: a `registerTool` method.
    const calls: Array<{ name: string; config: unknown; handler: unknown }> = [];
    return {
      calls,
      registerTool(name: string, config: unknown, handler: unknown) {
        calls.push({ name, config, handler });
        return { name };
      },
    };
  }

  it('records into the registry on every registerTool call', () => {
    const r = new ToolRegistry();
    const server = makeFakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapServerForRegistry(server as any, r, 'fake');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool('worker_spawn', { description: 'd1' }, () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool('emit_event', { description: 'd2' }, () => {});
    expect(r.size()).toBe(2);
    expect(r.get('worker_spawn')?.description).toBe('d1');
    expect(r.get('worker_spawn')?.registered_by).toBe('fake');
    expect(r.get('emit_event')?.description).toBe('d2');
  });

  it('delegates to the original registerTool — original side effects still happen', () => {
    const r = new ToolRegistry();
    const server = makeFakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapServerForRegistry(server as any, r, 'fake');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool('emit_event', { description: 'x' }, () => {});
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].name).toBe('emit_event');
  });

  it('is idempotent — double-wrap is a no-op (no double registration recorded)', () => {
    const r = new ToolRegistry();
    const server = makeFakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapServerForRegistry(server as any, r, 'fake');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapServerForRegistry(server as any, r, 'fake');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool('emit_event', { description: 'x' }, () => {});
    expect(r.size()).toBe(1);
    expect(server.calls).toHaveLength(1);
  });
});

describe('buildMetadata', () => {
  it('captures description + paramsSchema from the config and tags timestamp', () => {
    const before = Date.now();
    const meta = buildMetadata(
      'host_exec',
      { description: 'arbitrary shell', inputSchema: { args: 'unknown' } },
      'security/host-exec-tool.ts',
    );
    const after = Date.now();
    expect(meta.id).toBe('host_exec');
    expect(meta.description).toBe('arbitrary shell');
    expect(meta.category).toBe('shell');
    expect(meta.defaultTier).toBe('EXPLICIT');
    expect(meta.reversibility).toBe('irreversible');
    expect(meta.paramsSchema).toEqual({ args: 'unknown' });
    expect(meta.registered_by).toBe('security/host-exec-tool.ts');
    const ts = Date.parse(meta.registered_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('handles missing description gracefully', () => {
    const meta = buildMetadata('subscribe_to_events', {}, 'server.ts');
    expect(meta.description).toBe('');
    expect(meta.category).toBe('subscription');
  });
});
