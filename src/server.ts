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
import { builtInSpawners, resolveAllSpawners } from './workers/spawners-registry.js';
import { ManifestError } from './workers/mcp-workers-config.js';
import { registerWorkerTools } from './workers/tools.js';
import { TrustStore } from './trust/store.js';
import { registerTrustScopeTools } from './trust/tools.js';
import { initTrustReporter } from './trust/reporter.js';
import { StewardStore } from './steward/store.js';
import { registerStewardTools } from './steward/tools.js';
import { CredentialStore } from './credentials/store.js';
import { registerCredentialTools } from './credentials/tools.js';
import { registerStewardAskTool } from './steward-ask-tool.js';
import { registerProposePlanTool } from './tools/propose-plan.js';
import { getV02Subsystem } from './steward/v02-wiring.js';
import { registerHostExecTool } from './security/host-exec-tool.js';
import { ActorPermissionStore } from './security/actor-permissions.js';
import { CapabilityOverrideStore } from './security/capability-overrides.js';
import { IdentityStore } from './security/identity-store.js';
import { WebAuthnCoordinator } from './security/webauthn.js';
import { createFederation, type FederationSubsystem } from './federation/index.js';
import { attachFederationReporter } from './federation/reporter.js';
import { STAVR_MCP_ICONS, STAVR_MCP_DESCRIPTION, STAVR_WEBSITE_URL } from './dashboard/components/stavr-icon.js';
import { ToolRegistry, wrapServerForRegistry } from './tools/registry.js';
import { Notifier } from './notify/notifier.js';
import { NtfyChannel } from './notify/channels/ntfy.js';
import { EmailChannel } from './notify/channels/email.js';
import { TelegramChannel } from './notify/channels/telegram.js';
import { wireNotifications } from './notify/wiring.js';
import { DigestScheduler } from './notify/digest.js';
import { getLogger } from './log.js';

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
const notifiersByBroker = new WeakMap<Broker, Notifier>();
const digestSchedulersByBroker = new WeakMap<Broker, DigestScheduler>();
const toolRegistriesByBroker = new WeakMap<Broker, ToolRegistry>();

/**
 * Daemon-scoped tool catalog. One registry per broker; every MCP session
 * for that broker shares it. The registry is populated automatically by
 * `wrapServerForRegistry`, which patches `server.registerTool` to record
 * metadata before delegating to the SDK. Read by the `/dashboard/tools`
 * page (v0.6.9 PR #1) and the Layer 0 + per-actor matrix (PR #2).
 */
export function getOrCreateToolRegistry(broker: Broker): ToolRegistry {
  const existing = toolRegistriesByBroker.get(broker);
  if (existing) return existing;
  const registry = new ToolRegistry();
  toolRegistriesByBroker.set(broker, registry);
  return registry;
}

export function getToolRegistry(broker: Broker): ToolRegistry | undefined {
  return toolRegistriesByBroker.get(broker);
}

const capabilityOverrideStoresByBroker = new WeakMap<Broker, CapabilityOverrideStore>();
const actorPermissionStoresByBroker = new WeakMap<Broker, ActorPermissionStore>();
const identityStoresByBroker = new WeakMap<Broker, IdentityStore>();
const webauthnCoordsByBroker = new WeakMap<Broker, WebAuthnCoordinator>();
const federationByBroker = new WeakMap<Broker, FederationSubsystem>();

/**
 * Layer 0 capability override store — operator-runtime hard gate
 * (v0.6.9 PR #2). One per broker, backed by the broker's SQLite store.
 */
export function getOrCreateCapabilityOverrideStore(broker: Broker): CapabilityOverrideStore {
  const existing = capabilityOverrideStoresByBroker.get(broker);
  if (existing) return existing;
  const store = new CapabilityOverrideStore(broker.store.rawDb);
  capabilityOverrideStoresByBroker.set(broker, store);
  return store;
}

/**
 * Layer 3 per-actor permissions matrix (v0.6.9 PR #2). One per broker,
 * backed by the broker's SQLite store.
 */
export function getOrCreateActorPermissionStore(broker: Broker): ActorPermissionStore {
  const existing = actorPermissionStoresByBroker.get(broker);
  if (existing) return existing;
  const store = new ActorPermissionStore(broker.store.rawDb);
  actorPermissionStoresByBroker.set(broker, store);
  return store;
}

