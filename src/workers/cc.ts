import { spawn as nodeSpawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { safeWrite } from '../util/atomic.js';
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
  /** Daemon URL the spawned CC will connect to. Defaults to env COWIRE_DAEMON_URL or http://127.0.0.1:7777/mcp/sse. Note: /mcp/sse, not /sse — the daemon's MCP endpoint is under /mcp/. (Pre-spec-47 the spawner wrote the wrong path and every worker's MCP connection silently failed.) */
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
      const daemonUrl = params.daemon_url ?? opts.defaultDaemonUrl ?? process.env.COWIRE_DAEMON_URL ?? 'http://127.0.0.1:7777/mcp/sse';
      mkdirSync(worktreePath, { recursive: true });
      const mcpConfigPath = join(worktreePath, '.cowire-mcp.json');
      safeWrite(mcpConfigPath, buildMcpConfig(daemonUrl));

      // 5. Spawn claude directly as a child process — no shell wrapper, no
      // visible cmd window. Works identically on Windows, macOS, and Linux
      // because we go through Node's `child_process.spawn` with `shell: false`,
      // bypassing cmd.exe / bash entirely. The prompt is sent via stdin so it
      // can be arbitrarily large (Windows cmd-line limit no longer applies).
      // Claude's --print --output-format stream-json mode writes one JSON
      // event per line on stdout; we parse each and emit as a structured
      // progress event. Pre-spec-47 (commit dbfd9ba era) this used
      // `cmd /c start cmd /K claude ...` which (a) made child.pid point at a
      // launcher cmd.exe that died immediately, (b) lost all stdout/stderr to
      // `stdio: 'ignore'`, and (c) opened a detached window the operator had
      // to manually monitor. All three problems are fixed by the rewrite.
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
        // child.pid is now the actual `claude` process PID (was the launcher's
        // cmd.exe PID under the pre-spec-47 cmd /K start wrapper). The daemon
        // can use this for real liveness tracking and SIGTERM.
        claude_pid: child.pid,
      };

      // Wire stdout: parse one JSON event per line (Claude's --output-format
      // stream-json contract). Non-JSON lines fall through as plain progress
      // messages so we never lose output. Buffered split — chunk boundaries
      // can land mid-line.
      let stdoutBuf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl = stdoutBuf.indexOf('\n');
        while (nl !== -1) {
          const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.length > 0) emitStdoutLine(bus, line);
          nl = stdoutBuf.indexOf('\n');
        }
      });
      child.stdout?.on('end', () => {
        if (stdoutBuf.length > 0) {
          emitStdoutLine(bus, stdoutBuf.replace(/\r$/, ''));
          stdoutBuf = '';
        }
      });

      // Wire stderr: every non-empty line becomes a progress event tagged
      // stream:'stderr'. Lines >4 KB are truncated to keep the broker honest
      // about a pathological writer.
      let stderrBuf = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        let nl = stderrBuf.indexOf('\n');
        while (nl !== -1) {
          const line = stderrBuf.slice(0, nl).replace(/\r$/, '');
          stderrBuf = stderrBuf.slice(nl + 1);
          if (line.length > 0) emitStderrLine(bus, line);
          nl = stderrBuf.indexOf('\n');
        }
      });
      child.stderr?.on('end', () => {
        if (stderrBuf.length > 0) {
          emitStderrLine(bus, stderrBuf.replace(/\r$/, ''));
          stderrBuf = '';
        }
      });

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
  // Direct spawn of the `claude` binary with `--print --output-format
  // stream-json` (Claude Code's headless streaming mode). We pipe stdin so
  // the prompt can be arbitrarily large (avoids the Windows ~8 KB cmd-line
  // cap), and pipe stdout/stderr so the daemon receives every event in real
  // time. shell:false bypasses cmd.exe / bash entirely; windowsHide:true
  // suppresses the popup window on Windows. Same code path runs on macOS
  // and Linux.
  const claudeArgs: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--mcp-config', '.cowire-mcp.json',
  ];
  if (opts.model) claudeArgs.push('--model', opts.model);
  // bypassPermissions, not acceptEdits: headless workers have no UI to surface
  // permission prompts, and `acceptEdits` only auto-accepts file edits —
  // compound bash commands and tool-use approvals still prompt. In a
  // worktree-isolated worker bounded by an active trust scope, bypass is the
  // correct choice. (See spec 47.)
  if (opts.approvalMode === 'auto-accept') claudeArgs.push('--permission-mode', 'bypassPermissions');

  // Cross-platform spawn — explicit cmd.exe wrapper on Windows so:
  //   (a) npm's `claude.cmd` wrapper resolves (Node's CreateProcess can't
  //       exec .cmd directly since v22's CVE-2024-27980 fix), and
  //   (b) `windowsHide: true` reliably suppresses the cmd console window
  //       (which is only honoured when shell:false — using shell:true makes
  //       cmd flash briefly on each spawn).
  // On macOS / Linux we just call `claude` directly. Same daemon code, same
  // stdio model, same JSONL parser — the only platform-specific bit is the
  // executable invocation.
  const isWindows = process.platform === 'win32';
  // Strip ANTHROPIC_API_KEY from the worker's env so Claude Code falls back to
  // the next credential source - typically the User's logged-in Claude Max
  // OAuth session. API key beats OAuth in CC's precedence, so without this the
  // worker bills the API key even when Max is available. Opt back into API
  // billing by setting COWIRE_FORCE_API_KEY=1 in the daemon's env.
  const env = { ...process.env };
  if (!process.env.COWIRE_FORCE_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }
  const spawnOpts: SpawnOptions = {
    cwd: opts.worktreePath,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  };
  const child = isWindows
    ? spawnFn('cmd.exe', ['/d', '/s', '/c', 'claude', ...claudeArgs], spawnOpts)
    : spawnFn('claude', claudeArgs, spawnOpts);

  // Send the prompt as a single stream-json user message, then close stdin
  // so Claude knows the input is finished. Using stream-json input format
  // is forward-compatible with bidirectional steering (spec 47 follow-up).
  const userMessage = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: opts.prompt },
  }) + '\n';
  // child.stdin can be null if stdio[0] !== 'pipe', but we set it to 'pipe'
  // above. Defensive null-check anyway.
  if (child.stdin) {
    child.stdin.write(userMessage);
    child.stdin.end();
  }
  return child;
}

function emitStdoutLine(bus: WorkerEventBus, line: string): void {
  // Try to parse Claude's stream-json event. On success, surface a structured
  // progress event with the parsed event as payload; the orchestrator
  // forwards it onto the broker as worker_progress and the dashboard /
  // `cowire tail` can render it richly. On parse failure, treat as a plain
  // log line so we never lose output.
  const trimmed = line.length > 4096 ? line.slice(0, 4096) : line;
  const truncated = line.length > 4096;
  try {
    const event = JSON.parse(trimmed);
    const kind = typeof event === 'object' && event !== null && 'type' in event
      ? String((event as { type: unknown }).type)
      : 'unknown';
    bus.emitProgress({
      message: `claude:${kind}`,
      payload: { stream: 'stdout', format: 'stream-json', event, truncated },
    });
  } catch {
    bus.emitProgress({
      message: trimmed,
      payload: { stream: 'stdout', format: 'raw', truncated },
    });
  }
}

function emitStderrLine(bus: WorkerEventBus, line: string): void {
  const trimmed = line.length > 4096 ? line.slice(0, 4096) : line;
  const truncated = line.length > 4096;
  bus.emitProgress({
    message: trimmed,
    payload: { stream: 'stderr', truncated },
  });
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
