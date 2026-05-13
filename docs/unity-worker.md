# Unity worker

Spawn-and-watch integration between Cowire and the Unity Editor. Use it to:

- Watch compile errors in real time as Claude Code drops C# scripts into a Unity project.
- See play-mode exceptions surfaced as worker errors in the audit log.
- Run Unity in headless batch mode for CI-style automation, or attach to a live Editor for interactive game dev.

The worker spawner lives at [`src/workers/unity.ts`](../src/workers/unity.ts). The matching Editor-side bridge is shipped as [`dist/unity-bridge/CowireBridge.cs`](../dist/unity-bridge/CowireBridge.cs).

---

## 1. Why a file bridge, not HTTP or TCP

Unity domain-reloads on every script change. Any in-process TCP server the Editor starts is killed on every save. HTTP-based bridges work for a few iterations and then die mid-build, leaving the operator wondering whether the worker is hung. Same story for named pipes.

File appends survive:

- Domain reloads (the file handle is closed and re-opened per append).
- Editor crashes — the file is on disk; the tailer just keeps reading.
- Batch mode — no GUI, same file format.
- Editor restart — pick up where we left off.

The cost is one fsync per event. At hundreds of compile errors per second it would matter; in practice you get a handful per build and the cost is invisible.

See [ADR-012 (event-driven over polling)](../adr/012-event-driven-over-polling.md) for the underlying invariant: chokidar's `awaitWriteFinish` gives us coalesced reads without burning CPU.

---

## 2. One-time install

```text
1. Open your Unity project in Unity Hub.
2. Create the folder Assets/Editor/Cowire/ (anywhere under Assets/Editor/ works).
3. Copy dist/unity-bridge/CowireBridge.cs into that folder.
4. Switch focus to Unity — it auto-compiles and the bridge logs
   "CowireBridge initialized" to Logs/cowire-events.jsonl.
```

The bridge is `#if UNITY_EDITOR`-gated, so it ships only with the Editor and never bloats player builds.

---

## 3. Spawning the worker

From a Cowire-connected Claude / CC session:

```jsonc
// worker_spawn
{
  "type": "unity",
  "name": "unity-mygame",
  "params": {
    "project_path": "C:/dev/games/MyGame",
    "attach": true
  }
}
```

That's enough. The worker:

1. Validates `project_path` is a Unity project (has `Assets/` + `ProjectSettings/`).
2. Truncates `Logs/cowire-events.jsonl` so previous events don't replay.
3. Starts chokidar on the events file.
4. Returns a `WorkerInstance` with `metadata.events_file` so a dashboard can deep-link.

To launch Unity instead of attaching:

```jsonc
{
  "type": "unity",
  "params": {
    "project_path": "C:/dev/games/MyGame",
    "attach": false,
    "batch_mode": false,
    "unity_executable": "C:/Program Files/Unity/Hub/Editor/6000.0.32f1/Editor/Unity.exe"
  }
}
```

For batch (no UI) automation: `batch_mode: true`.

---

## 4. Event taxonomy

The bridge writes one JSON object per line. The worker spawner maps each line to Cowire's worker-event vocabulary:

| Bridge `type`       | Cowire surface                                  | Notes                                              |
| ------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `compile_start`     | `progress` + `activity: "compiling"`            | Per compile pass (every script save).              |
| `compile_error`     | `progress` + `error` (recoverable)              | One per CS-prefixed error from the compiler.       |
| `compile_warning`   | `progress`                                      | Counted in metadata; not surfaced as `error`.      |
| `compile_finish`    | `progress` + `metadata { errors, warnings }`    | Closes the pass; downstream consumers wait on it.  |
| `reload_start`      | `activity: "reloading domain"`                  | The Editor is briefly unresponsive after.          |
| `reload_finish`     | `activity: "idle"`                              | Safe to run new scripts.                           |
| `play_mode_enter`   | `metadata { play_mode: "playing" }`             |                                                    |
| `play_mode_exit`    | `metadata { play_mode: "stopped" }`             |                                                    |
| `play_mode_error`   | `error` (recoverable)                           | Runtime NullReferenceException etc.                |
| `editor_log`        | `progress` (error level → `error`)              | Catch-all for Debug.LogError in Editor code.       |