/**
 * Operator identity store + WebAuthn coordinator (v0.7 Phase 1, ADR-042
 * §Decision 3 v0.7). One pair per broker; the IdentityStore backs the
 * `operator_credentials` + `tier3_assertions` tables, and the
 * WebAuthnCoordinator owns the in-memory pending-challenge registry.
 */
export function getOrCreateIdentityStore(broker: Broker): IdentityStore {
  const existing = identityStoresByBroker.get(broker);
  if (existing) return existing;
  const store = new IdentityStore(broker.store.rawDb);
  identityStoresByBroker.set(broker, store);
  return store;
}

export function getOrCreateWebAuthnCoordinator(broker: Broker): WebAuthnCoordinator {
  const existing = webauthnCoordsByBroker.get(broker);
  if (existing) return existing;
  const coord = new WebAuthnCoordinator(getOrCreateIdentityStore(broker));
  webauthnCoordsByBroker.set(broker, coord);
  return coord;
}

/**
 * Federation subsystem (v0.7 Phase 2-trimmed). Lazy — only constructed
 * when first asked for, so tests that don't exercise federation pay
 * nothing. The daemon foreground path calls `.start()` after the HTTP
 * listener binds; tests use this getter as a singleton handle. */
export function getOrCreateFederation(broker: Broker): FederationSubsystem {
  const existing = federationByBroker.get(broker);
  if (existing) return existing;
  const fed = createFederation();
  // v0.7 Phase 3 — wire registry changes onto the broker as peer_joined /
  // peer_left events so dashboard subscribers see the same fact pattern
  // they see for everything else.
  attachFederationReporter(fed.registry, broker);
  federationByBroker.set(broker, fed);
  return fed;
}

