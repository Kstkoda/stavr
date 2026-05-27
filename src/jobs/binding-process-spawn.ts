/**
 * process-spawn binding — the first ExecutorBinding (Phase 1).
 *
 * Spawns an OS process (no shell wrapper, no cmd window) and surfaces:
 *   - stdout/stderr lines as JOB_LOG events
 *   - process exit as a JOB_EXIT event with exitCode + reason
 *
 * Generic on purpose: this binding does NOT know about Claude Code, shells,
 * Unity, or script signing. Those callers (the future `claude-code-subprocess`
 * binding target, the shell helper, etc.) construct the params (command,
 * args, cwd, env) and consume the binding's events.
 *
 * Phase 1 does NOT implement `inject` — process-spawn does not have a generic
 * mid-flight injection channel. The shell binding caller MAY layer stdin
 * writes on top if it wants to support inject, but that is a per-target
 * concern, not a binding-kind concern.
 *
 * The binding name follows the catalogue convention: the kind is fixed
 * (process-spawn); the target is the named target the operator selects
 * (here: 'generic'). Future BOMs register more named targets in this kind
 * (e.g., 'claude-code-subprocess').
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { JobEventBus } from './event-bus.js';
import type {
  BindingCapabilities,
  BindingContext,
  BindingHandle,
  ExecutorBinding,
} from './types.js';

export const ProcessSpawnParams = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  /** Extra env vars merged on top of `process.env`. */
  env: z.record(z.string()).optional(),
  /** Optional stdin payload written once at start, then stdin is closed. */
  stdin: z.string().optional(),
  /** Treat `command` as a Node.js script — equivalent to `node <command>`.
   *  Convenience for tests + tooling that runs JS snippets without going
   *  through a separate `node` arg. */
  via_node: z.boolean().optional().default(false),
});

export type ProcessSpawnParamsT = z.infer<typeof ProcessSpawnParams>;

type SpawnFn = typeof nodeSpawn;

export interface ProcessSpawnBindingOptions {
  /** Inject a spawn implementation for tests. */
  spawn?: SpawnFn;
  /** Override the named target. Defaults to 'generic'. Future BOMs register
   *  specific targets ('claude-code-subprocess', etc.) by passing one in. */
  target?: string;
  displayName?: string;
  description?: string;
}

const CAPABILITIES: BindingCapabilities = { inject: false };

export function createProcessSpawnBinding(
  opts: ProcessSpawnBindingOptions = {},
): ExecutorBinding<ProcessSpawnParamsT> {
  const spawnFn: SpawnFn = opts.spawn ?? nodeSpawn;
  const target = opts.target ?? 'generic';
  const displayName = opts.displayName ?? 'Process spawn (generic)';
  const description =
    opts.description ??
    'Spawn an OS process (no shell wrapper). Stdout/stderr lines surface as job log events; exit emits a terminal event.';

  return {
    kind: 'process-spawn',
    target,
    displayName,
    description,
    capabilities: CAPABILITIES,
    paramsSchema: ProcessSpawnParams,

    async dispatch(params, _ctx: BindingContext): Promise<BindingHandle> {
      const bus = new JobEventBus();

      // via_node treats `command` as a Node.js source snippet evaluated via
      // `node -e <snippet>`. Without `-e`, Node would treat the string as a
      // file path and fail with exit 1 when it doesn't exist.
      const command = params.via_node ? process.execPath : params.command;
      const args = params.via_node ? ['-e', params.command, ...params.args] : params.args;

      const spawnOpts: SpawnOptions = {
        cwd: params.cwd,
        env: { ...process.env, ...(params.env ?? {}) },
        // shell: false (default). We never go through cmd.exe / sh — args are
        // passed literally to the kernel, no quoting / injection risk.
        shell: false,
        // Bind stdio so we can read lines and close gracefully. stdin is
        // piped so callers can optionally write a one-shot payload.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Detach=false: the child dies with the parent. Stavr is the parent
        // of its own jobs by design (Phase 1 / 2 — Phase 4 federation puts
        // remote-binding lifecycle on a peer's stavR, not this one).
      };

      let child: ChildProcess;
      try {
        child = spawnFn(command, args, spawnOpts);
      } catch (err) {
        throw new Error(
          `process-spawn dispatch failed: ${(err as Error).message ?? String(err)}`,
        );
      }

      // Write the one-shot stdin payload if provided, then close stdin so
      // the child sees EOF.
      if (params.stdin !== undefined && child.stdin) {
        child.stdin.end(params.stdin);
      } else if (child.stdin) {
        child.stdin.end();
      }

      // Line-oriented readers on stdout + stderr. We emit one job_log event
      // per line. format='raw' — bindings that want stream-json parsing layer
      // it on top by re-parsing and emitting `progress` events themselves
      // (the CC caller will do this in the downstream BOM).
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout, terminal: false });
        rl.on('line', (line) => {
          bus.emitLog({ stream: 'stdout', line, format: 'raw' });
        });
      }
      if (child.stderr) {
        const rl = createInterface({ input: child.stderr, terminal: false });
        rl.on('line', (line) => {
          bus.emitLog({ stream: 'stderr', line, format: 'raw' });
        });
      }

      let exited = false;
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        // Reason classification:
        //   - signal SIGTERM/SIGKILL with no code → terminated (we killed it
        //     OR the OS did; the orchestrator knows which based on whether
        //     terminate() initiated)
        //   - non-zero exit → crashed (caller may reclassify if it called
        //     terminate just before)
        //   - 0 or null with no signal → completed cleanly
        let reason: 'completed' | 'crashed' | 'terminated';
        if (signal) reason = 'terminated';
        else if (code === null || code === 0) reason = 'completed';
        else reason = 'crashed';
        bus.emitExit({ exitCode: code ?? undefined, reason });
      };

      child.on('exit', onExit);
      child.on('error', (err) => {
        bus.emitError({ message: err.message, recoverable: false });
        // Some 'error' events (ENOENT on spawn) fire BEFORE 'exit'; emit a
        // synthetic exit so the orchestrator's state machine still closes.
        if (!exited) {
          exited = true;
          bus.emitExit({ exitCode: undefined, reason: 'crashed' });
        }
      });

      const metadata: Record<string, unknown> = {
        command,
        args,
        cwd: params.cwd ?? process.cwd(),
        via_node: params.via_node ?? false,
      };

      return {
        pid: child.pid,
        metadata,
        events: bus,
        async terminate(force: boolean): Promise<{ exitCode?: number }> {
          if (exited) {
            return { exitCode: child.exitCode ?? undefined };
          }
          // Best-effort. Windows doesn't honor SIGTERM the way *nix does, but
          // ChildProcess.kill maps SIGTERM → TerminateProcess on Windows
          // anyway, so the practical effect is the same.
          try {
            child.kill(force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            // already gone; the exit handler will close out.
          }
          // Wait up to 5s for exit. On force we skip the wait — kill returns
          // immediately and the exit event will fire when the OS catches up.
          if (!force) {
            await waitForExit(child, 5_000);
            if (!exited) {
              try {
                child.kill('SIGKILL');
              } catch {
                /* ignore */
              }
            }
          }
          return { exitCode: child.exitCode ?? undefined };
        },
      };
    },
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
