// v0.6.7 P1 — worker script writer.
//
// Replaces the prior inline `-Command "..."` invocation pattern with a
// write-script-to-disk + `-File <path>` pattern. The motivation is
// AV avoidance: Windows Defender and most third-party AV flag the
// "execute long string via -Command" pattern as suspicious because it's
// a common malware signature. Writing the same body to a `.ps1`/`.cmd`/`.sh`
// file and invoking `-File` instead bypasses that signature without
// changing what's actually executed.
//
// Files land in `${STAVR_HOME}/worker-scripts/<worker-id>.<ext>` with
// owner-only permissions (0o700 on Unix; NTFS ACLs default to user-only
// on Windows). Each script carries an audit header (worker id, creation
// timestamp, shell) so the operator can later grep `~/.stavr/worker-scripts/`
// and see exactly what was executed in their name.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stavrHome } from '../config.js';

/** Shells the worker subsystem can spawn. Must stay in sync with the
 *  ShellSpawnParams enum in `src/workers/shell.ts`. */
export type WorkerShell = 'cmd' | 'powershell' | 'bash';

export interface ScriptWriteInput {
  workerId: string;
  shell: WorkerShell;
  command: string;
  args?: string[];
  /** Optional pre-command sleep in seconds (v0.6.7 P2). */
  sleepBefore?: number;
  /** Optional post-command sleep in seconds (v0.6.7 P2). */
  sleepAfter?: number;
  /** Override the worker-scripts dir for tests. */
  baseDir?: string;
  /** Override the now-source for deterministic header timestamps in tests. */
  now?: () => Date;
}

export interface ScriptWriteResult {
  /** Absolute path to the written script. */
  path: string;
  /** File extension (`ps1` / `cmd` / `sh`). */
  ext: string;
  /** Invocation argv for child_process.spawn — argv0 + remaining args. */
  invocation: { argv0: string; argv: string[] };
}

const SCRIPT_EXT: Record<WorkerShell, string> = {
  powershell: 'ps1',
  cmd: 'cmd',
  bash: 'sh',
};

/** Default worker-scripts directory under STAVR_HOME. Test-overridable via
 *  the `baseDir` field on [[ScriptWriteInput]]. */
export function defaultScriptDir(): string {
  return join(stavrHome(), 'worker-scripts');
}

/**
 * Write a worker command to a per-worker script file and return the
 * invocation tuple. The caller is expected to pass `invocation.argv0` +
 * `invocation.argv` straight into `child_process.spawn` — no further
 * shell-escaping needed because the script body is a real file on disk,
 * not a shell-encoded argv string.
 */
export function writeWorkerScript(input: ScriptWriteInput): ScriptWriteResult {
  const ext = SCRIPT_EXT[input.shell];
  const dir = input.baseDir ?? defaultScriptDir();
  ensureDir(dir);
  const path = join(dir, `${input.workerId}.${ext}`);
  const body = composeScript(input);
  // 0o700 — owner read/write/exec only. On Windows chmod is a no-op,
  // but NTFS default ACLs already restrict to the owning user.
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    /* Windows: chmod isn't supported on FAT/exFAT; user-only ACLs cover us. */
  }
  return {
    path,
    ext,
    invocation: buildInvocation(input.shell, path),
  };
}

/**
 * Compose the script body — header (audit metadata) + optional pre-sleep +
 * the command line + optional post-sleep. Public so tests can pin the
 * exact byte sequence per shell.
 */
export function composeScript(input: ScriptWriteInput): string {
  const eol = input.shell === 'cmd' ? '\r\n' : '\n';
  const lines: string[] = [];
  const now = input.now ? input.now() : new Date();

  switch (input.shell) {
    case 'powershell':
      lines.push('#Requires -Version 5');
      lines.push(...auditHeader(input, now).map((l) => `# ${l}`));
      lines.push('$ErrorActionPreference = "Stop"');
      lines.push('');
      break;
    case 'cmd':
      lines.push('@echo off');
      lines.push(...auditHeader(input, now).map((l) => `REM ${l}`));
      lines.push('');
      break;
    case 'bash':
      lines.push('#!/usr/bin/env bash');
      lines.push('set -euo pipefail');
      lines.push(...auditHeader(input, now).map((l) => `# ${l}`));
      lines.push('');
      break;
  }

  if (input.sleepBefore && input.sleepBefore > 0) {
    lines.push(renderSleep(input.shell, input.sleepBefore));
  }

  const argsPart = input.args && input.args.length > 0 ? ` ${input.args.join(' ')}` : '';
  lines.push(`${input.command}${argsPart}`);

  if (input.sleepAfter && input.sleepAfter > 0) {
    lines.push(renderSleep(input.shell, input.sleepAfter));
  }

  // Trailing newline so editors and `tail` behave normally.
  return lines.join(eol) + eol;
}

