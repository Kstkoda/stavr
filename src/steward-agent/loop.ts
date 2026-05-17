// v0.5 P3 — Steward-agent in-subprocess loop.
//
// Receives IpcDaemonMessage envelopes via makeStewardLink, dispatches them to
// the right ModelRuntime method, and emits results back as IpcStewardMessage
// envelopes. The subprocess never dispatches BOMs — that's the daemon's job.
// Planned BOMs come back as `emit_event` envelopes with kind='bom_proposed' (for
// the live path) or kind='bom_proposed_shadow' (for P5 parity-shadow path).
//
// This file intentionally stays small. The migrated planner/executor/loop logic
// (~1240 LOC) is NOT rewritten here in P3 — the in-process Steward keeps that
// work during the shadow period. P3's subprocess only exercises the new
// ModelRuntime path for planning + responds to heartbeats. Cutover (a separate
// commit Kenneth lands) is where the full planner moves over.

import { makeStewardLink, type IpcStewardLink, type IpcDaemonMessage, type IpcStewardMessage } from '../steward/ipc.js';
import { runtimeFor, isValidationFailure } from './runtimes/index.js';
import type { RuntimeFactoryOpts } from './runtimes/index.js';
import type { ModelRuntime, PlanCtx, ToolSpec } from './runtimes/types.js';
import type { MemoryStore, LessonsStore, PrefsStore } from './db/types.js';
import { getLogger } from '../log.js';

export interface StewardAgentRequestPlan {
  type: 'request_plan';
  request_id: string;
  ctx: PlanCtx;
  tools: ToolSpec[];
  /** When true, result emits as bom_proposed_shadow (parity log) instead of bom_proposed. */
  shadow?: boolean;
}

export interface StewardAgentRequestDecide {
  type: 'request_decide';
  request_id: string;
  question: string;
  options: Array<{ id: string; label: string; rationale?: string }>;
  context?: string;
}

export type StewardAgentRequest = StewardAgentRequestPlan | StewardAgentRequestDecide;

/** Wire format extension — daemon → steward-agent for plan/decide invocation. */
function isAgentRequestEnvelope(msg: IpcDaemonMessage): msg is IpcDaemonMessage & { payload?: StewardAgentRequest } {
  return msg.type === 'event' && (msg as { kind?: string }).kind === 'steward_agent_request';
}

export interface StewardAgentLoopOpts {
  memory: MemoryStore;
  lessons: LessonsStore;
  prefs: PrefsStore;
  /** Override for tests; default reads process.env. */
  runtimeOpts?: RuntimeFactoryOpts;
  /** Override for tests; default makeStewardLink(). */
  link?: IpcStewardLink;
  /** Override for tests; default uses runtimeFor(...). */
  resolveRuntime?: (task: 'plan' | 'decide' | 'summarize') => ModelRuntime;
}

export interface StewardAgentLoopHandle {
  stop(): void;
  /** For tests: process one envelope directly. */
  dispatch(msg: IpcDaemonMessage): Promise<void>;
}

export function startStewardAgentLoop(opts: StewardAgentLoopOpts): StewardAgentLoopHandle {
  const link = opts.link ?? makeStewardLink();
  const log = getLogger();
  const resolveRuntime =
    opts.resolveRuntime ?? ((task) => runtimeFor(task, opts.prefs, opts.runtimeOpts ?? defaultRuntimeOpts()));

  // Emit ready as the very first message — daemon side waits on this before
  // sending anything else.
  link.send({ type: 'ready' });

  const offMessage = link.onMessage(async (msg) => {
    if (msg.type === 'ping') {
      link.send({ type: 'pong' });
      return;
    }
    if (isAgentRequestEnvelope(msg)) {
      await dispatch(msg);
    }
  });

  const offShutdown = link.onShutdown(() => {
    // graceful — main.ts catches and exits 0
    log.info('steward-agent loop received shutdown');
  });

  async function dispatch(msg: IpcDaemonMessage): Promise<void> {
    const env = msg as { type: 'event'; kind: string; payload?: StewardAgentRequest; correlation_id?: string };
    const req = env.payload;
    if (!req) return;

    if (req.type === 'request_plan') {
      try {
        const rt = resolveRuntime('plan');
        const ctx: PlanCtx = enrichCtx(req.ctx, opts.memory, opts.lessons);
        const result = await rt.plan(ctx, req.tools);
        // Persist outcome into episodic_log either way.
        opts.memory.appendEpisodic({
          kind: req.shadow ? 'plan_shadow_complete' : 'plan_complete',
          correlation_id: req.ctx.correlation_id,
          payload: {
            request_id: req.request_id,
            ok: !isValidationFailure(result),
            runtime: rt.name,
          },
        });
        emitResult(link, req.shadow ? 'bom_proposed_shadow' : 'bom_proposed', {
          request_id: req.request_id,
          ok: !isValidationFailure(result),
          result,
        }, req.ctx.correlation_id);
      } catch (err) {
        log.error('steward-agent plan dispatch failed', { error: (err as Error).message });
        emitResult(link, 'bom_proposed_error', {
          request_id: req.request_id,
          error: (err as Error).message,
        }, req.ctx.correlation_id);
      }
      return;
    }

    if (req.type === 'request_decide') {
      try {
        const rt = resolveRuntime('decide');
        const result = await rt.decide({
          question: req.question,
          options: req.options,
          context: req.context,
        });
        emitResult(link, 'steward_decision', {
          request_id: req.request_id,
          ok: !isValidationFailure(result),
          result,
        });
      } catch (err) {
        emitResult(link, 'steward_decision_error', {
          request_id: req.request_id,
          error: (err as Error).message,
        });
      }
    }
  }

  return {
    stop() {
      offMessage();
      offShutdown();
    },
    dispatch,
  };
}

function emitResult(link: IpcStewardLink, kind: string, payload: unknown, correlation_id?: string): void {
  const env: IpcStewardMessage = {
    type: 'emit_event',
    kind,
    payload,
    correlation_id,
  };
  link.send(env);
}

function enrichCtx(ctx: PlanCtx, memory: MemoryStore, lessons: LessonsStore): PlanCtx {
  if (ctx.lessons && ctx.working_memory) return ctx;
  const wmKeys = memory.listWorkingKeys();
  const wm: Record<string, unknown> = {};
  for (const k of wmKeys) wm[k] = memory.getWorking(k);
  const active = lessons.listActive(20).map((l) => ({ id: l.id, title: l.title, body: l.body }));
  return {
    ...ctx,
    lessons: ctx.lessons ?? active,
    working_memory: ctx.working_memory ?? wm,
  };
}

function defaultRuntimeOpts(): RuntimeFactoryOpts {
  return {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? '' },
    openai: { apiKey: process.env.OPENAI_API_KEY ?? '' },
    ollama: { host: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434' },
  };
}
