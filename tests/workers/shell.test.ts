import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createShellSpawner } from '../../src/workers/shell.js';
import type { WorkerProgressInfo, WorkerExitInfo } from '../../src/workers/types.js';

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(_sig?: string | number): boolean;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 4242;
  ee.exitCode = null;
  ee.stdout = new Readable({ read() {} });
  ee.stderr = new Readable({ read() {} });
  ee.kill = () => true;
  return ee;
}

const ctx = {
  workerId: 'wid',
  workerName: 'wname',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('shell spawner', () => {
  it('captures stdout lines as progress events and emits exit on success', async () => {
    const child = makeFakeChild();
    const spawner = createShellSpawner({
      spawn: ((..._args: unknown[]) => child) as never,
    });
    const inst = await spawner.spawn(
      { cwd: process.cwd(), shell: 'bash', command: 'echo', args: ['hi'], interactive: false },
      ctx,
    );
    const progress: WorkerProgressInfo[] = [];
    const exits: WorkerExitInfo[] = [];
    inst.events.on('progress', (p) => progress.push(p));
    inst.events.on('exit', (e) => exits.push(e));

    child.stdout!.push('hi\n');
    child.stdout!.push('there\n');
    child.stdout!.push(null);
    await sleep(20);

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await sleep(10);

    expect(progress.map((p) => p.message)).toEqual(['hi', 'there']);
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('completed');
    expect(exits[0].exitCode).toBe(0);
  });

  it('non-zero exit reports crashed reason', async () => {
    const child = makeFakeChild();
    const spawner = createShellSpawner({ spawn: ((..._a: unknown[]) => child) as never });
    const inst = await spawner.spawn(
      { cwd: process.cwd(), shell: 'bash', command: 'false', args: [], interactive: false },
      ctx,
    );
    const exits: WorkerExitInfo[] = [];
    inst.events.on('exit', (e) => exits.push(e));

    child.exitCode = 1;
    child.emit('exit', 1, null);
    await sleep(10);

    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('crashed');
    expect(exits[0].exitCode).toBe(1);
  });
});
