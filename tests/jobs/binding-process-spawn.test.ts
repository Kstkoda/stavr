/**
 * tests/jobs/binding-process-spawn.test.ts — the first binding's contract.
 *
 * Real-process tests using node -e snippets. Cross-platform because we go
 * through process.execPath (the running Node interpreter) rather than
 * relying on platform shells.
 */
import { describe, expect, it } from 'vitest';
import { createProcessSpawnBinding } from '../../src/jobs/binding-process-spawn.js';
import type { BindingContext, JobExitInfo, JobLogInfo } from '../../src/jobs/types.js';

const ctx: BindingContext = {
  jobId: 'invoke-test',
  jobName: 'test',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('process-spawn binding', () => {
  it('emits stdout lines as job_log events and completes with exit_code 0', async () => {
    const binding = createProcessSpawnBinding();
    const handle = await binding.dispatch(
      {
        command: 'console.log("hello"); console.log("world");',
        args: [],
        via_node: true,
      },
      ctx,
    );

    const lines: JobLogInfo[] = [];
    handle.events.on('log', (info) => lines.push(info));

    const exit = await new Promise<JobExitInfo>((resolve) => {
      handle.events.on('exit', resolve);
    });

    expect(exit.reason).toBe('completed');
    expect(exit.exitCode).toBe(0);
    const stdoutLines = lines.filter((l) => l.stream === 'stdout').map((l) => l.line);
    expect(stdoutLines).toContain('hello');
    expect(stdoutLines).toContain('world');
  });

  it('classifies non-zero exit as crashed', async () => {
    const binding = createProcessSpawnBinding();
    const handle = await binding.dispatch(
      {
        command: 'process.exit(7);',
        args: [],
        via_node: true,
      },
      ctx,
    );
    const exit = await new Promise<JobExitInfo>((resolve) => {
      handle.events.on('exit', resolve);
    });
    expect(exit.reason).toBe('crashed');
    expect(exit.exitCode).toBe(7);
  });

  it('captures stderr in the stderr stream', async () => {
    const binding = createProcessSpawnBinding();
    const handle = await binding.dispatch(
      {
        command: 'console.error("oh no"); process.exit(0);',
        args: [],
        via_node: true,
      },
      ctx,
    );
    const lines: JobLogInfo[] = [];
    handle.events.on('log', (info) => lines.push(info));
    await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    const stderr = lines.filter((l) => l.stream === 'stderr').map((l) => l.line);
    expect(stderr).toContain('oh no');
  });

  it('forwards stdin payload to the child', async () => {
    const binding = createProcessSpawnBinding();
    const handle = await binding.dispatch(
      {
        command:
          'let buf = ""; process.stdin.on("data", c => buf += c); process.stdin.on("end", () => { console.log("got:" + buf.trim()); process.exit(0); });',
        args: [],
        via_node: true,
        stdin: 'ping',
      },
      ctx,
    );
    const lines: JobLogInfo[] = [];
    handle.events.on('log', (info) => lines.push(info));
    await new Promise<JobExitInfo>((resolve) => handle.events.on('exit', resolve));
    expect(lines.find((l) => l.line === 'got:ping')).toBeDefined();
  });

  it('terminate(force=true) kills a long-running child', async () => {
    const binding = createProcessSpawnBinding();
    const handle = await binding.dispatch(
      {
        command: 'setInterval(() => {}, 100);',
        args: [],
        via_node: true,
      },
      ctx,
    );
    // Let the child start.
    await sleep(50);
    const exitPromise = new Promise<JobExitInfo>((resolve) => {
      handle.events.on('exit', resolve);
    });
    await handle.terminate(true);
    const exit = await exitPromise;
    expect(exit.reason).toBe('terminated');
  });

  it('declares no inject capability', () => {
    const binding = createProcessSpawnBinding();
    expect(binding.capabilities.inject).toBe(false);
  });

  it('honors a custom target name', () => {
    const binding = createProcessSpawnBinding({ target: 'cowork-test' });
    expect(binding.target).toBe('cowork-test');
    expect(binding.kind).toBe('process-spawn');
  });
});
