# Writing a worker spawner

This guide walks through adding a new **worker spawner** to Cowire end-to-end, with a working `python` example. By the end you'll have read enough to add your own spawner and you'll have a copy-pasteable starting point.

A *worker spawner* is a file that teaches Switch how to start, observe, and stop one kind of workload — a Claude Code session, a `cmd` script, a Unity build, a Python script. Spawners are the main extension point of the worker subsystem. Adding a new type is one file.

Read this once end-to-end (~15 minutes) before starting. The canonical examples are [`src/workers/cc.ts`](../src/workers/cc.ts) (more complex — git worktree + chokidar) and [`src/workers/shell.ts`](../src/workers/shell.ts) (simpler — child_process + readline).

---

## 0. Decide whether this is a worker

A worker is anything Switch *spawns* — a process Switch starts and is responsible for the lifecycle of. If your code just wraps an external CLI for a synchronous call (`gh pr view 123`), that's an [adapter](./writing-an-adapter.md), not a worker.

Questions to ask:

- **Does it run for more than one request?** Workers are long-lived. An adapter call returns in seconds; a worker may run for hours.
- **Does the user want to see it?** Workers usually open a visible window or surface as a row in the future dashboard. Adapters are silent.
- **Does it emit events as it runs?** Workers produce `worker_progress`, `worker_metadata_changed`, `worker_activity`, `worker_terminated`. Adapters produce one response per call.

If you said yes to all three, write a worker. If you're unsure, write an adapter — workers carry more invariants.

---

## 1. The two invariants

Every worker spawner MUST:

1. **Be event-driven.** No `setInterval`. Use `child_process` events for exits, `chokidar` for filesystem changes, `readline` for line streams, native HTTP webhooks for cloud APIs. The orchestrator runs a single bounded one-shot 5-minute idle timer per worker — that is the *only* `setTimeout` in the worker subsystem.
2. **Be pluggable.** All your type-specific logic lives in one file at `src/workers/<type>.ts`. The only file you touch outside it is `src/workers/spawners-registry.ts`, to add one line.

If you can't honor (1) — for example, the underlying tool truly has no event source — write down the polling cost in your spawner's docstring and an ADR. Don't smuggle a `setInterval` past the orchestrator silently.

---

## 2. File location

Spawners live in `src/workers/<type>.ts`. One file per type. The file exports a default `WorkerSpawner`.

For this guide we'll write `src/workers/python.ts`. To make it real you would also add one line to `src/workers/spawners-registry.ts`.

---

## 3. The interface

```ts
import { z } from 'zod';
import type { WorkerInstance, WorkerSpawner, WorkerSpawnerContext } from './types.js';
```

Every spawner exports a default object with this shape:

```ts
export interface WorkerSpawner<TParams = unknown> {
  readonly type: string;             // 'python', 'cc', 'shell', ...
  readonly displayName: string;
  readonly description: string;
  readonly tier: 'auto' | 'confirm' | 'never';
  readonly paramsSchema: z.ZodTypeAny;
  spawn(params: TParams, ctx: WorkerSpawnerContext): Promise<WorkerInstance>;
  dispatch?(worker, message, ctx): Promise<void>;
}
```

`tier: 'confirm'` is the default for anything that runs user code. Use `'auto'` only when the worker is genuinely safe (read-only, no side effects beyond stdout). `'never'` blocks the type entirely — useful for retired spawners you want to keep in the source tree but never actually start.

---

## 4. The `WorkerInstance` you return

```ts
export interface WorkerInstance {
  pid: number | undefined;
  metadata: Record<string, unknown>;
  events: WorkerEventEmitter;
  terminate(force: boolean): Promise<{ exitCode?: number }>;
}
```

Use [`WorkerEventBus`](../src/workers/emitter.ts) — the bus the orchestrator subscribes to. You emit `progress`, `metadata`, `activity`, `exit`, `error` on it from your event sources.

---