/** Shell-correct sleep primitive (v0.6.7 P2). `timeout /t N` on Windows
 *  doesn't sleep in headless mode — confirmed via the 2026-05-17 stress
 *  test (8 cmd workers using `timeout` all reported done in <1 s instead
 *  of the intended 5–60 s). The `ping`-based fallback is the standard
 *  CMD pattern. */
export function renderSleep(shell: WorkerShell, seconds: number): string {
  if (seconds <= 0) return '';
  switch (shell) {
    case 'powershell':
      return `Start-Sleep -Seconds ${seconds}`;
    case 'cmd':
      // ping sends `N` packets at 1 s intervals → effective sleep is
      // `N-1` seconds, so request `seconds + 1` to land on the
      // operator-intended duration.
      return `ping 127.0.0.1 -n ${seconds + 1} >nul`;
    case 'bash':
      return `sleep ${seconds}`;
  }
}

/** child_process.spawn argv builder. Crucially: every shell now invokes
 *  via `<shell> -File <path>` (or equivalent), NOT `-Command "..."`. */
export function buildInvocation(
  shell: WorkerShell,
  scriptPath: string,
): { argv0: string; argv: string[] } {
  switch (shell) {
    case 'powershell':
      // -NoProfile cold-starts faster and bypasses the operator's profile
      // (which might import modules that fail and tank the worker).
      // -ExecutionPolicy Bypass lets unsigned scripts run in a session
      // without changing system policy. -File is the AV-friendly mode.
      return {
        argv0: 'powershell.exe',
        argv: [
          '-NoLogo',
          '-NonInteractive',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ],
      };
    case 'cmd':
      // `cmd.exe /c <path>` invokes the .cmd batch file. We deliberately
      // do NOT use `/k` (which leaves the cmd window open after script
      // exit) — non-interactive workers exit cleanly when the script
      // finishes.
      return { argv0: 'cmd.exe', argv: ['/c', scriptPath] };
    case 'bash':
      // `bash <path>` is enough — chmod 0o700 makes it executable, and
      // the `#!` shebang in the header would also work for direct
      // invocation, but going through `bash` is more portable across
      // weird PATH setups.
      return { argv0: 'bash', argv: [scriptPath] };
  }
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows: ignore */
  }
}

function auditHeader(input: ScriptWriteInput, now: Date): string[] {
  return [
    'stavR worker script — DO NOT EDIT',
    `worker_id: ${input.workerId}`,
    `created:   ${now.toISOString()}`,
    `shell:     ${input.shell}`,
    'audit:     this file is operator-visible audit of what stavR executed',
  ];
}

// --- v0.6.7 P1 (continued) — retention -------------------------------------

/** Default age (in days) beyond which worker scripts are eligible for
 *  cleanup. Override via `STAVR_WORKER_SCRIPT_RETENTION_DAYS` env. */
export const DEFAULT_RETENTION_DAYS = 7;

/** Read the configured retention window in days. */
export function retentionDays(): number {
  const raw = process.env.STAVR_WORKER_SCRIPT_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return n;
}

/**
 * Sweep the worker-scripts dir, removing files whose mtime is older than
 * `retentionDays()` days. Returns the number of files removed. Intended
 * to be called from a daily cron (ADR-037 backup job integration) — not
 * called automatically from inside the daemon hot path.
 */
export function cleanupOldScripts(opts: { baseDir?: string; now?: () => Date } = {}): number {
  const dir = opts.baseDir ?? defaultScriptDir();
  if (!existsSync(dir)) return 0;
  const cutoff = (opts.now ? opts.now() : new Date()).getTime() - retentionDays() * 86_400_000;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    try {
      const s = statSync(p);
      if (!s.isFile()) continue;
      if (s.mtimeMs < cutoff) {
        rmSync(p);
        removed++;
      }
    } catch {
      /* file vanished between readdir and stat; ignore */
    }
  }
  return removed;
}
