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
import { existsSync, statSync } from 'node:fs';
import { delimiter, join, resolve as resolvePath, isAbsolute, relative } from 'node:path';

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

/**
 * Resolve a bare command name to its executable path. On Windows we must
 * walk PATH + PATHEXT manually because Node's spawn with shell:false does
 * NOT auto-append .cmd/.bat extensions (only shell:true does that, which we
 * forbid). On POSIX we let spawn handle PATH lookup natively — but a manual
 * search via PATH gives identical behavior for `.exe`-less binaries, and
 * keeps the implementation symmetric.
 *
 * Returns the original command unchanged if no resolution succeeds — letting
 * spawn surface ENOENT through the normal error channel rather than this
 * function throwing.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // Absolute / relative paths are passed through verbatim — they've already
  // been rejected by the validator if they're not allowed.
  if (command.includes('/') || command.includes('\\')) return command;
  const pathStr = env.PATH ?? env.Path ?? '';
  if (!pathStr) return command;
  const dirs = pathStr.split(delimiter).filter(Boolean);
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // unreadable directory — skip
      }
    }
  }
  return command;
}

/**
 * Quote a single argument for cmd.exe so the batch interpreter receives it
 * verbatim. Two layers apply:
 *
 *   1. Microsoft C-runtime quoting (the rules CreateProcess uses): wrap in
 *      double quotes if the arg contains whitespace or quotes; backslashes
 *      before a quote are doubled.
 *   2. cmd.exe metacharacter escaping with caret: `& | < > ^ ( ) % !` so the
 *      interpreter doesn't treat them as syntax (pipe, redirect, env-var,
 *      delayed-expansion).
 *
 * This is the same approach cross-spawn uses. We DO NOT call shell:true —
 * we explicitly invoke cmd.exe with /d /s /c and rely on windowsVerbatim-
 * Arguments to bypass Node's secondary quoting. Without this dance, spawning
 * an npm.cmd / pm2.cmd shim throws EINVAL on Node >= 18.20.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  // Step 1: CRT quoting (if needed)
  const needsQuotes = /[\s"]/.test(arg);
  let out = arg;
  if (needsQuotes) {
    // Double trailing backslashes before the closing quote; escape internal
    // quotes by doubling preceding backslashes and prefixing with backslash.
    out = out.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    out = `"${out}"`;
  }
  // Step 2: cmd.exe metacharacter caret-escape. Outside quotes we always
  // escape; inside quotes cmd still interprets `^` and `%`, so escape those
  // too. (We caret-escape unconditionally — caret on a non-meta char is a
  // no-op for cmd.)
  return out.replace(/([()%!^"<>&|])/g, '^$1');
}

function isBatchFile(exePath: string): boolean {
  return /\.(cmd|bat)$/i.test(exePath);
}

function buildSpawnArgs(
  exePath: string,
  args: string[],
  platform: NodeJS.Platform,
): { file: string; args: string[]; useVerbatim: boolean } {
  if (platform === 'win32' && isBatchFile(exePath)) {
    // cmd.exe /s /c quirk: cmd strips the OUTER quote pair around the
    // command-after-/c unless /s is given AND the command is wrapped in an
    // ADDITIONAL pair of quotes. So if exePath has spaces (e.g.,
    // "C:\Program Files\nodejs\npm.cmd"), we need a double-wrap:
    //   cmd /d /s /c ""C:\...\npm.cmd" --version"
    // cross-spawn does the same. With windowsVerbatimArguments: true Node
    // doesn't apply its own CRT quoting, so the raw string above is what
    // cmd actually receives.
    const quotedExe = /\s/.test(exePath) ? `"${exePath}"` : exePath;
    const quoted = args.map(quoteForCmd);
    const inner = [quotedExe, ...quoted].join(' ');
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      useVerbatim: true,
    };
  }
  return { file: exePath, args, useVerbatim: false };
}

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
    const env = scrubEnv();
    const exePath = resolveExecutable(input.command, env);
    const spawnPlan = buildSpawnArgs(exePath, input.args, process.platform);
    const child = spawn(spawnPlan.file, spawnPlan.args, {
      cwd,
      env,
      shell: false, // NON-NEGOTIABLE — see header comment.
      windowsHide: true,
      windowsVerbatimArguments: spawnPlan.useVerbatim,
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