The worker also keeps a small running tally in metadata: `compile_errors`, `compile_warnings`, `last_compile_assembly`, `play_mode`.

---

## 5. The "talk to Unity dev" loop

```text
operator ──► Co (orchestrator)
                │
                │  worker_spawn unity-mygame { attach: true }
                │  worker_spawn cc-feature-x { prompt: "Add a dash ability ..." }
                │
                ▼
       Cowire daemon (Switch)
                │  trust_scope: "unity-game-dev" (auto-approves cc + unity)
                │
                ├──► CC worker (in its own git worktree)
                │       writes Assets/Scripts/Dash.cs
                │
                └──► Unity worker (tails Logs/cowire-events.jsonl)
                        Unity Editor auto-recompiles
                        bridge writes compile_error CS0103
                        worker emits error → orchestrator → audit log
                        Co sees the error, spawns another CC with the diff
                        loop until compile_finish errors=0
```

The operator approves the trust scope once at the start of the session. Every CC spawn, every file write into `Assets/`, every Unity event after that flows through the audit log without further prompts. Revoke with `cowire trust-scope revoke unity-game-dev`.

---

## 6. Suggested first game

The pipeline stress-tests itself best with a top-down arena shooter — small enough to ship in one evening, big enough to exercise input, physics, sprites, audio, prefabs, and play-mode runtime behavior. Suggested feature pass order:

1. Player GameObject with WASD movement using `Rigidbody2D.velocity`.
2. Mouse-aim turret child; left-click fires a `Bullet` prefab.
3. Spawner system that drops simple `Enemy` prefabs at the screen edges.
4. Health + damage components on player and enemies.
5. Score UI via `TextMeshProUGUI`.
6. Death + restart flow.

Each step is one CC worker prompt. After each prompt, watch the Unity worker's metadata: when `compile_errors` returns to 0 and `play_mode` toggles `playing` → `stopped` without a `play_mode_error`, the step's done.

If you'd rather pick something else — a tower defense, a runner, a chess clone — the pipeline doesn't care. The scope of the first prompt is the only thing that changes.

---

## 7. Troubleshooting

**The events file never appears.** Confirm `Assets/Editor/Cowire/CowireBridge.cs` is in the project and Unity has compiled at least once after the file was added. Trigger a compile by saving any `.cs` file in the project.

**Events stop arriving mid-session.** Check `Logs/cowire-events.jsonl.1` — the bridge rotates at 5 MB. Both files are valid JSONL; the tailer always reads the current file.

**Worker shows `compile_errors > 0` forever.** The bridge counts per-pass. If the Editor never finishes compiling (e.g. an infinite-loop in an Editor script) you'll see `compile_start` with no matching `compile_finish`. Look at Unity's main `Editor.log` for the underlying hang.

**Unity is on a non-default Editor version.** Pass `unity_executable` explicitly. The default-discovery heuristic walks `C:\Program Files\Unity\Hub\Editor\` and picks the lexicographically greatest folder — fine for most users, wrong if you keep older LTS versions installed.

---

## 8. Roadmap

- **Dispatch:** plumb `worker_dispatch` so the orchestrator can tell the Editor to enter play mode, build a player, or run a specific EditMode test — the bridge would tail a sibling `cowire-commands.jsonl` for inbound messages.
- **Per-scene metadata:** include the active scene name in `play_mode_enter` so multi-scene games surface usefully in the dashboard.
- **Test runner integration:** subscribe to `TestRunnerApi` callbacks and emit per-test pass/fail events. Unblocks "have CC keep iterating until tests are green" loops.
