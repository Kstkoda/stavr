import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, statSync, readdirSync } from 'node:fs';
import { open as fsOpen, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import chokidar, { type FSWatcher } from 'chokidar';
import { WorkerEventBus } from './emitter.js';
import type { WorkerInstance, WorkerSpawner } from './types.js';

/**
 * Unity worker — attaches to a Unity Editor (or launches one) and surfaces
 * compile errors, play-mode exceptions, and editor lifecycle events as
 * Cowire worker events.
 *
 * Design: the worker does NOT shell out to Unity to read state. Unity domain-
 * reloads on every script change, which kills any in-process TCP server the
 * Editor might have started. Instead the worker watches a file:
 *
 *   <UnityProject>/Logs/cowire-events.jsonl
 *
 * The matching Editor-only C# script (Assets/Editor/Cowire/CowireBridge.cs,
 * see docs/unity-worker.md) appends one JSON event per line as the Editor
 * compiles, reloads, and runs play mode. Line-oriented file I/O survives:
 *   - Unity Editor crashes (Mono panics, asset import hangs)
 *   - Domain reloads (every script save)
 *   - Headless batch mode (-batchmode -projectPath ...)
 *   - Editor restarts and the user closing/reopening Unity
 *
 * Worker lifecycle:
 *   1. Validate the project path is a Unity project (has Assets/ + ProjectSettings/).
 *   2. Ensure the bridge script is installed under Assets/Editor/Cowire/.
 *   3. If attach=false, spawn Unity with -projectPath; otherwise rely on a
 *      running Editor.
 *   4. Tail Logs/cowire-events.jsonl with chokidar (event-driven, no polling
 *      — ADR-012 invariant). Emit worker_progress per JSONL event,
 *      worker_metadata_changed when the compile pass finishes (errors/warnings
 *      counters), and a worker error for compile errors so the dashboard
 *      surfaces them in red.
 */

export const UnitySpawnParams = z.object({
  /** Absolute path to the Unity project (the folder containing Assets/). */
  project_path: z.string().min(1),
  /**
   * If true (default), assume the user has Unity open on this project.
   * If false, launch the Unity Editor with -projectPath. Set unity_executable
   * when using attach=false.
   */
  attach: z.boolean().optional().default(true),
  /** Absolute path to Unity.exe / Unity / Unity Hub-managed executable. */
  unity_executable: z.string().optional(),
  /** Run Unity in batch mode (no Editor UI). Only respected when attach=false. */
  batch_mode: z.boolean().optional().default(false),
  /** Extra args to pass to Unity when launching (attach=false). */
  unity_args: z.array(z.string()).optional().default([]),
  /** Override the events file path. Default: <project>/Logs/cowire-events.jsonl. */
  events_file: z.string().optional(),
  /**
   * If true, remove the events file at spawn so we don't replay history. The
   * Editor bridge truncates on next compile anyway; this just makes the first
   * tail start clean.
   */
  truncate_on_start: z.boolean().optional().default(true),
});

export type UnitySpawnParamsT = z.infer<typeof UnitySpawnParams>;

type Spawner = typeof nodeSpawn;
type ChokidarWatch = (paths: string | string[], opts?: Parameters<typeof chokidar.watch>[1]) => FSWatcher;

export interface UnitySpawnerOptions {
  /** Inject child_process.spawn for tests. */
  spawn?: Spawner;
  /** Inject chokidar.watch for tests. */
  watch?: ChokidarWatch;
  /** Default unity_executable when params doesn't supply one. */
  defaultUnityExecutable?: string;
}

/** One line of cowire-events.jsonl. The bridge script is the source of truth. */
export interface UnityEvent {
  type: string;
  timestamp?: string;
  [k: string]: unknown;
}

export function createUnitySpawner(opts: UnitySpawnerOptions = {}): WorkerSpawner<UnitySpawnParamsT> {
  const spawnFn: Spawner = opts.spawn ?? nodeSpawn;
  const watchFn: ChokidarWatch = opts.watch ?? ((p, o) => chokidar.watch(p, o));

  return {
    type: 'unity',
    displayName: 'Unity Editor',
    description:
      'Attach to a running Unity Editor (or launch one) and stream compile errors, play-mode exceptions, and editor lifecycle events back to Cowire. Requires the CowireBridge.cs Editor script installed in the Unity project (see docs/unity-worker.md).',
    tier: 'confirm',
    paramsSchema: UnitySpawnParams,

    async spawn(params, _ctx): Promise<WorkerInstance> {
      const projectPath = resolve(params.project_path);
      const assetsPath = join(projectPath, 'Assets');
      const projectSettingsPath = join(projectPath, 'ProjectSettings');

      if (!existsSync(assetsPath) || !existsSync(projectSettingsPath)) {
        throw new Error(
          `not a Unity project: ${projectPath} (missing Assets/ or ProjectSettings/)`,
        );
      }

      const logsDir = join(projectPath, 'Logs');
      mkdirSync(logsDir, { recursive: true });
      const eventsFile = params.events_file
        ? resolve(params.events_file)
        : join(logsDir, 'cowire-events.jsonl');

      // Best-effort truncate so the first compile pass after spawn doesn't
      // replay every event from the previous Cowire session. The bridge
      // tolerates a missing file (it creates it on first append).
      if (params.truncate_on_start) {
        try {
          closeSync(openSync(eventsFile, 'w'));
        } catch {
          /* not fatal — chokidar will pick it up when the bridge first writes */
        }
      }

      const bus = new WorkerEventBus();

      // Optionally launch Unity. attach=true is the default and the rock-solid
      // path: the user has Unity open, we just observe.
      let child: ChildProcess | undefined;
      let pid: number | undefined;
      if (!params.attach) {
        child = launchUnity(spawnFn, {
          unityExecutable:
            params.unity_executable ??
            opts.defaultUnityExecutable ??
            process.env.COWIRE_UNITY_EXECUTABLE ??
            defaultUnityExecutable(),
          projectPath,
          batchMode: params.batch_mode,
          extraArgs: params.unity_args,
        });
        pid = child.pid;

        child.on('error', (err) => {
          bus.emitError({ message: `unity launch failed: ${err.message}`, recoverable: false });
        });
        child.on('exit', (code, signal) => {
          // When we launched Unity, its exit is the worker's exit. In attach
          // mode we never emit exit from a child — the user terminates via
          // worker_terminate or the orchestrator's idle timeout.
          const exitCode = code ?? undefined;
          const reason: 'completed' | 'crashed' | 'terminated' =
            exitCode === 0 ? 'completed' : signal ? 'terminated' : 'crashed';
          bus.emitExit({ exitCode, reason });
        });
      }

      const metadata: Record<string, unknown> = {
        project_path: projectPath,
        events_file: eventsFile,
        attached: params.attach,
        batch_mode: !params.attach && params.batch_mode,
        unity_pid: pid,
        // Counters updated as compile passes finish.
        compile_errors: 0,
        compile_warnings: 0,
        last_compile_assembly: null as string | null,
        play_mode: 'stopped' as 'stopped' | 'entering' | 'playing' | 'exiting',
      };
      bus.emitMetadata({ patch: metadata });

      // Tail the JSONL file. chokidar fires `add` when the file first appears
      // and `change` on each append. We read from the last position so memory
      // stays bounded.
      const tail = createJsonlTailer({
        file: eventsFile,
        watchFn,
        onEvent: (evt) => handleEvent(evt, bus, metadata),
        onError: (msg) => bus.emitError({ message: msg, recoverable: true }),
      });

      return {
        pid,
        metadata,
        events: bus,
        async terminate(force: boolean): Promise<{ exitCode?: number }> {
          await tail.close();
          if (!child) {
            // attach mode: nothing to kill. We synthesize a terminated exit so
            // the orchestrator can mark the worker stopped.
            bus.emitExit({ exitCode: undefined, reason: 'terminated' });
            return { exitCode: undefined };
          }
          if (child.exitCode !== null) return { exitCode: child.exitCode };
          try {
            if (force) child.kill('SIGKILL');
            else child.kill();
          } catch {
            /* already gone */
          }
          return new Promise((resolveExit) => {
            if (child!.exitCode !== null) {
              resolveExit({ exitCode: child!.exitCode });
              return;
            }
            child!.once('exit', (code) => resolveExit({ exitCode: code ?? undefined }));
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// JSONL tailer — chokidar-driven, no polling. Reads from the last known byte
// offset on each `change` event. Handles truncation (size went down) by
// resetting the offset to 0.
// ---------------------------------------------------------------------------

interface TailerArgs {
  file: string;
  watchFn: ChokidarWatch;
  onEvent: (evt: UnityEvent) => void;
  onError: (msg: string) => void;
}

interface Tailer {
  close(): Promise<void>;
}

function createJsonlTailer(args: TailerArgs): Tailer {
  let offset = 0;
  let buf = '';
  let busy = false;
  let pending = false;

  // If the file already exists at attach time, start from its end — we don't
  // want to replay historical events. The Unity worker normally truncates on
  // spawn so this is a no-op, but it's safe either way.
  try {
    if (existsSync(args.file)) {
      offset = statSync(args.file).size;
    }
  } catch {
    /* ignore */
  }

  const drain = async (): Promise<void> => {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      let handle: FileHandle | undefined;
      try {
        handle = await fsOpen(args.file, 'r');
      } catch {
        // File not yet created. chokidar will fire `add` when it appears.
        return;
      }
      try {
        const stat = await handle.stat();
        // Truncation: size shrank. Reset and re-read from the top.
        if (stat.size < offset) {
          offset = 0;
          buf = '';
        }
        if (stat.size === offset) return;
        const length = stat.size - offset;
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        offset = stat.size;
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try {
              const evt = JSON.parse(line) as UnityEvent;
              args.onEvent(evt);
            } catch {
              // Treat as plain log line — the bridge promised JSONL, but the
              // user may have appended manually. Don't lose it.
              args.onEvent({ type: 'raw', message: line });
            }
          }
          nl = buf.indexOf('\n');
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      args.onError(`tail read failed: ${(err as Error).message}`);
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void drain();
      }
    }
  };

  const watcher = args.watchFn(args.file, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 25 },
  });
  watcher.on('add', () => void drain());
  watcher.on('change', () => void drain());
  watcher.on('error', (err) => args.onError(`watcher error: ${(err as Error).message}`));

  return {
    async close() {
      await watcher.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Event handler — maps bridge events to Cowire worker events.
// ---------------------------------------------------------------------------

function handleEvent(
  evt: UnityEvent,
  bus: WorkerEventBus,
  metadata: Record<string, unknown>,
): void {
  // Always emit the raw event so the dashboard / tail can render it.
  bus.emitProgress({
    message: describe(evt),
    payload: { source: 'unity', event: evt },
  });

  switch (evt.type) {
    case 'compile_start':
      metadata.compile_errors = 0;
      metadata.compile_warnings = 0;
      bus.emitActivity({ detail: 'compiling' });
      bus.emitMetadata({ patch: { compile_errors: 0, compile_warnings: 0 } });
      break;
    case 'compile_error':
      metadata.compile_errors = (metadata.compile_errors as number) + 1;
      bus.emitError({
        message: formatCompileMessage(evt),
        recoverable: true,
      });
      bus.emitMetadata({ patch: { compile_errors: metadata.compile_errors } });
      break;
    case 'compile_warning':
      metadata.compile_warnings = (metadata.compile_warnings as number) + 1;
      bus.emitMetadata({ patch: { compile_warnings: metadata.compile_warnings } });
      break;
    case 'compile_finish':
      metadata.last_compile_assembly = typeof evt.assembly === 'string' ? evt.assembly : null;
      bus.emitActivity({ detail: 'idle' });
      bus.emitMetadata({
        patch: {
          last_compile_assembly: metadata.last_compile_assembly,
          compile_errors: typeof evt.errors === 'number' ? evt.errors : metadata.compile_errors,
          compile_warnings:
            typeof evt.warnings === 'number' ? evt.warnings : metadata.compile_warnings,
        },
      });
      break;
    case 'reload_start':
      bus.emitActivity({ detail: 'reloading domain' });
      break;
    case 'reload_finish':
      bus.emitActivity({ detail: 'idle' });
      break;
    case 'play_mode_enter':
      metadata.play_mode = 'playing';
      bus.emitMetadata({ patch: { play_mode: 'playing' } });
      bus.emitActivity({ detail: 'play mode' });
      break;
    case 'play_mode_exit':
      metadata.play_mode = 'stopped';
      bus.emitMetadata({ patch: { play_mode: 'stopped' } });
      bus.emitActivity({ detail: 'idle' });
      break;
    case 'play_mode_error':
      bus.emitError({
        message: typeof evt.stack === 'string' ? evt.stack : 'play-mode exception',
        recoverable: true,
      });
      break;
    case 'editor_log':
      if (evt.level === 'error') {
        bus.emitError({
          message: typeof evt.message === 'string' ? evt.message : 'editor error',
          recoverable: true,
        });
      }
      break;
    default:
      // Unknown event types still flowed through as a progress event above.
      break;
  }
}

function describe(evt: UnityEvent): string {
  switch (evt.type) {
    case 'compile_start':
      return 'unity:compile_start';
    case 'compile_error':
      return `unity:compile_error ${formatCompileMessage(evt)}`;
    case 'compile_warning':
      return `unity:compile_warning ${formatCompileMessage(evt)}`;
    case 'compile_finish':
      return `unity:compile_finish assembly=${String(evt.assembly ?? 'unknown')} errors=${String(evt.errors ?? '?')} warnings=${String(evt.warnings ?? '?')}`;
    case 'reload_start':
      return 'unity:reload_start';
    case 'reload_finish':
      return 'unity:reload_finish';
    case 'play_mode_enter':
      return 'unity:play_mode_enter';
    case 'play_mode_exit':
      return 'unity:play_mode_exit';
    case 'play_mode_error':
      return `unity:play_mode_error ${String(evt.stack ?? '').slice(0, 200)}`;
    case 'editor_log':
      return `unity:editor_log[${String(evt.level ?? 'info')}] ${String(evt.message ?? '').slice(0, 200)}`;
    case 'raw':
      return `unity:raw ${String((evt as { message?: unknown }).message ?? '').slice(0, 200)}`;
    default:
      return `unity:${evt.type}`;
  }
}

function formatCompileMessage(evt: UnityEvent): string {
  const file = typeof evt.file === 'string' ? evt.file : '?';
  const line = typeof evt.line === 'number' ? evt.line : '?';
  const col = typeof evt.column === 'number' ? `:${evt.column}` : '';
  const msg = typeof evt.message === 'string' ? evt.message : '';
  return `${file}:${line}${col} ${msg}`.trim();
}

// ---------------------------------------------------------------------------
// Unity launcher (only used when attach=false).
// ---------------------------------------------------------------------------

interface LaunchUnityOpts {
  unityExecutable: string;
  projectPath: string;
  batchMode: boolean;
  extraArgs: string[];
}

function launchUnity(spawnFn: Spawner, opts: LaunchUnityOpts): ChildProcess {
  if (!opts.unityExecutable) {
    throw new Error(
      'unity_executable is required when attach=false (or set COWIRE_UNITY_EXECUTABLE)',
    );
  }
  const args: string[] = [
    '-projectPath',
    opts.projectPath,
    ...(opts.batchMode ? ['-batchmode', '-nographics'] : []),
    ...opts.extraArgs,
  ];
  const spawnOpts: SpawnOptions = {
    cwd: opts.projectPath,
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
    windowsHide: false,
    detached: false,
  };
  return spawnFn(opts.unityExecutable, args, spawnOpts);
}

function defaultUnityExecutable(): string {
  // Best-effort guess. Users with multiple Unity versions installed via Unity
  // Hub should pass an explicit unity_executable.
  if (process.platform === 'win32') {
    const hubRoot = 'C:\\Program Files\\Unity\\Hub\\Editor';
    try {
      const versions = readdirSafe(hubRoot);
      if (versions.length > 0) {
        // Pick the lexicographically greatest — usually the newest stable.
        const latest = versions.sort().reverse()[0];
        return join(hubRoot, latest, 'Editor', 'Unity.exe');
      }
    } catch {
      /* fall through */
    }
    return '';
  }
  if (process.platform === 'darwin') {
    return '/Applications/Unity/Hub/Editor';
  }
  return '';
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const unitySpawner = createUnitySpawner();
export default unitySpawner;
