// host_exec runner — the only place in stavR that calls child_process.spawn
// to execute operator-host commands. Every constraint here is load-bearing:
//
//   - shell: false       (NON-NEGOTIABLE — prevents `git ; rm -rf /` style
//                         metacharacter expansion. The allowlist would be
//                         meaningless without this.)
//   - cwd containment    (rejects ../../etc — the runner cannot escape the
//                         project tree it was launched from)
//   - stdin closed       (no interactive prompts can hang the daemon)
//   - output capped      (1 MB each on stdout/stderr; truncated with marker)
//   - env scrubbed       (only PATH/HOME/USERPROFILE/APPDATA survive — no
//                         secrets like GITHUB_TOKEN leak into spawned process)
//   - hard timeout       (default from allowlist entry, max 10 min)
//
// If you find yourself wanting to "just turn on shell: true for convenience,"
// stop. Add a new allowlist entry or use worker_dispatch for the streaming
// case. There is no scenario where shell:true is the right answer here.

import { spawn } from 'node:child_process';
import { resolve as resolvePath, isAbsolute, relative } from 'node:path';

export interface RunHostExecInput {
  command: string;
  args: string[];
  cwd?: string;
  timeout_ms: number;
  /** Project root used for cwd containment. Defaults to process.cwd(). */
  rootDir?: string;
}

export interface HostExecResult {
  /** null on signal/timeout; otherwise the process exit code. */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
  /** Joined "<command> <args...>" for audit clarity. */
  command_full: string;
  /** The signal that terminated the process, if any (e.g., 'SIGTERM'). */
  signal?: NodeJS.Signals;
}

export class HostExecRejection extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'HostExecRejection';
  }
}

const MAX_OUTPUT_BYTES = 1_000_000; // 1 MB per stream
const TRUNCATION_MARKER = '\n[... output truncated]\n';

/**
 * Allowed env vars that survive the scrub. Anything else (incl. GITHUB_TOKEN,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) is dropped before spawn(). If a
 * future allowlist entry legitimately needs an extra var, surface that on the
 * entry — not by widening this set.
 */
const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'PATHEXT', // Windows: required for spawn to find git.exe, npm.cmd, etc.
] as const;

function scrubEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

/**
 * Validate that the requested cwd resolves to a path INSIDE rootDir. Returns
 * the resolved path on success or throws HostExecRejection on escape.
 */
export function resolveContainedCwd(cwd: string | undefined, rootDir: string): string {
  const root = resolvePath(rootDir);
  if (!cwd) return root;
  const target = isAbsolute(cwd) ? resolvePath(cwd) : resolvePath(root, cwd);
  const rel = relative(root, target);
  // Empty string = identical paths (target === root). Otherwise the relative
  // path must not start with '..' AND must not be absolute (Windows: a path
  // on a different drive comes back absolute from `relative`).
  if (rel === '') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new HostExecRejection(`cwd escapes project root: ${cwd}`);
  }
  return target;
}

function appendCapped(buf: string, chunk: Buffer): { next: string; truncated: boolean } {
  if (buf.length >= MAX_OUTPUT_BYTES) return { next: buf, truncated: true };
  const room = MAX_OUTPUT_BYTES - buf.length;
  const piece = chunk.length > room ? chunk.subarray(0, room).toString('utf8') : chunk.toString('utf8');
  const truncated = chunk.length > room;
  return { next: buf + piece, truncated };
}

/**
 * Spawn the command with all the safety invariants. Resolves with a
 * HostExecResult — never rejects. Caller (the tool handler) maps it to the
 * MCP response shape.
 */
export function runHostExec(input: RunHostExecInput): Promise<HostExecResult> {
  const rootDir = input.rootDir ?? process.cwd();
  const cwd = resolveContainedCwd(input.cwd, rootDir);

  return new Promise<HostExecResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(input.command, input.args, {
      cwd,
      env: scrubEnv(),
      shell: false, // NON-NEGOTIABLE — see header comment.
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let resolved = false;

    const finish = (exit_code: number | null, signal?: NodeJS.Signals): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        exit_code,
        stdout,
        stderr: stderr + (stderrTruncated || stdoutTruncated ? '' : ''),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        command_full: [input.command, ...input.args].join(' '),
        signal,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const { next, truncated } = appendCapped(stdout, chunk);
      stdout = next;
      if (truncated && !stdoutTruncated) {
        stdoutTruncated = true;
        stdout += TRUNCATION_MARKER;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const { next, truncated } = appendCapped(stderr, chunk);
      stderr = next;
      if (truncated && !stderrTruncated) {
        stderrTruncated = true;
        stderr += TRUNCATION_MARKER;
      }
    });

    child.on('error', (err) => {
      // spawn() failed to start (ENOENT etc). Surface as exit -1 with stderr.
      stderr += `[spawn error] ${(err as Error).message}\n`;
      finish(-1);
    });

    child.on('close', (code, signal) => {
      finish(code, signal ?? undefined);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first; if the child ignores, the close handler fires on its
      // own. We don't escalate to SIGKILL on Windows — Node's kill() maps to
      // TerminateProcess there, which is already fatal.
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      // Ensure we don't hang indefinitely if 'close' never fires.
      setTimeout(() => {
        if (!resolved) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          finish(null, 'SIGKILL');
        }
      }, 2_000).unref();
    }, input.timeout_ms);
  });
}
