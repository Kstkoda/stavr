import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Broker, newSessionId } from './broker.js';
import {
  Event,
  EventKind,
  validatePayloadForKind,
  type EventKindT,
} from './event-types.js';
import type { EventStore } from './persistence.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerGithubTools } from './adapters/github.js';
import { registerGithubWriteTools } from './adapters/github-writes.js';
import { WorkerOrchestrator } from './workers/orchestrator.js';
import { allSpawners } from './workers/spawners-registry.js';
import { registerWorkerTools } from './workers/tools.js';
import { TrustStore } from './trust/store.js';
import { registerTrustScopeTools } from './trust/tools.js';
import { initTrustReporter } from './trust/reporter.js';
import { StewardStore } from './steward/store.js';
import { registerStewardTools } from './steward/tools.js';
import { CredentialStore } from './credentials/store.js';
import { registerCredentialTools } from './credentials/tools.js';
import { registerStewardAskTool } from './steward-ask-tool.js';

export interface SwitchServerHandle {
  server: McpServer;
  sessionId: string;
  orchestrator: WorkerOrchestrator;
}

/**
 * Shared orchestrator per broker. The orchestrator owns the in-process map of
 * live worker instances; we want a single registry across all MCP sessions
 * connecting to the same daemon (otherwise two clients could spawn workers
 * the other never sees).
 */
const orchestratorsByBroker = new WeakMap<Broker, WorkerOrchestrator>();
const trustStoresByBroker = new WeakMap<Broker, TrustStore>();
const stewardStoresByBroker = new WeakMap<Broker, StewardStore>();
const credentialStoresByBroker = new WeakMap<Broker, CredentialStore>();

function getOrCreateOrchestrator(broker: Broker, trustStore: TrustStore): WorkerOrchestrator {
  const existing = orchestratorsByBroker.get(broker);
  if (existing) return existing;
  const orch = new WorkerOrchestrator({ broker, store: broker.store, trustStore });
  for (const s of allSpawners) orch.register(s);
  orchestratorsByBroker.set(broker, orch);
  return orch;
}

export function getOrCreateTrustStore(broker: Broker): TrustStore {
  const existing = trustStoresByBroker.get(broker);
  if (existing) return existing;
  const ts = new TrustStore(broker.store);
  trustStoresByBroker.set(broker, ts);
  initTrustReporter(broker, ts);
  return ts;
}

export function getOrCreateStewardStore(broker: Broker): StewardStore {
  const existing = stewardStoresByBroker.get(broker);
  if (existing) return existing;
  const s = new StewardStore(broker.store);
  stewardStoresByBroker.set(broker, s);
  return s;
}

/**
 * Externally-initialized credential store. The daemon calls this once on
 * boot (after loading the master key). When unset, credential tools are
 * silently skipped — keeps tests and stdio-only mode working without a key.
 */
export function setCredentialStore(broker: Broker, store: CredentialStore): void {
  credentialStoresByBroker.set(broker, store);
}

export function getCredentialStore(broker: Broker): CredentialStore | undefined {
  return credentialStoresByBroker.get(broker);
}

export function createSwitchServer(broker: Broker): SwitchServerHandle {
  const sessionId = newSessionId();
  const server = new McpServer({ name: 'cowire-switch', version: '0.1.0' });
  broker.registerSession(sessionId, server);

  const trustStore = getOrCreateTrustStore(broker);
  const stewardStore = getOrCreateStewardStore(broker);
  const orchestrator = getOrCreateOrchestrator(broker, trustStore);

  registerEmitEvent(server, broker);
  registerSubscribe(server, broker, sessionId);
  registerUnsubscribe(server, broker, sessionId);
  registerGetEvents(server, broker.store);
  registerDecisionTools(server, broker);
  registerGithubTools(server);
  registerGithubWriteTools(server, broker, { trustStore });
  registerWorkerTools(server, orchestrator);
  registerTrustScopeTools(server, broker, trustStore);
  registerStewardTools(server, broker, stewardStore, trustStore);
  const credentialStore = credentialStoresByBroker.get(broker);
  if (credentialStore) {
    registerCredentialTools(server, broker, credentialStore);
  }
  registerStewardAskTool(server, broker);
  return { server, sessionId, orchestrator };
}

function registerEmitEvent(server: McpServer, broker: Broker): void {
  server.registerTool(
    'emit_event',
    {
      description:
        'Publish an event. Validates payload against the event taxonomy, persists, fans out to subscribers.',
      inputSchema: {
        kind: z.string(),
        payload: z.unknown(),
        correlation_id: z.string().optional(),
        tenant_id: z.string().optional(),
        source_agent: z.string(),
        at: z.string().datetime().optional(),
      },
    },
    async (args) => {
      const parsedKind = EventKind.safeParse(args.kind);
      if (!parsedKind.success) {
        return toolError(`unknown event kind: ${args.kind}`);
      }
      const kind: EventKindT = parsedKind.data;
      try {
        validatePayloadForKind(kind, args.payload);
      } catch (err) {
        return toolError(`invalid payload for ${kind}: ${(err as Error).message}`);
      }
      const event: Event = {
        kind,
        at: args.at ?? new Date().toISOString(),
        correlation_id: args.correlation_id,
        tenant_id: args.tenant_id,
        source_agent: args.source_agent,
        payload: args.payload,
      };
      const stored = await broker.publish(event);
      return toolJson({ event_id: stored.id, persisted_at: stored.persisted_at });
    },
  );
}

function registerSubscribe(server: McpServer, broker: Broker, sessionId: string): void {
  server.registerTool(
    'subscribe_to_events',
    {
      description:
        'Register this MCP session to receive notifications/event/published for the given kinds. Use ["*"] for all.',
      inputSchema: {
        kinds: z.array(z.string()).min(1),
        since_event_id: z.string().optional(),
      },
    },
    async (args) => {
      const sub = broker.subscribe(sessionId, args.kinds);
      let replayed = 0;
      if (args.since_event_id) {
        replayed = await broker.replayTo(sessionId, args.since_event_id, args.kinds);
      }
      return toolJson({
        subscription_id: sub.subscription_id,
        kinds: sub.kinds,
        replayed_events: replayed,
      });
    },
  );
}

function registerUnsubscribe(server: McpServer, broker: Broker, sessionId: string): void {
  server.registerTool(
    'unsubscribe',
    {
      description: 'Remove kinds from this session subscription. Omit kinds to remove all.',
      inputSchema: {
        kinds: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      broker.unsubscribe(sessionId, args.kinds);
      return toolJson({ ok: true });
    },
  );
}

function registerGetEvents(server: McpServer, store: EventStore): void {
  server.registerTool(
    'get_events',
    {
      description: 'Query the event log. Cursor on since_event_id (event id from a prior call).',
      inputSchema: {
        since_event_id: z.string().optional(),
        kinds: z.array(z.string()).optional(),
        source_agent: z.string().optional(),
        tenant_id: z.string().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async (args) => {
      const result = store.getEvents({
        sinceEventId: args.since_event_id,
        kinds: args.kinds,
        sourceAgent: args.source_agent,
        tenantId: args.tenant_id,
        limit: args.limit,
      });
      return toolJson(result);
    },
  );
}

export function toolJson(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}
