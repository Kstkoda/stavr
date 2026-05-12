import { spawn as nodeSpawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import chokidar, { type FSWatcher } from 'chokidar';
import { WorkerEventBus } from './emitter.js';
import {
  DispatchNotSupportedError,
  type WorkerInstance,
  type WorkerSpawner,
  type WorkerSpawnerContext,
} from './types.js';
import type { WorkerRecord } from '../persistence.js';

const execFileP = promisify(execFile);

export const CcSpawnParams = z.object({
  repo_path: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().min(1).optional().default('main'),
  prompt: z.string().min(1),
  model: z.string().optional(),
  approval_mode: z.enum(['auto-accept', 'normal']).optional().default('normal'),
  /** Directory under which to put the worktree. Default: <repo_path>/.cowire-worktrees */
  worktree_base: z.string().optional(),
  cleanup_on_terminate: z.boolean().optional().default(true),
  /** Daemon URL the spawned CC will connect to. Defaults to env COWIRE_DAEMON_URL or http://127.0.0.1:7777/sse */
  daemon_url: z.string().url().optional(),
});

export type CcSpawnParamsT = z.infer<typeof CcSpawnParams>;

type GitRunner = (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
type Spawner = typeof nodeSpawn;
type ChokidarWatch = (paths: string | string[], opts?: Parameters<typeof chokidar.watch>[1]) => FSWatcher;

export interface CcSpawnerOptions {
  /** Inject a git runner — used by tests to stub git. */
  git?: GitRunner;
  /** Inject a child_process.spawn — used by tests. */
  spawn?: Spawner;
  /** Inject chokidar.watch — used by tests. */
  watch?: ChokidarWatch;
  /** Override default daemon URL when params.daemon_url is unset. */
  defaultDaemonUrl?: string;
}

export function createCcSpawner(opts: CcSpawnerOptions = {}): WorkerSpawner<CcSpawnParamsT> {
  const gitRunner: GitRunner = opts.git ?? defaultGitRunner;
  const spawnFn: Spawner = opts.spawn ?? nodeSpawn;
  const watchFn: ChokidarWatch = opts.watch ?? ((p, o) => chokidar.watch(p, o));

  return {
    type: 'cc',
    displayName: 'Claude Code',
    description:
      'Spawn a Claude Code session in a dedicated git worktree. Each worker gets its own branch and an isolated working tree so parallel workers in the same repo never collide.',
    tier: 'confirm',
    paramsSchema: CcSpawnParams,

    async spawn(params, ctx): Promise<WorkerInstance> {
      const repoPath = resolve(params.repo_path);
      const worktreeBase = params.worktree_base
        ? resolve(params.worktree_base)
        : join(repoPath, '.cowire-worktrees');
      const worktreePath = join(worktreeBase, ctx.workerName);

      if (existsSync(worktreePath)) {
        throw new Error(`worktree path already exists: ${worktreePath}`);
      }
      mkdirSync(worktreeBase, { recursive: true });

      // 1. Validate the repo. `git rev-parse --git-dir` errors if not a repo.
      await gitRunner(['rev-parse', '--git-dir'], { cwd: repoPath });

      // 2. Fetch the base.
      await gitRunner(['fetch', 'origin', params.base], { cwd: repoPath }).catch(() => {
        // Tolerate fetch failures (offline / no remote); fall back to local base.
      });

      // 3. Create the worktree on the new branch from base.
      const baseRef = (await refExists(gitRunner, repoPath, `origin/${params.base}`))
        ? `origin/${params.base}`
        : params.base;
      await gitRunner(['worktree', 'add', worktreePath, '-B', params.branch, baseRef], { cwd: repoPath });

      // 4. Write the MCP config. `git worktree add` creates the dir in prod; we
      // mkdir defensively so tests with a mocked git runner still succeed.
      const daemonUrl = params.daemon_url ?? opts.defaultDaemonUrl ?? process.env.COWIRE_DAEMON_URL ?? 'http://127.0.0.1:7777/sse';
      mkdirSync(worktreePath, { recursive: true });
      const mcpConfigPath = join(worktreePath, '.cowire-mcp.json');
      writeFileSync(mcpConfigPath, buildMcpConfig(daemonUrl), 'utf8');

      // 5. Spawn claude in a visible cmd window.
      const child = launchClaude(spawnFn, {
        workerName: ctx.workerName,
        worktreePath,
        prompt: params.prompt,
        model: params.model,
        approvalMode: params.approval_mode,
      });

      const bus = new WorkerEventBus();
      const metadata: Record<string, unknown> = {
        cwd: worktreePath,
        repo_path: repoPath,
        worktree_path: worktreePath,
        branch: params.branch,
        base: params.base,
        model: params.model,
        approval_mode: params.approval_mode,
        mcp_config_path: mcpConfigPath,
        // Resolution of open question Q2 (PID capture under cmd /K start):
        // child.pid is the launcher cmd's PID, not claude.exe's. Documented limitation.
        launcher_pid: child.pid,
      };

      // 6. Watch git state in the worktree. Replaces the 10s poller.
      const watchTargets = [
        join(worktreePath, '.git', 'HEAD'),
        join(worktreePath, '.git', 'refs', 'heads', params.branch),
        join(worktreePath, '.git', 'index'),
      ];
      const watcher = watchFn(watchTargets, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 },
      });
      const onChange = async (): Promise<void> => {
        try {
          const state = await readGitState(gitRunner, worktreePath);
          bus.emitMetadata({ patch: { git: state, git_observed_at: new Date().toISOString() } });
        } catch (err) {
          bus.emitError({ message: `git status failed: ${(err as Error).message}`, recoverable: true });
        }
      };
      watcher.on('all', () => void onChange());

      // 7. Exit handlers.
      child.on('error', (err) => {
        bus.emitError({ message: err.message, recoverable: false });
      });
      child.on('exit', (code, signal) => {
        const exitCode = code ?? undefined;
        const reason: 'completed' | 'crashed' | 'terminated' =
          exitCode === 0 ? 'completed' : signal ? 'terminated' : 'crashed';
        void watcher.close();
        if (params.cleanup_on_terminate) {
          // Best-effort worktree removal. Failures are non-fatal.
          gitRunner(['worktree', 'remove', '--force', worktreePath], { cwd: repoPath }).catch(() => {
            try {
              rmSync(worktreePath, { recursive: true, force: true });
            } catch {
              /* leave it; user can clean up manually */
            }
          });
        }
        bus.emitExit({ exitCode, reason });
      });

      return {
        pid: child.pid,
        metadata,
        events: bus,
        async terminate(force: boolean): Promise<{ exitCode?: number }> {
          if (child.exitCode !== null) return { exitCode: child.exitCode };
          try {
            if (force) child.kill('SIGKILL');
            else child.kill();
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
    },

    async dispatch(
      _worker: WorkerRecord,
      _message: { id: string; body: unknown },
      _ctx: WorkerSpawnerContext,
    ): Promise<void> {
      // Resolution of open question Q3: the orchestrator publishes
      // worker_dispatch_request on the broker; the spawned CC subscribes to that
      // kind at startup (see its initial prompt / .cowire-mcp.json). This method
      // is a no-op because the orchestrator does the publish.
    },
  };
}

async function defaultGitRunner(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd: opts.cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

async function refExists(git: GitRunner, repo: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', ref], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

interface LaunchOpts {
  workerName: string;
  worktreePath: string;
  prompt: string;
  model?: string;
  approvalMode?: 'auto-accept' | 'normal';
}

function launchClaude(spawnFn: Spawner, opts: LaunchOpts): ChildProcess {
  // Open a visible cmd window so the user can see CC's progress and
  // interrupt if needed. Detached so closing the daemon doesn't kill it.
  const claudeArgs: string[] = ['--mcp-config', '.cowire-mcp.json'];
  if (opts.model) claudeArgs.push('--model', opts.model);
  if (opts.approvalMode === 'auto-accept') claudeArgs.push('--permission-mode', 'acceptEdits');
  // Pass the prompt as the final positional arg.
  const claudeCmd = `claude ${claudeArgs.map(quoteArg).join(' ')} ${quoteArg(opts.prompt)}`;
  const spawnOpts: SpawnOptions = {
    cwd: opts.worktreePath,
    detached: true,
    stdio: 'ignore',
  };
  return spawnFn(
    'cmd.exe',
    ['/c', 'start', `cc:${opts.workerName}`, 'cmd', '/K', claudeCmd],
    spawnOpts,
  );
}

function quoteArg(s: string): string {
  if (!/[\s"']/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function buildMcpConfig(daemonUrl: string): string {
  // CC's mcp-config accepts an `mcpServers` map. We register Cowire's daemon
  // under the key `cowire`. SSE transport is used directly; if the local CC
  // doesn't speak SSE, the user wires the stdio<->SSE shim instead. Documented
  // in ARCHITECTURE.md (Resolution of open question Q1).
  const config = {
    mcpServers: {
      cowire: {
        type: 'sse',
        url: daemonUrl,
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

async function readGitState(git: GitRunner, cwd: string): Promise<Record<string, unknown>> {
  const { stdout } = await git(['status', '--porcelain=v2', '--branch'], { cwd });
  const lines = stdout.split(/\r?\n/);
  const state: Record<string, unknown> = { dirty_files: [] as string[] };
  for (const line of lines) {
    if (line.startsWith('# branch.head')) state.branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.oid')) state.commit_sha = line.slice('# branch.oid '.length).trim();
    else if (line.startsWith('# branch.ab')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        state.ahead = Number(m[1]);
        state.behind = Number(m[2]);
      }
    } else if (line && !line.startsWith('#')) {
      // 1/2/u/? — the last whitespace-separated token is the path.
      const path = line.split(/\s+/).pop();
      if (path) (state.dirty_files as string[]).push(path);
    }
  }
  return state;
}

// Suppress lint if not consumed.
export { DispatchNotSupportedError };

const ccSpawner = createCcSpawner();
export default ccSpawner;
