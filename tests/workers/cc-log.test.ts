import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCcSpawner } from '../../src/workers/cc.js';

class FakeChildWithPipes extends EventEmitter {
  pid = 8888;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(_sig?: string | number): boolean {
    return true;
  }
}

class FakeWatcher extends EventEmitter {
  async close(): Promise<void> {}
}

const ctx = {
  workerId: 'log-wid',
  workerName: 'log-w',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

describe('cc spawner worker_log emission', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cowire-cc-log-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits worker_log with stream=stdout and format=stream-json for JSONL lines', async () => {
    const child = new FakeChildWithPipes();
    const watcher = new FakeWatcher();
    const git = async () => ({ stdout: '', stderr: '' });

    const spawner = createCcSpawner({
      git,
      spawn: (() => child) as never,
      watch: (() => watcher as never),
    });

    const inst = await spawner.spawn(
      {
        repo_path: tmp,
        branch: 'feat/log-test',
        base: 'main',
        prompt: 'test prompt',
        cleanup_on_terminate: false,
        approval_mode: 'normal',
      },
      ctx,
    );

    const logEvents: Array<{ stream: string; line: string; format?: string; event?: unknown }> = [];
    inst.events.on('log', (info) => logEvents.push(info));

    // Push a JSONL line that looks like stream-json
    const jsonLine = JSON.stringify({ type: 'assistant', content: 'hello' });
    child.stdout.push(jsonLine + '\n');
    child.stdout.push(null); // EOF

    // Wait for readline to process
    await new Promise((r) => setTimeout(r, 50));

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0].stream).toBe('stdout');
    expect(logEvents[0].format).toBe('stream-json');
    expect(logEvents[0].line).toBe(jsonLine);
    expect((logEvents[0].event as Record<string, unknown>).type).toBe('assistant');
  });

  it('emits worker_log with stream=stderr and format=raw for stderr lines', async () => {
    const child = new FakeChildWithPipes();
    const watcher = new FakeWatcher();
    const git = async () => ({ stdout: '', stderr: '' });

    const spawner = createCcSpawner({
      git,
      spawn: (() => child) as never,
      watch: (() => watcher as never),
    });

    const inst = await spawner.spawn(
      {
        repo_path: tmp,
        branch: 'feat/log-test',
        base: 'main',
        prompt: 'test prompt',
        cleanup_on_terminate: false,
        approval_mode: 'normal',
      },
      ctx,
    );

    const logEvents: Array<{ stream: string; line: string; format?: string }> = [];
    inst.events.on('log', (info) => logEvents.push(info));

    child.stderr.push('some error output\n');
    child.stderr.push(null);

    await new Promise((r) => setTimeout(r, 50));

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0].stream).toBe('stderr');
    expect(logEvents[0].format).toBe('raw');
    expect(logEvents[0].line).toBe('some error output');
  });

  it('truncates lines longer than 4096 chars and sets truncated=true', async () => {
    const child = new FakeChildWithPipes();
    const watcher = new FakeWatcher();
    const git = async () => ({ stdout: '', stderr: '' });

    const spawner = createCcSpawner({
      git,
      spawn: (() => child) as never,
      watch: (() => watcher as never),
    });

    const inst = await spawner.spawn(
      {
        repo_path: tmp,
        branch: 'feat/log-test',
        base: 'main',
        prompt: 'test prompt',
        cleanup_on_terminate: false,
        approval_mode: 'normal',
      },
      ctx,
    );

    const logEvents: Array<{ stream: string; line: string; truncated?: boolean }> = [];
    inst.events.on('log', (info) => logEvents.push(info));

    const longLine = 'x'.repeat(5000);
    child.stdout.push(longLine + '\n');
    child.stdout.push(null);

    await new Promise((r) => setTimeout(r, 50));

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0].line).toHaveLength(4096);
    expect(logEvents[0].truncated).toBe(true);
  });
});
