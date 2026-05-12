import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { z } from 'zod';
import { WorkerEventBus } from './emitter.js';
import type { WorkerInstance, WorkerSpawner } from './types.js';

const ShellSpawnParams = z.object({
  cwd: z.string().min(1),
  shell: z.enum(['cmd', 'powershell', 'bash']),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  interactive: z.boolean().optional().default(false),
});

type ShellSpawnParamsT = z.infer<typeof ShellSpawnParams>;

type Spawner = typeof nodeSpawn;

export interface ShellSpawnerOptions {
  /** Override the child_process.spawn shape — used by tests to inject a fake. */
  spawn?: Spawner;
}

export function createShellSpawner(opts: ShellSpawnerOptions = {}): WorkerSpawner<ShellSpawnParamsT> {
  const spawnFn: Spawner = opts.spawn ?? nodeSpawn;

  return {
    type: 'shell',
    displayName: 'Shell command (cmd / PowerShell / bash)',
    description:
      'Spawn a shell command. interactive=false captures stdout/stderr as progress events; interactive=true opens a visible window the user can type into.',
    tier: 'confirm',
    paramsSchema: ShellSpawnParams,

    async spawn(params, _ctx): Promise<WorkerInstance> {
      const bus = new WorkerEventBus();
      const metadata: Record<string, unknown> = {
        cwd: params.cwd,
        shell: params.shell,
        command: params.command,
        args: params.args,
        interactive: params.interactive,
      };

      if (params.interactive) {
        const { child } = startInteractive(spawnFn, params);
        wireExitHandlers(child, bus);
        return wrap(child, metadata, bus);
      }

      const { child } = startNonInteractive(spawnFn, params);
      pipeProgress(child, bus);
      wireExitHandlers(child, bus);
      return wrap(child, metadata, bus);
    },
  };
}

function startNonInteractive(
  spawnFn: Spawner,
  params: ShellSpawnParamsT,
): { child: ChildProcess } {
  const opts: SpawnOptions = { cwd: params.cwd, stdio: ['ignore', 'pipe', 'pipe'] };
  switch (params.shell) {
    case 'cmd':
      return { child: spawnFn('cmd.exe', ['/c', params.command, ...params.args], opts) };
    case 'powershell':
      return {
        child: spawnFn(
          'powershell.exe',
          ['-NoLogo', '-NonInteractive', '-Command', params.command, ...params.args],
          opts,
        ),
      };
    case 'bash':
      return { child: spawnFn('bash', ['-lc', [params.command, ...params.args].join(' ')], opts) };
  }
}

function startInteractive(spawnFn: Spawner, params: ShellSpawnParamsT): { child: ChildProcess } {
  // Open a visible window the user can interact with. The child's stdout
  // belongs to the user, not to us — so we only get the exit event.
  const opts: SpawnOptions = { cwd: params.cwd, detached: true, stdio: 'ignore' };
  switch (params.shell) {
    case 'cmd':
      return {
        child: spawnFn(
          'cmd.exe',
          ['/c', 'start', `shell:${params.command}`, 'cmd', '/K', [params.command, ...params.args].join(' ')],
          opts,
        ),
      };
    case 'powershell':
      return {
        child: spawnFn(
          'cmd.exe',
          ['/c', 'start', `shell:${params.command}`, 'powershell', '-NoExit', '-Command', [params.command, ...params.args].join(' ')],
          opts,
        ),
      };
    case 'bash':
      // No standard 'open new terminal' on Windows for bash; fall back to non-detached.
      return {
        child: spawnFn('bash', ['-lc', [params.command, ...params.args].join(' ')], {
          cwd: params.cwd,
          stdio: 'ignore',
        }),
      };
  }
}

function pipeProgress(child: ChildProcess, bus: WorkerEventBus): void {
  const lines = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr'): void => {
    if (!stream) return;
    const rl: Interface = createInterface({ input: stream });
    rl.on('line', (line) => {
      bus.emitProgress({ message: line, payload: { channel } });
    });
  };
  lines(child.stdout, 'stdout');
  lines(child.stderr, 'stderr');
}

function wireExitHandlers(child: ChildProcess, bus: WorkerEventBus): void {
  child.on('error', (err) => {
    bus.emitError({ message: err.message, recoverable: false });
  });
  child.on('exit', (code, signal) => {
    const exitCode = code ?? undefined;
    const reason: 'completed' | 'crashed' | 'terminated' =
      exitCode === 0 ? 'completed' : signal ? 'terminated' : 'crashed';
    bus.emitExit({ exitCode, reason });
  });
}

function wrap(
  child: ChildProcess,
  metadata: Record<string, unknown>,
  bus: WorkerEventBus,
): WorkerInstance {
  return {
    pid: child.pid,
    metadata,
    events: bus,
    async terminate(force: boolean): Promise<{ exitCode?: number }> {
      if (child.exitCode !== null) return { exitCode: child.exitCode };
      try {
        if (force) {
          child.kill('SIGKILL');
        } else {
          child.kill();
        }
      } catch {
        /* already gone */
      }
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve({ exitCode: child.exitCode });
          return;
        }
        child.once('exit', (code) => resolve({ exitCode: code ?? undefined }));
      });
    },
  };
}

const shellSpawner = createShellSpawner();
export default shellSpawner;
