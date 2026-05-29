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
import type { HostHeadroomMonitor } from './observability/host-headroom-poller.js';
import type { HostCeiling } from './types/host-ceiling.js';
import { JobOrchestrator } from './jobs/orchestrator.js';
import { registerJobTools } from './jobs/tools.js';
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
import { buildChokepointGate } from './security/decision-gate.js';
import { Notifier } from './notify/notifier.js';
import { NtfyChannel } from './notify/channels/ntfy.js';
import { EmailChannel } from './notify/channels/email.js';
import { TelegramChannel } from './notify/channels/telegram.js';
import { wireNotifications } from './notify/wiring.js';
import { DigestScheduler } from './notify/digest.js';
import { TelegramPoller } from './notify/telegram-poller.js';
import { ReplyRouter } from './notify/reply-router.js';
import { RateLimiter } from './notify/rate-limit.js';
import { getLogger } from './log.js';

export interface SwitchServerHandle {
  server: McpServer;
  sessionId: string;
}

/**
 * Shared JobOrchestrator per broker. The orchestrator owns the in-process
 * map of live job handles; a single registry across all MCP sessions
 * connecting to the same daemon means two clients dispatch into the same
 * view of live work.
 *
 * worker-dispatch Phase 3c.2 — the legacy WorkerOrchestrator + its
 * per-broker map were deleted alongside the bespoke worker subsystem.
 * Only JobOrchestrator remains.
 */
const jobOrchestratorsByBroker = new WeakMap<Broker, JobOrchestrator>();
const trustStoresByBroker = new WeakMap<Broker, TrustStore>();
const stewardStoresByBroker = new WeakMap<Broker, StewardStore>();
const credentialStoresByBroker = new WeakMap<Broker, CredentialStore>();
const hostCeilingContextByBroker = new WeakMap<
  Broker,
  { ceiling: HostCeiling; monitor: HostHeadroomMonitor }
>();
const notifiersByBroker = new WeakMap<Broker, Notifier>();
const digestSchedulersByBroker = new WeakMap<Broker, DigestScheduler>();
const telegramPollersByBroker = new WeakMap<Broker, TelegramPoller>();
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

/**
 * Lazy JobOrchestrator factory. The host-ceiling context is read from
 * `hostCeilingContextByBroker` so the daemon's single setHostCeilingContext
 * call propagates whenever the orchestrator is constructed.
 *
 * worker-dispatch Phase 3c.2 — the binding-target catalogue
 * (cc / shell / mcp-server endpoints / etc.) is still operator-configured
 * out-of-band; a freshly-spawned JobOrchestrator has zero bindings and
 * `job_dispatch` calls return `unknown_binding` until the catalogue is
 * wired. The downstream `claude-execute-mcp-tool` BOM registers the first
 * concrete binding target.
 */
