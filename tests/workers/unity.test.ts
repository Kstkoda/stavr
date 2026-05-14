import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnitySpawner } from '../../src/workers/unity.js';
import type {
  WorkerProgressInfo,
  WorkerErrorInfo,
  WorkerMetadataInfo,
  WorkerExitInfo,
} from '../../src/workers/types.js';

const ctx = {
  workerId: 'wid',
  workerName: 'wname',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tiny chokidar fake: returns an emitter that we can poke from the test. */
function makeFakeWatcher() {
  const ee = new EventEmitter() as EventEmitter & {
    close(): Promise<void>;
    on(event: string, cb: (...args: unknown[]) => void): EventEmitter;
  };
  ee.close = async () => undefined;
  return ee;
}

describe('unity spawner', () => {
  let projectRoot: string;
  let eventsFile: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'stavr-unity-test-'));
    // Pretend this is a Unity project — the spawner checks Assets/ and
    // ProjectSettings/ exist before doing anything else.
    mkdirSync(join(projectRoot, 'Assets'), { recursive: true });
    mkdirSync(join(projectRoot, 'ProjectSettings'), { recursive: true });
    eventsFile = join(projectRoot, 'Logs', 'stavr-events.jsonl');
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects a path that is not a Unity project', async () => {
    const fakeWatcher = makeFakeWatcher();
    const spawner = createUnitySpawner({ watch: () => fakeWatcher as never });
    await expect(
      spawner.spawn(
        { project_path: tmpdir(), attach: true, batch_mode: false, unity_args: [], truncate_on_start: true },
        ctx,
      ),
    ).rejects.toThrow(/not a Unity project/);
  });

  it('tails JSONL events from the bridge and maps them to worker events', async () => {
    const fakeWatcher = makeFakeWatcher();
    const spawner = createUnitySpawner({ watch: () => fakeWatcher as never });

    const inst = await spawner.spawn(
      {
        project_path: projectRoot,
        attach: true,
        batch_mode: false,
        unity_args: [],
        truncate_on_start: true,
      },
      ctx,
    );

    const progress: WorkerProgressInfo[] = [];
    const errors: WorkerErrorInfo[] = [];
    const metadata: WorkerMetadataInfo[] = [];
    inst.events.on('progress', (p) => progress.push(p));
    inst.events.on('error', (e) => errors.push(e));
    inst.events.on('metadata', (m) => metadata.push(m));

    // Simulate the Unity bridge writing a compile pass with one error.
    mkdirSync(join(projectRoot, 'Logs'), { recursive: true });
    writeFileSync(eventsFile, '');
    appendFileSync(
      eventsFile,
      JSON.stringify({ type: 'compile_start', timestamp: '2026-05-13T00:00:00Z' }) + '\n',
    );
    appendFileSync(
      eventsFile,
      JSON.stringify({
        type: 'compile_error',
        assembly: 'Assembly-CSharp',
        file: 'Assets/Scripts/Player.cs',
        line: 42,
        column: 15,
        message: "CS0103: The name 'transfrom' does not exist",
      }) + '\n',
    );
    appendFileSync(
      eventsFile,
      JSON.stringify({
        type: 'compile_finish',
        assembly: 'Assembly-CSharp',
        errors: 1,
        warnings: 0,
      }) + '\n',
    );

    // Trigger the tailer (chokidar `add` then `change` in real life).
    fakeWatcher.emit('add');
    await sleep(30);
    fakeWatcher.emit('change');
    await sleep(30);

    // We got a progress event per JSONL line, plus an error for the
    // compile_error, plus a metadata patch for the finish.
    const messages = progress.map((p) => p.message);
    expect(messages).toContain('unity:compile_start');
    expect(messages.some((m) => m.startsWith('unity:compile_error'))).toBe(true);
    expect(messages.some((m) => m.startsWith('unity:compile_finish'))).toBe(true);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Player\.cs:42/);
    expect(errors[0].recoverable).toBe(true);

    const finishPatch = metadata.find(
      (m) => (m.patch as { last_compile_assembly?: string }).last_compile_assembly === 'Assembly-CSharp',
    );
    expect(finishPatch).toBeDefined();
    expect((finishPatch!.patch as { compile_errors?: number }).compile_errors).toBe(1);
  });

  it('attach-mode terminate emits a terminated exit and resolves cleanly', async () => {
    const fakeWatcher = makeFakeWatcher();
    const spawner = createUnitySpawner({ watch: () => fakeWatcher as never });

    const inst = await spawner.spawn(
      {
        project_path: projectRoot,
        attach: true,
        batch_mode: false,
        unity_args: [],
        truncate_on_start: true,
      },
      ctx,
    );

    const exits: WorkerExitInfo[] = [];
    inst.events.on('exit', (e) => exits.push(e));

    const { exitCode } = await inst.terminate(false);
    expect(exitCode).toBeUndefined();
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('terminated');
  });
});
