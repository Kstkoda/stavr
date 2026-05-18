import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  let scriptBaseDir: string;

  beforeEach(() => {
    // v0.6.7 P1 — spawner now writes worker scripts to disk before
    // invoking. Use a per-test tmp dir to avoid polluting the operator's
    // ~/.stavr/worker-scripts/ when the test suite runs locally.
    scriptBaseDir = mkdtempSync(join(tmpdir(), 'stavr-shell-test-'));
  });

  afterEach(() => {
    rmSync(scriptBaseDir, { recursive: true, force: true });
  });

  it('captures stdout lines as progress events and emits exit on success', async () => {
    const child = makeFakeChild();
    const spawner = createShellSpawner({
      spawn: ((..._args: unknown[]) => child) as never,
      scriptBaseDir,
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
    const spawner = createShellSpawner({
      spawn: ((..._a: unknown[]) => child) as never,
      scriptBaseDir,
    });
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

  // v0.6.7 P1 — the spawner writes a script file and invokes via -File/
  // /c <path>/bash <path>. No more `-Command "..."` inline AV trigger.

  it('writes the worker command to a script file and invokes via -File pattern', async () => {
    let recordedArgv: { argv0: string; argv: string[] } | undefined;
    const child = makeFakeChild();
    const fakeSpawn = ((argv0: string, argv: string[]) => {
      recordedArgv = { argv0, argv };
      return child;
    }) as never;
    const spawner = createShellSpawner({ spawn: fakeSpawn, scriptBaseDir });
    const inst = await spawner.spawn(
      { cwd: process.cwd(), shell: 'powershell', command: 'Write-Host hi', args: [], interactive: false },
      ctx,
    );
    // Spawn argv: powershell.exe -NoLogo -NonInteractive -NoProfile
    // -ExecutionPolicy Bypass -File <path>
    expect(recordedArgv?.argv0).toBe('powershell.exe');
    expect(recordedArgv?.argv).toContain('-File');
    expect(recordedArgv?.argv).not.toContain('-Command');
    expect(recordedArgv?.argv[recordedArgv.argv.length - 1]).toContain('wid.ps1');
    // Script body is on disk under the test baseDir.
    const scriptPath = recordedArgv!.argv[recordedArgv!.argv.length - 1];
    const body = readFileSync(scriptPath, 'utf8');
    expect(body).toContain('Write-Host hi');
    expect(body).toContain('# worker_id: wid');
    // Worker metadata exposes the script path so the dashboard can link.
    expect(inst.metadata.script_path).toBe(scriptPath);
  });

  // v0.6.7 P2 — sleep-correct pacing weaves into the spawned script.

  it('sleepBefore weaves a shell-correct sleep before the command body', async () => {
    let recordedArgv: { argv0: string; argv: string[] } | undefined;
    const child = makeFakeChild();
    const fakeSpawn = ((argv0: string, argv: string[]) => {
      recordedArgv = { argv0, argv };
      return child;
    }) as never;
    const spawner = createShellSpawner({ spawn: fakeSpawn, scriptBaseDir });
    await spawner.spawn(
      {
        cwd: process.cwd(),
        shell: 'cmd',
        command: 'echo hi',
        args: [],
        interactive: false,
        sleepBefore: 5,
      },
      ctx,
    );
    const scriptPath = recordedArgv!.argv[recordedArgv!.argv.length - 1];
    const body = readFileSync(scriptPath, 'utf8');
    // CMD uses ping (timeout doesn't sleep in headless); -n is sleep+1
    expect(body).toContain('ping 127.0.0.1 -n 6 >nul');
    const pingIdx = body.indexOf('ping 127.0.0.1');
    const cmdIdx = body.indexOf('echo hi');
    expect(pingIdx).toBeLessThan(cmdIdx);
    // And NOT the broken `timeout /t N /nobreak` pattern.
    expect(body).not.toContain('timeout /t');
  });

  it('sleepAfter on powershell renders Start-Sleep -Seconds after command', async () => {
    let recordedArgv: { argv0: string; argv: string[] } | undefined;
    const child = makeFakeChild();
    const fakeSpawn = ((argv0: string, argv: string[]) => {
      recordedArgv = { argv0, argv };
      return child;
    }) as never;
    const spawner = createShellSpawner({ spawn: fakeSpawn, scriptBaseDir });
    await spawner.spawn(
      {
        cwd: process.cwd(),
        shell: 'powershell',
        command: 'Write-Host hi',
        args: [],
        interactive: false,
        sleepAfter: 10,
      },
      ctx,
    );
    const scriptPath = recordedArgv!.argv[recordedArgv!.argv.length - 1];
    const body = readFileSync(scriptPath, 'utf8');
    expect(body).toContain('Start-Sleep -Seconds 10');
    const cmdIdx = body.indexOf('Write-Host hi');
    const sleepIdx = body.indexOf('Start-Sleep -Seconds 10');
    expect(sleepIdx).toBeGreaterThan(cmdIdx);
  });

  it('cmd shell invokes via /c <path>, never inline /c "<cmd>"', async () => {
    let recordedArgv: { argv0: string; argv: string[] } | undefined;
    const child = makeFakeChild();
    const fakeSpawn = ((argv0: string, argv: string[]) => {
      recordedArgv = { argv0, argv };
      return child;
    }) as never;
    const spawner = createShellSpawner({ spawn: fakeSpawn, scriptBaseDir });
    await spawner.spawn(
      { cwd: process.cwd(), shell: 'cmd', command: 'echo hi', args: [], interactive: false },
      ctx,
    );
    expect(recordedArgv?.argv0).toBe('cmd.exe');
    expect(recordedArgv?.argv[0]).toBe('/c');
    expect(recordedArgv?.argv[1]).toContain('wid.cmd');
    // No /k (would leave the window open).
    expect(recordedArgv?.argv).not.toContain('/k');
  });
});