function getOrCreateJobOrchestrator(broker: Broker): JobOrchestrator {
  const existing = jobOrchestratorsByBroker.get(broker);
  if (existing) return existing;
  const ceilingCtx = hostCeilingContextByBroker.get(broker);
  const orch = new JobOrchestrator({
    broker,
    store: broker.store,
    ceiling: ceilingCtx?.ceiling,
    headroomMonitor: ceilingCtx?.monitor,
    // worker-dispatch Phase 4 — grant-scope-aware enforcement. Trust
    // store is shared per-broker; getOrCreateTrustStore is idempotent.
    trustStore: getOrCreateTrustStore(broker),
  });
  jobOrchestratorsByBroker.set(broker, orch);
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
 * Wire the host-resource-ceiling context onto this broker so any
 * JobOrchestrator created later (lazily, on first MCP connection) gets
 * admission control + Phase 5 load-shedding. The daemon calls this after
 * the host-headroom poller starts.
 *
 * Idempotent: re-calling replaces the context. If a JobOrchestrator has
 * already been constructed for this broker, its ceiling context is
 * updated too — otherwise the late-spawned orchestrator picks it up at
 * construction time.
 */
export function setHostCeilingContext(
  broker: Broker,
  ctx: { ceiling: HostCeiling; monitor: HostHeadroomMonitor },
): void {
  hostCeilingContextByBroker.set(broker, ctx);
  const jobOrch = jobOrchestratorsByBroker.get(broker);
  if (jobOrch) jobOrch.setHostCeilingContext(ctx);
}

export function getHostCeilingContext(
  broker: Broker,
): { ceiling: HostCeiling; monitor: HostHeadroomMonitor } | undefined {
  return hostCeilingContextByBroker.get(broker);
}

/**
 * Read-only accessor for an already-constructed JobOrchestrator. Returns
 * undefined when no MCP session has triggered orchestrator creation yet
 * — Phase 5 load-shedding uses this so the watchdog can become live the
 * moment the orchestrator does, without forcing eager construction at
 * daemon boot (which would change the broker startup semantics).
 *
 * worker-dispatch Phase 3c.2 — replaces the legacy `getOrchestrator`
 * that returned WorkerOrchestrator. Callers (daemon.ts load-shedder
 * wiring) use this to bind the shedder to job lifecycle.
 */
export function getJobOrchestrator(broker: Broker): JobOrchestrator | undefined {
  return jobOrchestratorsByBroker.get(broker);
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
  // v0.6.X — Telegram inbound poller. Without this, the inline Approve/Reject
  // buttons on outbound Telegram alerts are one-way: taps land at Telegram's
  // getUpdates queue with nothing draining them. When the bot token is set we
  // construct a ReplyRouter (sharing trustStore with the dashboard path so
  // grant_extension replies hit the same authority surface) and start the
  // poller. Skipped in test env unless STAVR_NOTIFY_FORCE_CHANNELS=1, matching
  // the channel-registration guard above.
  if (!isTestEnv && process.env.STAVR_NOTIFY_TELEGRAM_BOT_TOKEN) {
    const router = new ReplyRouter(broker, getOrCreateTrustStore(broker));
    const directiveRateLimiter = new RateLimiter({ max: 30, windowMs: 60_000 });
    const poller = new TelegramPoller({
      botToken: process.env.STAVR_NOTIFY_TELEGRAM_BOT_TOKEN,
      notifier,
      router,
      secret,
      db: broker.store.rawDb,
      broker,
      authorisedChatId: process.env.STAVR_NOTIFY_TELEGRAM_CHAT_ID,
      directiveRateLimiter,
    });
    poller.start();
    telegramPollersByBroker.set(broker, poller);
  }
  getLogger().info('notification fabric initialized', {
    channels: notifier.getChannelStatus().map((c) => ({ id: c.id, configured: c.configured })),
    telegram_poller: telegramPollersByBroker.has(broker),
  });
  return notifier;
}

export function getTelegramPoller(broker: Broker): TelegramPoller | undefined {
  return telegramPollersByBroker.get(broker);
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
  // family-mode-phase-1 Phases 2 / 3 / 4 / 4.5 / 4.6 — the structural
  // chokepoint. The gate here is the single point every MCP tool call
  // passes through; what it consults is "the permission model." Layer
  // order (top denies first):
  //   1. No-Go list                  — hard deny, identity-blind
  //   2. Layer 0 capability switch   — operator runtime kill switch
  //   3. Per-actor permission tier   — AUTO / CONFIRM / EXPLICIT / NO_GO
  //   3a. EXPLICIT also requires a recent WebAuthn assertion (Phase 3)
  //       — see decision-gate.ts::buildChokepointGate's EXPLICIT branch.
  //
  // Phases 4 / 4.5 / 4.6 close the loop at respond time: every decision
  // opened from here is stamped with `source_agent` (the actor below) +
  // `tier`, and respondToDecision enforces no-self-approval + operator-
  // only on a VERIFIED identity (see src/security/respond-policy.ts).
  //
  // Actor identity comes from the AsyncLocalStorage `logContext.actor_id`
  // (HTTP middleware stamps it per request — see transports.ts). Stdio
  // sessions and any other unstamped path fall through to the actor id
  // `'unstamped-loopback'`, which resolves via defaultTierFor() — so the
  // conservative bias in `src/tools/categories.ts` becomes the enforced
  // floor without per-test plumbing.
  const toolRegistry = getOrCreateToolRegistry(broker);
  const capabilityStore = getOrCreateCapabilityOverrideStore(broker);
  const actorPermissionStore = getOrCreateActorPermissionStore(broker);
  const identityStore = getOrCreateIdentityStore(broker);
  wrapServerForRegistry(
    server,
    toolRegistry,
    'server.ts',
    buildChokepointGate(broker, {
      capability: capabilityStore,
      actorPermissions: actorPermissionStore,
      identity: identityStore,
    }),
  );

  const trustStore = getOrCreateTrustStore(broker);
  const stewardStore = getOrCreateStewardStore(broker);
  // v0.6 — initialize notification fabric (no-op when STAVR_NOTIFY_SECRET unset).
  getOrCreateNotifier(broker);

  registerEmitEvent(server, broker);
  registerSubscribe(server, broker, sessionId);
  registerUnsubscribe(server, broker, sessionId);
  registerGetEvents(server, broker.store);
  registerDecisionTools(server, broker);
  registerGithubTools(server);
  registerGithubWriteTools(server, broker, { trustStore });
  // worker-dispatch Phase 3c.2 — only the job_* MCP surface remains.
  // The legacy worker_* tools + WorkerOrchestrator wiring deleted with
  // the bespoke worker subsystem.
  const jobOrchestrator = getOrCreateJobOrchestrator(broker);
  registerJobTools(server, jobOrchestrator);
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
  return { server, sessionId };
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
