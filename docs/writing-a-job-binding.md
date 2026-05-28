# Writing a job binding

> **worker-dispatch BOM Phase 3c.2** — this guide replaces the legacy
> `docs/writing-a-worker.md`. The bespoke worker-spawner subsystem was
> retired; the job model (one stavR-owned lifecycle record + a small
> closed set of pluggable executor bindings) is what extension authors
> work against now.

This guide walks through adding a new **executor binding** to stavR — the
extension point for "how does the orchestrator reach work?". Bindings
are the only place new spawn / call / attach kinds enter the system;
the four binding kinds themselves (`process-spawn`, `mcp-call`, `http`,
`cc-session-attach`) are a closed enum and **must not be added to** —
the BOM (line 19) is explicit: "if the bindings regrow into a sprawling
executor type taxonomy, the bespoke worker runtime has been quietly
rebuilt."

What IS open is the catalogue of **named binding targets** within each
kind. The `process-spawn` kind ships with a `generic` target; the
downstream `claude-execute-mcp-tool` BOM registers a
`claude-code-subprocess` target; an operator might register their own
`ollama-local` target under the `http` kind.

---

## 0. Decide whether you need a binding or a target

| You want to … | Add a binding kind | Add a binding target |
|---|---|---|
| Spawn an OS process for a job | No — use `process-spawn` | Yes (e.g. `'my-cli'`) |
| Call an MCP server tool | No — use `mcp-call` | Yes (operator-config) |
| Hit an HTTP endpoint | No — use `http` | Yes |
| Attach to a running CC session | No — use `cc-session-attach` | Yes |
| Reach work via a NEW transport (e.g. WebRTC) | **Stop.** Open a BOM. | — |

The pragmatic answer for ~all new work is "add a target." The four
binding kinds were chosen to cover every reasonable substrate; if you
think you've found a fifth, the BOM's invariant is to push the new
shape into one of the existing kinds as a target instead.

---

## 1. The binding interface

Defined in [`src/jobs/types.ts`](../src/jobs/types.ts):

```ts
export interface ExecutorBinding<TParams = unknown> {
  readonly kind: BindingKind;          // closed enum (4 kinds)
  readonly target: string;             // open catalogue
  readonly displayName: string;
  readonly description: string;
  readonly paramsSchema: z.ZodTypeAny; // operator-supplied params
  readonly capabilities: BindingCapabilities;
  dispatch(params: TParams, ctx: BindingContext): Promise<BindingHandle>;
}
```

The `BindingHandle` exposes a `JobEventBus`, an optional `inject()`
method (advertised via `capabilities.inject`), a `terminate(force)`
method, and a `pid` slot for the process-shaped kinds.

The canonical implementations are:

- [`src/jobs/binding-process-spawn.ts`](../src/jobs/binding-process-spawn.ts) — the simplest. Spawns an OS process; surfaces stdout/stderr lines as `job_log` events.
- [`src/jobs/binding-mcp-call.ts`](../src/jobs/binding-mcp-call.ts) — short MCP tool calls (long-running MCP-as-Tasks is queued under the separate `mcp-long-running-primitives-bom.md`).
- [`src/jobs/binding-http.ts`](../src/jobs/binding-http.ts) — HTTP POST + streamed response.
- [`src/jobs/binding-cc-session-attach.ts`](../src/jobs/binding-cc-session-attach.ts) — attach to a running CC session (preferred over process-spawn for CC; spawn made stavR own the CC crash surface).

Read whichever of those is shaped most like your target; copy its skeleton.

---

## 2. The two invariants

Every binding MUST:

1. **Be event-driven.** No `setInterval`. Use `child_process` events,
   `chokidar` for filesystem changes, `readline` for line streams,
   native HTTP webhooks for cloud APIs. The orchestrator's idle-timer
   is the *only* `setTimeout` in the job runtime layer.
2. **Be pluggable.** All your target-specific logic lives in one
   module — a function that returns an `ExecutorBinding`. The
   orchestrator registers it via `jobOrchestrator.register(binding)`;
   no other plumbing changes.

If your target genuinely has no event source (rare — most modern tools
do), document the polling cost in the binding's docstring and open an
ADR.

---

## 3. Registering a binding target

Bindings get registered against a `JobOrchestrator` instance via
`jobOrchestrator.register(binding)`. The orchestrator is built lazily
per broker — see [`src/server.ts`](../src/server.ts) `getOrCreateJobOrchestrator`.

For built-in targets that ship with stavR, register them inside the
`getOrCreateJobOrchestrator` factory the way the catalogue is wired
today. For operator-supplied targets (read from a yaml manifest, e.g.
the legacy `worker-mcp-servers.yaml` shape), the loader code in
[`src/jobs/`](../src/jobs/) is where you'd plug in.

The `kind:target` key in the registry must be unique. The orchestrator
throws on duplicate registration so collisions are caught at boot.

---

## 4. AV / EDR attribution

If your target is process-shaped and runs on Windows, the orchestrator
already wires AV/EDR attribution into the failure path via the
[`src/jobs/av-detector.ts`](../src/jobs/av-detector.ts) module
(EPERM/EACCES errors on the spawned process trigger a background
wevtutil query against the relevant channels). The attribution result
lands on the JobRecord's `metadata.av_block` slot; the dashboard +
notify fabric pick it up automatically. No work needed in your binding
beyond using `binding-process-spawn` as the substrate.

---

## 5. Helper modules

- [`src/jobs/script-writer.ts`](../src/jobs/script-writer.ts) — signed
  shell-script writer (`.ps1` / `.cmd` / `.sh`). Used by shell-flavored
  process-spawn callers. Documented operator-side in
  [`docs/worker-spawn.md`](./worker-spawn.md) (env-var names retain
  the "worker" spelling per the operator-surface lock).
- [`src/jobs/av-detector.ts`](../src/jobs/av-detector.ts) — see §4.
- [`src/jobs/event-bus.ts`](../src/jobs/event-bus.ts) — the
  `JobEventBus` your binding emits events into.

---

## 6. Test the binding

Bindings are pure modules — copy a test from `tests/jobs/binding-*.test.ts`
and adapt. The pattern is "construct the binding with a mock spawn /
transport / client, drive a synthetic exit through the event bus,
assert the emitted `job_log` / `job_terminated` payloads."

---

## Reference reading

- [`proposed/worker-dispatch-bom.md`](../proposed/worker-dispatch-bom.md) — the BOM that established this model.
- [`proposed/worker-dispatch-recon.md`](../proposed/worker-dispatch-recon.md) — the Phase 0 migration map (covers the legacy WorkerSpawner shape this guide replaced).
- [`adr/042-federation-roles-discovery-operator-identity-flow-viz-worker-spawner.md`](../adr/042-federation-roles-discovery-operator-identity-flow-viz-worker-spawner.md) — the federation-readiness design constraint the binding model satisfies.