function getOrCreateOrchestrator(broker: Broker, trustStore: TrustStore): WorkerOrchestrator {
  const existing = orchestratorsByBroker.get(broker);
  if (existing) return existing;
  const orch = new WorkerOrchestrator({ broker, store: broker.store, trustStore });
  // ADR-042 Decision 5 — register built-in in-process spawners + any
  // MCP-backed worker types from `~/.stavr/worker-mcp-servers.yaml`. A
  // manifest parse error is operator-visible: log + fall back to built-ins
  // so the daemon still boots with a usable worker set.
  let spawners;
  try {
    spawners = resolveAllSpawners();
  } catch (err) {
    if (err instanceof ManifestError) {
      // Use console.warn rather than the logger — at this construction
      // point the broker exists but the daemon's logger context isn't
      // guaranteed wired yet (legacy `getOrCreateOrchestrator` call sites
      // in tests). Operator sees the parse error on the daemon stderr.
      console.warn(`[stavr] ${err.message} — booting with built-in workers only`);
      spawners = builtInSpawners;
    } else {
      throw err;
    }
  }
  for (const s of spawners) orch.register(s);
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

/**
 * Initialize the v0.6 notification fabric for a broker. Idempotent — second
 * call returns the existing notifier without re-registering channels. Returns
 * undefined when STAVR_NOTIFY_SECRET is unset (fabric is opt-in by design;
 * absence of secret = absence of notifications).
 *
 * Test-environment guard (2026-05-17 hotfix): when running under vitest or
 * NODE_ENV=test, the notifier is still constructed and wired (so test code
 * can spy on .notify() calls and verify event flow), but real channels are
 * NOT registered — this prevents test events with throwaway titles like
 * "q" / "pick one" / "nobody home" from leaking out to the operator's actual
 * ntfy.sh / email / Telegram channels during CC autonomous runs. Operator can
 * still register custom test channels via notifier.registerChannel(...) inside
 * specific tests if needed. Force re-enable with STAVR_NOTIFY_FORCE_CHANNELS=1.
 */
export function getOrCreateNotifier(broker: Broker): Notifier | undefined {
  const existing = notifiersByBroker.get(broker);
  if (existing) return existing;
  const secret = process.env.STAVR_NOTIFY_SECRET;
  if (!secret) return undefined;
  const replyBaseUrl = process.env.STAVR_NOTIFY_REPLY_BASE_URL;
  const dashboardBaseUrl = process.env.STAVR_DASHBOARD_BASE_URL;
  const notifier = new Notifier({ secret, replyBaseUrl, db: broker.store.rawDb });
  const isTestEnv =
    (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') &&
    process.env.STAVR_NOTIFY_FORCE_CHANNELS !== '1';
  if (!isTestEnv) {
    notifier.registerChannel(new NtfyChannel());
    notifier.registerChannel(new EmailChannel());
    notifier.registerChannel(new TelegramChannel());
  }
  notifiersByBroker.set(broker, notifier);
  wireNotifications(broker, notifier, { dashboardBaseUrl });
  const digestEnabled = process.env.STAVR_NOTIFY_DIGEST_ENABLED !== 'false';
  if (digestEnabled) {
    const hour = parseInt(process.env.STAVR_NOTIFY_DIGEST_HOUR ?? '9', 10);
    const minute = parseInt(process.env.STAVR_NOTIFY_DIGEST_MINUTE ?? '0', 10);
    const sched = new DigestScheduler(notifier, { hour, minute, db: broker.store.rawDb });
    sched.start();
    digestSchedulersByBroker.set(broker, sched);
  }
  getLogger().info('notification fabric initialized', {
    channels: notifier.getChannelStatus().map((c) => ({ id: c.id, configured: c.configured })),
  });
  return notifier;
}

export function getNotifier(broker: Broker): Notifier | undefined {
  return notifiersByBroker.get(broker);
}

export function getDigestScheduler(broker: Broker): DigestScheduler | undefined {
  return digestSchedulersByBroker.get(broker);
}

export function createSwitchServer(broker: Broker): SwitchServerHandle {
  const sessionId = newSessionId();
  // v0.7 Phase 8 — advertise the Raido rune icon + description + website
  // so MCP clients (Cowork, Claude Code connector sidebar, etc.) render
  // the stavR brand instead of a generic placeholder. icons / description
  // / websiteUrl are part of the MCP Implementation schema (SDK 1.x).
  const server = new McpServer({
    name: 'stavr',
    version: '0.1.0',
    description: STAVR_MCP_DESCRIPTION,
    websiteUrl: STAVR_WEBSITE_URL,
    icons: STAVR_MCP_ICONS,
  });
  broker.registerSession(sessionId, server);

  // v0.6.9 PR #1 — observe every registerTool call into the broker's
  // ToolRegistry. Must run BEFORE the register*Tools calls below so the
  // wrapped registerTool is in place when subsystems register their
  // tools. Idempotent across sessions — wrapServerForRegistry tags the
  // patched method and bails on a second call.
  //
  // v0.6.9 PR #2 — also wire the Layer 0 runtime gate. Every tool
  // handler is wrapped to hit `CapabilityOverrideStore.check(toolId)`
  // BEFORE the user-supplied handler runs. If the operator has
  // disabled the tool via the dashboard, the call returns toolError
  // immediately without touching the subsystem code.
  const toolRegistry = getOrCreateToolRegistry(broker);
  const capabilityStore = getOrCreateCapabilityOverrideStore(broker);
  wrapServerForRegistry(server, toolRegistry, 'server.ts', {
    check(toolId: string): { allowed: boolean; reason?: string } {
      const res = capabilityStore.check(toolId);
      return res.allowed
        ? { allowed: true }
        : { allowed: false, reason: res.reason };
    },
  });

  const trustStore = getOrCreateTrustStore(broker);
  const stewardStore = getOrCreateStewardStore(broker);
  const orchestrator = getOrCreateOrchestrator(broker, trustStore);
  // v0.6 — initialize notification fabric (no-op when STAVR_NOTIFY_SECRET unset).
  getOrCreateNotifier(broker);

  registerEmitEvent(server, broker);
  registerSubscribe(server, broker, sessionId);
  registerUnsubscribe(server, broker, sessionId);
  registerGetEvents(server, broker.store);
  registerDecisionTools(server, broker);
  registerGithubTools(server);
  registerGithubWriteTools(server, broker, { trustStore });
  registerWorkerTools(server, orchestrator);
  registerTrustScopeTools(server, broker, trustStore);
  registerHostExecTool(server, broker, { trustStore });
  registerStewardTools(server, broker, stewardStore, trustStore);
  const credentialStore = credentialStoresByBroker.get(broker);
  if (credentialStore) {
    registerCredentialTools(server, broker, credentialStore);
  }
  registerStewardAskTool(server, broker);
  // v0.2 — propose_plan only when the experimental subsystem is wired up.
  const v02 = getV02Subsystem(broker);
  if (v02) {
    registerProposePlanTool(server, {
      planner: v02.planner,
      connectors: v02.connectors,
    });
  }
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