## 5. Worked example — `src/workers/python.ts`

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { WorkerEventBus } from './emitter.js';
import type { WorkerInstance, WorkerSpawner } from './types.js';

const PythonParams = z.object({
  cwd: z.string().min(1),
  script: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  python: z.string().optional().default('python'),
});

const pythonSpawner: WorkerSpawner<z.infer<typeof PythonParams>> = {
  type: 'python',
  displayName: 'Python script',
  description: 'Run a Python script with line-by-line progress events.',
  tier: 'confirm',
  paramsSchema: PythonParams,

  async spawn(params, _ctx): Promise<WorkerInstance> {
    const bus = new WorkerEventBus();
    const child: ChildProcess = nodeSpawn(
      params.python,
      [params.script, ...params.args],
      { cwd: params.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const pipe = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr') => {
      if (!stream) return;
      const rl = createInterface({ input: stream });
      rl.on('line', (message) => bus.emitProgress({ message, payload: { channel } }));
    };
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    child.on('error', (err) => bus.emitError({ message: err.message, recoverable: false }));
    child.on('exit', (code, signal) => {
      const exitCode = code ?? undefined;
      const reason: 'completed' | 'crashed' | 'terminated' =
        exitCode === 0 ? 'completed' : signal ? 'terminated' : 'crashed';
      bus.emitExit({ exitCode, reason });
    });

    return {
      pid: child.pid,
      metadata: { cwd: params.cwd, script: params.script, python: params.python },
      events: bus,
      async terminate(force) {
        if (child.exitCode !== null) return { exitCode: child.exitCode };
        try {
          child.kill(force ? 'SIGKILL' : undefined);
        } catch {
          /* already gone */
        }
        return new Promise((resolve) => {
          child.once('exit', (code) => resolve({ exitCode: code ?? undefined }));
        });
      },
    };
  },
};

export default pythonSpawner;
```

That's a complete spawner in ~50 lines. To wire it in:

```ts
// src/workers/spawners-registry.ts
import pythonSpawner from './python.js';
export const allSpawners = [ccSpawner, shellSpawner, pythonSpawner];
```

`worker_list_types` immediately surfaces `python`; `worker_spawn` can now create one.

---

## 6. Tests

Use the same pattern as [`tests/workers/shell.test.ts`](../tests/workers/shell.test.ts):

- Inject `spawn` via an option on a factory function (the canonical spawners take `opts.spawn`, `opts.git`, `opts.watch`).
- Push bytes into the fake child's stdout; assert `progress` events arrive.
- Emit `exit` on the fake child; assert `exit` event reason and code.

Keep tests narrow — the orchestrator already has end-to-end coverage; your spawner test only proves the type-specific I/O.

---

## 7. Don't reach for these patterns

- **`setInterval`.** If your event source needs polling, do it once at startup and emit a single `error` event with `recoverable: true` documenting the gap.
- **State outside the file.** Spawners are stateless across spawns. The orchestrator owns `workers` rows. If you need to remember something for the next spawn, persist it via `ctx.emit` as a `worker_metadata_changed` event.
- **Direct broker access.** Use `ctx.emit(kind, payload)` if you need to publish your own custom event kinds — but first ask whether the existing `worker_*` kinds cover it. They were designed to.
- **Filesystem auto-discovery.** Tempting but adds packaging complexity for no gain. Register explicitly. See [ADR-014](../adr/014-spawner-static-registry.md).

---

## 8. Cross-references

- [`src/workers/types.ts`](../src/workers/types.ts) — interfaces.
- [`src/workers/orchestrator.ts`](../src/workers/orchestrator.ts) — what consumes your spawner.
- [`adr/012-event-driven-over-polling.md`](../adr/012-event-driven-over-polling.md) — the invariant.
- [`adr/016-cc-worker-uses-git-worktree-isolation.md`](../adr/016-cc-worker-uses-git-worktree-isolation.md) — why CC workers each get their own worktree.
- Spec 42 (`../privacy tracker/specs/42_event_driven_worker_orchestration.md`) — the design doc this guide implements.
