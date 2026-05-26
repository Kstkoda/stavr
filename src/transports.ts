import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { STAVR_VERSION } from './version.generated.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BoundedEventStore } from './observability/bounded-event-store.js';
import {
  createSwitchServer,
  getOrCreateTrustStore,
  getNotifier,
  getDigestScheduler,
  getOrCreateToolRegistry,
  getOrCreateCapabilityOverrideStore,
  getOrCreateActorPermissionStore,
} from './server.js';
import { loadChannelStatuses } from './dashboard/data/channels.js';
import { fetchToolsData } from './dashboard/data/tools-data.js';
import { fetchWorkerCounters } from './dashboard/data/worker-counters.js';
import { fetchHostCeilingData } from './dashboard/data/host-ceiling.js';
import { fetchTopologyExtras } from './dashboard/data/topology-data.js';
import { deriveLifecycleState } from './workers/lifecycle.js';
import { fetchPermissionsData } from './dashboard/data/permissions-data.js';
import { fetchDecisionsHistory } from './dashboard/data/history/decisions.js';
import { fetchScopesHistory } from './dashboard/data/history/scopes.js';
import { fetchPlansHistory } from './dashboard/data/history/plans.js';
import { fetchHostExecHistory } from './dashboard/data/history/host-exec.js';
import { fetchNotificationsHistory } from './dashboard/data/history/notifications.js';
import { fetchBomsHistory } from './dashboard/data/history/boms.js';
import { fetchCommitsHistory } from './dashboard/data/history/commits.js';
import { mergeTimeline } from './dashboard/data/history/timeline.js';
import { renderHistoryRow } from './dashboard/components/timeline-row.js';
import { renderHistoryDetail } from './dashboard/data/history/detail.js';
import { walkCorrelation, renderTraceHtml } from './dashboard/data/history/correlation.js';
import { TIERS, defaultTierFor, type Tier } from './tools/categories.js';
import {
  applyPolicyToActor,
  getPolicyPreset,
  listPolicyPresets,
} from './security/policies.js';
import type { Broker } from './broker.js';
import type { StoredEvent } from './persistence.js';
import { startupDecisionSweep } from './tools/decisions.js';
import { getLogger } from './log.js';
import { mountDashboardPages } from './dashboard/index.js';
import { memoize, resolveDashboardCacheMs, resolveWorkersMaxEvents } from './dashboard/memo.js';
import {
  normalizeRoute,
  registry as metricsRegistry,
  setSseSessionsGauge,
  stavrHttpRequestDuration,
} from './observability/metrics.js';
import { recordSloSample, SLO_DEFS } from './observability/slo.js';
import {
  recordGatewayRequest,
  setMcpServerSessionsActive,
  recordJsonRpcError,
  recordToolResponseDeliveryFailed,
  recordToolHandlerDurationAtClose,
  getDurabilitySnapshot,
} from './observability/mcp-metrics.js';
import { logContext } from './observability/logger.js';
import { mountDebugEndpoints } from './observability/debug-endpoints.js';
import { mountWebAuthnRoutes } from './security/webauthn-routes.js';
import { mayRespond } from './security/respond-policy.js';
import { mountFederationRoutes } from './federation/index.js';
import { getOrCreateIdentityStore, getOrCreateWebAuthnCoordinator, getOrCreateFederation } from './server.js';
import { attachMcpAttributes } from './observability/spans.js';
import { recordPerf, perfSnapshot } from './observability/perf-metrics.js';
import { getV02Subsystem } from './steward/v02-wiring.js';
import { computeUsage, fetchAnthropicBalance, type ComputeUsageOpts } from './usage.js';
import {
  PendingPairingRegistry,
  generateDeviceToken,
  hashToken,
} from './pairing.js';
import { heartbeatStore, validateHeartbeatBody } from './governor/heartbeat-store.js';

/**
 * Transport modes:
 *  - 'stdio'  : stdio transport only (for direct CC spawn / `stavr run`).
 *  - 'daemon' : HTTP/SSE only; binding the port is required (failure is fatal).
 *  - 'both'   : stdio + optional HTTP/SSE; EADDRINUSE falls back to stdio (back-compat for `stavr start`).
 */
export type TransportMode = 'stdio' | 'daemon' | 'both';

export interface TransportOpts {
  mode?: TransportMode;
  port?: number;
  /** Deprecated: prefer `mode`. Kept for `stavr start --stdio-only`. */
  stdioOnly?: boolean;
  silent?: boolean;
  /**
   * Host the HTTP/SSE listener binds to (spec 52). Defaults to `127.0.0.1` — local-only,
   * matching ADR-006. Non-loopback values must clear the auth gate.
   */
  bindHost?: string;
  /**
   * Refuse to start when `bindHost` is non-loopback and `authConfigured` is false.
   * Defaults to `true`. Setting this to `false` is the documented escape hatch for
   * known-trusted networks.
   */
  requireAuthWhenNonLocal?: boolean;
  /**
   * Whether the pairing-token subsystem is wired up. Computed by the caller as
   * `broker.store.countActiveDevices() > 0` (spec 52 A2). When true and the bind
   * is non-loopback, every non-public request must carry a valid Bearer token.
   */
  authConfigured?: boolean;
  /**
   * In-memory pending-pairing registry shared between `pair bootstrap` and the
   * remote `/pair/complete` endpoint. Spec 52 A2. Caller may pass their own (tests
   * do); otherwise mountTransports creates a fresh registry per daemon process.
   */
  pairingRegistry?: PendingPairingRegistry;
  /**
   * Override `Date.now()` for the pairing TTL. Test seam.
   */
  now?: () => number;
  /**
   * Interval (ms) for the standalone-GET stream keepalive. Defaults to
   * 20_000. Tests use a short value (e.g. 200) to assert the heartbeat
   * fires; production should leave at the default. See BOM
   * proposed/mcp-session-stability-bom.md Phase 2b.
   */
  mcpKeepaliveIntervalMs?: number;
}

export interface MountedTransports {
  httpServer?: HttpServer;
  shutdown: () => Promise<void>;
  /** Live count of connected SSE sessions (daemon mode only). */
  sseSessionCount: () => number;
  /**
   * The pending-pairing registry the HTTP transport is using. Exposed so the
   * `stavr pair bootstrap` CLI (which runs in the same daemon process) can
   * call `.open()` directly without an HTTP round-trip.
   */
  pairingRegistry: PendingPairingRegistry;
}

export async function mountTransports(
  broker: Broker,
  opts: TransportOpts,
): Promise<MountedTransports> {
  const logger = getLogger();
  const log = (m: string, metadata?: Record<string, unknown>) => {
    if (!opts.silent) logger.info(m, metadata);
  };

  // Resolve mode from explicit param or legacy `stdioOnly`.
  const mode: TransportMode = opts.mode ?? (opts.stdioOnly ? 'stdio' : 'both');
  const keepaliveIntervalMs = opts.mcpKeepaliveIntervalMs ?? 20_000;

  const sweptCount = await startupDecisionSweep(broker);
  if (sweptCount > 0) log(`startup sweep expired ${sweptCount} stale decision(s)`);

  if (mode !== 'daemon') {
    const stdioHandle = createSwitchServer(broker);
    await stdioHandle.server.connect(new StdioServerTransport());
    log('stdio transport ready');
  }

  let httpServer: HttpServer | undefined;
  let sessionJanitorHandle: ReturnType<typeof setInterval> | undefined;
  // MCP sessions keyed by Mcp-Session-Id. Each session holds its own
  // StreamableHTTPServerTransport instance and McpServer handle so the
  // broker can route per-session subscriptions. Name kept as `sseSessions`
  // because public surfaces (status JSON, dashboard) refer to it; the
  // underlying transport is now Streamable HTTP (closes audit major #2).
  type McpSession = {
    transport: StreamableHTTPServerTransport;
    handle: ReturnType<typeof createSwitchServer>;
    /**
     * 20s `notifications/message` heartbeat on the standalone GET stream.
     * Defence-in-depth against control-channel idle disconnect — see
     * BOM proposed/mcp-session-stability-bom.md Phase 2b. Cleared in
     * `transport.onclose` so the daemon never carries a dangling
     * interval for a closed session.
     */
    keepalive?: ReturnType<typeof setInterval>;
    /**
     * Per-session in-flight `tools/call` requests, keyed by JSON-RPC id,
     * value is the `performance.now()` start. Populated when the SDK
     * dispatches an incoming request through `transport.onmessage`;
     * any entry still present at `transport.onclose` is observed in the
     * Phase 3 delivery-failed counter + handler-duration histogram.
     * BOM proposed/mcp-session-stability-bom.md Phase 3.
     */
    inFlight: Map<string | number, number>;
  };
  const sseSessions = new Map<string, McpSession>();
  const refreshSseGauge = (): void => {
    setSseSessionsGauge(sseSessions.size);
    // BOM Wave 1 — dual-emit. Old stavr_sse_sessions stays for the
    // deprecation window; new mcp.server.sessions.active is the canonical
    // L5 name.
    setMcpServerSessionsActive(sseSessions.size);
  };
  refreshSseGauge();

  // v0.6.x memory-leak fix — visibility for the stateless-/mcp cleanup path
  // (when an incoming POST never adopts a session id). We flush an aggregated
  // `mcp_oneshot_cleanup` event at most once per 60s so the operator can see
  // the path is exercised, without spamming the event log when Cowork polls.
  const oneshotCleanup = (() => {
    let count = 0;
    let lastFlushMs = 0;
    return {
      tick(): void {
        count++;
        const now = Date.now();
        if (now - lastFlushMs < 60_000) return;
        const flushed = count;
        count = 0;
        lastFlushMs = now;
        void broker
          .publish({
            kind: 'mcp_oneshot_cleanup',
            at: new Date(now).toISOString(),
            source_agent: 'stavr-daemon',
            payload: {
              count_since_last_flush: flushed,
              broker_session_count: broker.sessionCount(),
            },
          })
          .catch(() => {
            /* persistence-failed; broker.publish already logs */
          });
      },
    };
  })();
  // Always create the registry — `pair bootstrap` may run in this same
  // process even when HTTP isn't mounted (rare, but the shape is uniform).
  const pairingRegistry = opts.pairingRegistry ?? new PendingPairingRegistry();

  const wantHttp = mode === 'daemon' || (mode === 'both' && opts.port !== undefined);
  if (wantHttp) {
    if (opts.port === undefined) throw new Error('port is required when mode includes HTTP/SSE');

    const bindHost = opts.bindHost ?? '127.0.0.1';
    const isLoopback = bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
    const requireAuth = opts.requireAuthWhenNonLocal !== false;
    if (!isLoopback && requireAuth && !opts.authConfigured) {
      throw new Error(
        'stavr daemon refusing to bind non-local without auth configured. ' +
          'Run `stavr pair bootstrap` first or set `network.require_auth_when_non_local: false` ' +
          "if you know what you're doing.",
      );
    }

    const app = express();
    app.use(express.json({ limit: '4mb' }));

    // BOM diagnostics 2026 C1.6 — every HTTP request runs inside an
    // AsyncLocalStorage scope stamped with a correlation_id. Clients may pass
    // `x-correlation-id`; otherwise we generate a UUID per request. Anything
    // logged via getLogger() while the request handler is on the stack
    // automatically gets the field attached.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const incoming = req.header('x-correlation-id');
      const cid = incoming && incoming.trim() ? incoming.trim() : randomUUID();
      res.setHeader('x-correlation-id', cid);
      logContext.run({ correlation_id: cid }, () => next());
    });

    // BOM diagnostics 2026 C1.3 — record HTTP request duration histogram.
    // Route labels are normalized (see `normalizeRoute`) to keep cardinality
    // bounded; /metrics itself is excluded so a scrape doesn't pollute the
    // histogram of its own metric.
    //
    // v0.6.11 Phase 3 — same hook also feeds the lightweight in-memory perf
    // reservoir used by /dashboard/api/perf + the perf_sample event.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/metrics') return next();
      const endTimer = stavrHttpRequestDuration.startTimer({ method: req.method });
      const route = normalizeRoute(req.path);
      const t0 = performance.now();
      // BOM Wave 1 — preserve a peek at the JSON-RPC body so the post-finish
      // hook can label the gateway histogram by tool. Express has already
      // parsed body when this fires (json() middleware is mounted earlier).
      const rpcBody = (req.body ?? {}) as { method?: string; params?: { name?: string }; id?: unknown };
      res.on('finish', () => {
        const elapsedMs = performance.now() - t0;
        const elapsedSec = elapsedMs / 1000;
        endTimer({ route, status: String(res.statusCode) });
        try {
          recordPerf(`http:${req.method} ${route}`, elapsedMs, res.statusCode < 500);
        } catch { /* metrics never fail the request */ }
        try {
          // BOM Wave 0 — feed gateway SLOs. Availability: any non-5xx counts.
          // Latency: elapsed within the configured threshold counts.
          recordSloSample('gateway_availability', res.statusCode < 500);
          const fast = elapsedSec <= (SLO_DEFS.gateway_latency_p95.latencyThresholdSeconds ?? 0.5);
          recordSloSample('gateway_latency_p95', fast);
        } catch { /* metrics never fail the request */ }
        try {
          // BOM Wave 1 — mcp.gateway.* dual-emit. Scope to the /mcp route;
          // other HTTP routes (dashboard, /healthz, debug) are NOT MCP
          // gateway traffic and should not pollute the L5 histogram.
          if (req.path === '/mcp') {
            const success = res.statusCode < 400;
            recordGatewayRequest({
              upstream: 'self',
              method: typeof rpcBody.method === 'string' ? rpcBody.method : undefined,
              toolName: typeof rpcBody.params?.name === 'string' ? rpcBody.params.name : undefined,
              durationSeconds: elapsedSec,
              success,
              errorType:
                !success
                  ? res.statusCode >= 500
                    ? 'internal'
                    : res.statusCode === 401 || res.statusCode === 403
                      ? 'auth'
                      : res.statusCode === 408 || res.statusCode === 504
                        ? 'timeout'
                        : 'protocol'
                  : undefined,
            });
            if (!success) {
              // Use JSON-RPC error-code shape when we can — HTTP 4xx ≈ -326xx range.
              recordJsonRpcError(res.statusCode >= 500 ? -32603 : -32600);
            }
          }
        } catch { /* metrics never fail the request */ }
      });
      next();
    });

    // BOM diagnostics 2026 C1.4 — Prometheus scrape endpoint. Returns the
    // process-wide registry's text serialization. Mounted before /healthz so
    // a scraper hammering it doesn't get blocked by other middleware order.
    app.get('/metrics', async (_req: Request, res: Response) => {
      try {
        res.setHeader('content-type', metricsRegistry.contentType);
        res.end(await metricsRegistry.metrics());
      } catch (err) {
        res.status(500).end((err as Error).message);
      }
    });

    const daemonStartedAt = new Date();
    // Bombardment Phase 0 — version is baked at build time from
    // package.json#version (see scripts/generate-version.mjs). Recon
    // defect #5: pre-fix, /status reported '0.1.0' on every launch
    // path because STAVR_VERSION was never populated. The build-time
    // bake works in the SEA / sidecar / Windows Service where a
    // runtime package.json read would not.
    const version = STAVR_VERSION;
    const now = opts.now ?? Date.now;

    // Deep health endpoint (spec 44 §3). Anything that flips `ok` to false makes
    // the response 503 so the watchdog (ADR-020) catches it and restarts us.
    app.get('/healthz', (_req, res) => {
      const dbReachable = broker.store.isReachable();
      const dbWritable = dbReachable && broker.store.isWritable();
      const reasons: string[] = [];
      if (!dbReachable) reasons.push('db_unreachable');
      else if (!dbWritable) reasons.push('db_readonly');

      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const ok = reasons.length === 0;
      const body = {
        ok,
        version,
        started_at: daemonStartedAt.toISOString(),
        uptime_sec: Math.floor((Date.now() - daemonStartedAt.getTime()) / 1000),
        db: {
          reachable: dbReachable,
          writable: dbWritable,
        },
        broker: {
          connected_sessions: sseSessions.size,
          active_subscriptions: broker.subscriptionCount(),
        },
        decisions: {
          open_count: dbReachable ? broker.store.pendingDecisionCount() : 0,
          responded_last_hour: dbReachable ? broker.store.decisionsRespondedSince(oneHourAgo) : 0,
        },
        ...(reasons.length ? { reasons } : {}),
      };
      res.status(ok ? 200 : 503).json(body);
    });

    // governor-polish Cluster C — Governor heartbeat sink. The Governor
    // POSTs every ~10 s; we record the latest payload in an in-memory
    // store that the Diagnostics fetcher reads via `heartbeatStore.current()`.
    //
    // Security posture (this is the ONLY new attack surface in the
    // governor-polish BOM):
    //   - Loopback-only. Non-loopback callers get 403 regardless of
    //     bearer state — the heartbeat carries no privilege, but the
    //     route is local-by-construction so it never becomes remotely
    //     reachable.
    //   - 1 KB body cap (express.json's 4 MB limit is fine for the rest
    //     of the daemon but absurd here). Enforced via a dedicated
    //     json parser on this route only.
    //   - Strict schema via `validateHeartbeatBody` — rejects unknown
    //     fields, oversized strings, signing values outside the enum.
    app.post('/governor/heartbeat', (req: Request, res: Response) => {
      if (!isLoopbackRequest(req)) {
        res.status(403).json({ ok: false, error: 'loopback only' });
        return;
      }
      // 1 KB cap — the global express.json() body parser is mounted with
      // a 4 MB limit (fine for /mcp), so the per-route parser middleware
      // pattern would be a no-op here. Check content-length explicitly.
      const lenHeader = req.header('content-length');
      const len = lenHeader ? Number.parseInt(lenHeader, 10) : 0;
      if (Number.isFinite(len) && len > 1024) {
        res.status(413).json({ ok: false, error: 'body too large (max 1 KB)' });
        return;
      }
      const verdict = validateHeartbeatBody(req.body);
      if (!verdict.ok) {
        res.status(400).json({ ok: false, error: verdict.error });
        return;
      }
      heartbeatStore.record(verdict.value);
      res.status(204).end();
    });

    // ---- Spec 52 A2 — pairing endpoints (public for /pair/complete) ----

    // Loopback-only: opens a pairing window and returns the 6-digit code. The
    // bootstrap operator runs `stavr pair bootstrap` on the daemon machine,
    // which calls this. Non-loopback callers get 403 — the code goes back to
    // the operator who is standing in front of the daemon, never to the wire.
    app.post('/pair/initiate', (req: Request, res: Response) => {
      if (!isLoopbackRequest(req)) {
        res.status(403).json({ ok: false, error: 'loopback only' });
        return;
      }
      const pairing = pairingRegistry.open(now());
      res.json({
        ok: true,
        code: pairing.code,
        expires_at: new Date(pairing.expires_at).toISOString(),
      });
    });

    // Public: the new device exchanges the 6-digit code for a UUID-shaped
    // token. The raw token is returned exactly once; the daemon stores only
    // SHA256(token) in the devices table. Generic 'invalid_code' on every
    // failure path so the response doesn't leak which slot exists.
    app.post('/pair/complete', async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { code?: string; device_name?: string };
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
      if (!code || !deviceName) {
        res.status(400).json({ ok: false, error: 'code and device_name required' });
        return;
      }
      const matched = pairingRegistry.consume(code, now());
      if (!matched) {
        res.status(401).json({ ok: false, error: 'invalid_code' });
        return;
      }
      const token = generateDeviceToken();
      const tokenHash = hashToken(token);
      const deviceId = randomUUID();
      const pairedAt = new Date().toISOString();
      const pairedFromIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || 'unknown';
      broker.store.insertDevice({
        id: deviceId,
        name: deviceName,
        paired_at: pairedAt,
        paired_from_ip: pairedFromIp,
        token_hash: tokenHash,
      });
      await broker.publish({
        kind: 'device_paired',
        at: pairedAt,
        source_agent: 'stavr-daemon',
        payload: { device_id: deviceId, device_name: deviceName, paired_from_ip: pairedFromIp },
      });
      res.json({
        ok: true,
        device_id: deviceId,
        device_name: deviceName,
        paired_at: pairedAt,
        token,
      });
    });

    // ---- Auth middleware (spec 52 A2) ----
    // Once at least one device is paired and the bind is non-loopback, every
    // non-public request must carry a valid Bearer token. Loopback requests
    // are exempt — the kernel enforces local-only access (ADR-006). The actual
    // decision lives in the pure `checkBearerAuth()` (testable independently).
    const requireBearer = !!opts.authConfigured && !isLoopback;
    if (requireBearer) {
      app.use((req: Request, res: Response, next: NextFunction) => {
        const verdict = checkBearerAuth({
          path: req.path,
          isLoopbackReq: isLoopbackRequest(req),
          authHeader: req.header('authorization'),
          findActiveDevice: (h) => {
            const r = broker.store.findActiveDeviceByTokenHash(h);
            return r ? { id: r.id, name: r.name } : undefined;
          },
        });
        if (!verdict.ok) {
          res.status(verdict.status).json({ ok: false, error: verdict.error });
          return;
        }
        if (verdict.device) {
          (req as Request & { device?: { id: string; name: string } }).device = verdict.device;
        }
        next();
      });
    }

    // family-mode-phase-1 Phase 4.5 — verified actor_id stamping for all
    // HTTP routes. Runs AFTER bearer-auth so `req.device` (if set) is the
    // verified paired-peer identity. The existing per-route nesting of
    // logContext.run is preserved — this middleware adds the actor_id
    // field to the current store (correlation_id already set above), then
    // chains to next(). Downstream handlers (the /mcp dispatch wrapper,
    // the /dashboard/.../respond endpoint, etc.) read logContext.actor_id
    // and trust it because it was set HERE, not by any caller-supplied
    // string. Loopback signal is the kernel-enforced ADR-006 boundary —
    // a peer cannot fake `loopback:*` because it cannot connect from the
    // loopback interface.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const reqDevice = (req as Request & { device?: { id: string; name: string } }).device;
      const corrId = (res.getHeader('x-correlation-id') as string | undefined) ?? '';
      const actorId = reqDevice
        ? `peer:${reqDevice.name}`
        : isLoopbackRequest(req)
          ? `loopback:${corrId}`
          : 'unknown';
      const existing = logContext.getStore() ?? {};
      logContext.run({ ...existing, actor_id: actorId }, () => next());
    });

    // family-mode-phase-1 Phase 5 — loopback-only fence for operator-data
    // routes. /dashboard/* and /events/sse expose the operator's audit
    // tail and internal state; a paired peer HAS a valid bearer token (so
    // the auth gate above lets it through) but has no legitimate need to
    // read the operator's audit log. The fence is structural: regardless
    // of bearer state, non-loopback callers get 403 on these paths.
    //
    // The /dashboard/decisions/:id/respond endpoint is mayRespond-protected
    // already (a peer caller gets operator_required), so it's structurally
    // safe — but the READ endpoints under /dashboard/ are not, hence this
    // dedicated fence. The /dashboard/.../respond write is reachable via
    // mayRespond's verified-loopback check from a loopback caller; this
    // fence keeps it consistent at the path level too.
    //
    // Remote operator dashboard access is a future extension (would land
    // as additional mayRespond cases + a separate auth path), not Phase 5.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isLoopbackOnlyPath(req.path) && !isLoopbackRequest(req)) {
        res.status(403).json({
          ok: false,
          error: 'loopback_only',
          reason:
            `${req.path} exposes operator audit data and is restricted to ` +
            `loopback callers; remote dashboard access is not a Phase 5 ` +
            `surface`,
        });
        return;
      }
      next();
    });

    app.get('/status', (_req, res) => {
      res.json({
        ok: true,
        version,
        started_at: daemonStartedAt.toISOString(),
        events: broker.store.eventCount(),
        sse_sessions: sseSessions.size,
        pending_decisions: broker.store.pendingDecisionCount(),
      });
    });

    // family-son-mcp Phase 5 Phase 1 — Anthropic-API-compatible gateway stub.
    //
    // BOM proposed/family-son-mcp-phase-5-llm-gateway-bom.md. Phase 1 mounts
    // the route behind the global bearer-auth middleware (line ~494) and the
    // actor-stamping middleware (line ~526) and returns a deterministic 501.
    // No credential forwarding, no chokepoint integration, no metering —
    // those land in Phases 2 / 3 / 4 respectively.
    //
    // The route is intentionally NOT on the /dashboard/* loopback fence
    // (line ~554): the son is by definition non-loopback. The loopback
    // bypass on bearer-auth (checkBearerAuth line ~1397) is accepted per
    // the Phase 0 recon F1 decision; Phase 4 will still emit audit events
    // for loopback gateway traffic so the audit trail isn't blind.
    app.all('/anthropic/v1/messages', (req: Request, res: Response) => {
      if (req.method !== 'POST') {
        res
          .status(405)
          .set('Allow', 'POST')
          .json({
            ok: false,
            error: 'method_not_allowed',
            allowed_methods: ['POST'],
          });
        return;
      }
      const actor = logContext.getStore()?.actor_id ?? 'unknown';
      res.status(501).json({
        ok: false,
        error: 'not_implemented',
        phase: 'phase-1-stub',
        reason:
          'family-son-mcp Phase 5 — endpoint shell only. Credential ' +
          'forwarding lands in Phase 3 after the chokepoint integration ' +
          '(Phase 2) and the operator key-seeding decision (F5).',
        actor,
      });
    });

    // v0.6.x memory-leak fix Phase 3 — live diagnostics surface. Returns
    // process memory + DB page count + broker counters in one JSON shot
    // so the operator (and the dashboard) can spot growth without grep'ing
    // the daemon_memory event tail. Loopback-only (the bind enforces that)
    // and read-only.
    app.get('/dashboard/api/diagnostics/memory', (_req, res) => {
      const mem = process.memoryUsage();
      let dbPageCount: number | null = null;
      let dbPageSize: number | null = null;
      let dbBytes: number | null = null;
      try {
        const raw = broker.store.rawDb;
        const pc = raw.pragma('page_count', { simple: true });
        const ps = raw.pragma('page_size', { simple: true });
        if (typeof pc === 'number') dbPageCount = pc;
        if (typeof ps === 'number') dbPageSize = ps;
        if (dbPageCount !== null && dbPageSize !== null) {
          dbBytes = dbPageCount * dbPageSize;
        }
      } catch {
        /* db not reachable or rawDb closed; leave nulls */
      }
      res.json({
        ok: true,
        at: new Date().toISOString(),
        process: {
          rss: mem.rss,
          heap_total: mem.heapTotal,
          heap_used: mem.heapUsed,
          external: mem.external,
          array_buffers: mem.arrayBuffers,
          uptime_seconds: Math.round(process.uptime()),
        },
        db: {
          page_count: dbPageCount,
          page_size: dbPageSize,
          bytes: dbBytes,
          event_count: (() => {
            try { return broker.store.eventCount(); } catch { return null; }
          })(),
        },
        broker: {
          session_count: broker.sessionCount(),
          subscription_count: broker.subscriptionCount(),
          sse_sessions: sseSessions.size,
        },
        watchdog: {
          rss_threshold_mb: Number.parseInt(process.env.STAVR_RSS_WATCHDOG_MB ?? '4000', 10) || 4000,
        },
      });
    });

    // v0.6.11 Phase 3 — per-endpoint perf snapshot (HTTP routes + MCP
    // methods + SSE broadcast). Same lifecycle + access posture as
    // /dashboard/api/diagnostics/memory: loopback-only, read-only, JSON.
    // Consumed by the Phase 4 diagnostics panel.
    app.get('/dashboard/api/perf', (_req: Request, res: Response) => {
      try {
        res.json(perfSnapshot());
      } catch (err) {
        res.status(500).json({ ok: false, error: (err as Error).message });
      }
    });

    // v0.6.12 Phase 3 — storage snapshot for the engine detail page.
    // Returns runestone.db size + per-table row counts + recent retention
    // sweep events. Loopback-only, read-only. Consumed by the Phase 3
    // Storage panel on /dashboard/diagnostics/engine.
    app.get('/dashboard/api/diagnostics/storage', (_req: Request, res: Response) => {
      try {
        const raw = broker.store.rawDb;
        const pageCount = raw.pragma('page_count', { simple: true });
        const pageSize  = raw.pragma('page_size', { simple: true });
        const bytes = (typeof pageCount === 'number' && typeof pageSize === 'number')
          ? pageCount * pageSize : null;
        const tables: Record<string, number> = {};
        const tableNames = ['events', 'bricks', 'workers', 'boms', 'decisions'];
        for (const name of tableNames) {
          try {
            const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
            tables[name] = row.c;
          } catch {
            // table missing — skip
          }
        }
        // Recent retention sweeps. Each sweep emits a `retention_swept`
        // event with the deletion counts; surface the latest 10.
        let sweeps: Array<{ at: string; deleted: number; window_days: number | null }> = [];
        try {
          const rows = raw.prepare(
            `SELECT at, payload_json FROM events WHERE kind = 'retention_swept' ORDER BY at DESC LIMIT 10`,
          ).all() as Array<{ at: string; payload_json: string | null }>;
          sweeps = rows.map((r) => {
            let deleted = 0;
            let window_days: number | null = null;
            try {
              const p = r.payload_json ? JSON.parse(r.payload_json) : {};
              if (typeof p.deleted_count === 'number') deleted = p.deleted_count;
              else if (typeof p.deleted === 'number') deleted = p.deleted;
              else if (p.totals && typeof p.totals.deleted === 'number') deleted = p.totals.deleted;
              if (typeof p.window_days === 'number') window_days = p.window_days;
            } catch { /* shape-tolerant */ }
            return { at: r.at, deleted, window_days };
          });
        } catch {
          // events table missing in some test fixtures
        }
        res.json({
          ok: true,
          at: new Date().toISOString(),
          db: { page_count: pageCount, page_size: pageSize, bytes, tables },
          retention: { recent_sweeps: sweeps },
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: (err as Error).message });
      }
    });

    // bom-diagnostics-2026 C3 — on-demand diagnostic endpoints
    // (heap-snapshot, cpu-profile, diagnostic-report). All three are
    // loopback-only AND gated by STAVR_DEBUG_ENABLED=1. When the gate is off
    // they return 404 (not 403) so an unauthenticated probe cannot detect
    // their existence. The leak-hunt heap-snapshot endpoint (originally
    // inlined here in PR #15) moved into `observability/debug-endpoints.ts`
    // as part of this rollup.
    mountDebugEndpoints(app, {
      // v0.4 — runtime toggles flippable from Settings → Diagnostics. The
      // env var remains the fallback so headless / pre-DB callers still
      // work.
      readToggle: (key) => broker.store.getRuntimeToggle(key),
      // v0.4 — emit audit events for each /debug/* capture so Settings →
      // Diagnostics can list recent diagnostics from the event log.
      emitEvent: (kind, payload) => {
        void broker.publish({
          kind: kind as never,
          at: new Date().toISOString(),
          source_agent: 'stavr-daemon',
          payload,
        });
      },
    });

    // Spec 50 Layer 1 — usage endpoint. Same auth posture as /dashboard/*
    // (127.0.0.1 only via the binding, no auth header).
    app.get('/usage', async (req, res) => {
      try {
        const windowParam = (req.query.window as string | undefined) ?? '24h';
        const granularityParam = (req.query.granularity as string | undefined) ?? 'hour';
        const allowedWindow = ['1h', '6h', '24h', '7d'] as const;
        const allowedGran = ['minute', 'hour', 'day'] as const;
        const window = (allowedWindow as readonly string[]).includes(windowParam)
          ? (windowParam as ComputeUsageOpts['window'])
          : '24h';
        const granularity = (allowedGran as readonly string[]).includes(granularityParam)
          ? (granularityParam as ComputeUsageOpts['granularity'])
          : 'hour';
        const apiBalance = await fetchAnthropicBalance();
        const usage = computeUsage(broker.store, { window, granularity, apiBalance });
        res.json(usage);
      } catch (err) {
        res.status(500).json({ ok: false, error: (err as Error).message });
      }
    });

    // bom-oom-leak-hunt C2.4 — explicit DELETE /mcp handler. Per the
    // Streamable HTTP spec a well-behaved client sends DELETE with its
    // mcp-session-id header to explicitly terminate. We tear down in this
    // order, synchronously: transport.close (best-effort) → broker
    // subscription removal → sessions Map delete → mcp_session_deleted
    // event. The transport's async `onclose` would normally fire after
    // the spec's DELETE round-trips through handleRequest, which races
    // new sessions when a tab refreshes. Doing it synchronously here
    // closes that window — the leak-hunt recon (#2) flagged that race
    // as a medium-likelihood retainer.
    //
    // Registered BEFORE app.all('/mcp') so Express dispatches DELETE here
    // first and falls through to app.all for non-DELETE methods.
    app.delete('/mcp', (req: Request, res: Response) => {
      const sessionId = req.header('mcp-session-id');
      if (!sessionId) {
        res.status(400).json({ ok: false, error: 'mcp-session-id header required' });
        return;
      }
      const session = sseSessions.get(sessionId);
      if (!session) {
        res.status(404).json({ ok: false, error: 'no such session' });
        return;
      }
      // Best-effort transport teardown. The SDK's close returns a promise
      // but we don't await it — the broker subscription removal + map
      // delete are the leak-relevant steps and must happen synchronously.
      try {
        void session.transport.close?.();
      } catch {
        /* socket already gone; nothing to do */
      }
      broker.removeSession(session.handle.sessionId);
      sseSessions.delete(sessionId);
      refreshSseGauge();
      void broker
        .publish({
          kind: 'mcp_session_deleted',
          at: new Date().toISOString(),
          source_agent: 'stavr-daemon',
          correlation_id: sessionId,
          payload: {
            session_id: sessionId,
            remaining_sessions: sseSessions.size,
            broker_session_count: broker.sessionCount(),
          },
        })
        .catch(() => {
          /* persistence-failed; broker.publish already logs */
        });
      res.status(204).end();
    });

    // MCP Streamable HTTP endpoint. Single route handles POST (client→server
    // messages, including initialization), GET (server→client SSE stream),
    // and DELETE (session termination). The transport closes the SSE stream
    // between requests, so undici's bodyTimeout is never an issue — closes
    // audit major #2 cleanly without client-side dispatcher overrides.
    //
    // DELETE is handled above by the explicit `app.delete('/mcp', …)`
    // handler so the leak-hunt teardown path runs synchronously. Anything
    // that falls through to here is POST (init / messages) or GET (SSE).
    app.all('/mcp', async (req: Request, res: Response) => {
      const incomingSid = req.header('mcp-session-id');
      let session = incomingSid ? sseSessions.get(incomingSid) : undefined;
      let isNew = false;
      try {

      // bom-diagnostics-2026 C2.3 — attach OTel GenAI MCP semconv attributes
      // to the auto-instrumented http server span. Best-effort: when no OTel
      // SDK is configured, getActiveSpan() returns undefined and this is a
      // pure no-op. We decode `method` + `params.name` from the JSON-RPC body
      // when the request shape is the canonical MCP one.
      const body = (req.body ?? {}) as { method?: string; params?: { name?: string } };
      attachMcpAttributes({
        method: typeof body.method === 'string' ? body.method : undefined,
        toolName:
          body.method === 'tools/call' && typeof body.params?.name === 'string'
            ? body.params.name
            : undefined,
        sessionId: incomingSid ?? undefined,
      });

      if (!session) {
        // No existing session — for non-POST requests this is an error.
        if (req.method !== 'POST') {
          res.status(400).json({ ok: false, error: 'Mcp-Session-Id header required for non-POST requests' });
          return;
        }
        // v0.6.x memory-leak fix — reject non-`initialize` POSTs without a
        // session id BEFORE building an McpServer. With
        // `sessionIdGenerator: () => randomUUID()` we operate in MCP stateful
        // mode; the only valid first POST is `initialize`. Cowork's
        // tools/list-without-init polling was creating a fresh McpServer
        // per request just to have the SDK reject it with 400, which the
        // operator observed as ~36 MB/min heap growth. See
        // proposed/v0_6_x-memory-leak-findings.md.
        const rpcMethod = typeof body.method === 'string' ? body.method : undefined;
        if (rpcMethod !== 'initialize') {
          res
            .status(400)
            .json({
              jsonrpc: '2.0',
              error: {
                code: -32600,
                message:
                  'Mcp-Session-Id header required for non-initialize methods (server is in stateful mode)',
              },
              id: (req.body as { id?: unknown } | undefined)?.id ?? null,
            });
          oneshotCleanup.tick();
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Per BOM proposed/mcp-session-stability-bom.md Phase 2a.
          // Without an eventStore, the SDK omits the protocol-version-
          // gated priming event and the per-POST response stream is
          // non-resumable — a connection drop while a long-blocking tool
          // handler (`await_decision`, slow `github_*` writes) is in
          // flight loses the result silently. BoundedEventStore caps
          // per-stream history at 256 events OR 5 min (whichever fires
          // first), evicted on every insert; one store per session,
          // GC'd when the transport closes.
          eventStore: new BoundedEventStore(),
        });
        const handle = createSwitchServer(broker);
        await handle.server.connect(transport);
        // Create the session object BEFORE wiring onclose so the close
        // handler can reference `session.keepalive` and clear it.
        session = { transport, handle, inFlight: new Map<string | number, number>() };
        isNew = true;
        // Phase 3 observability. Wrap onmessage AFTER server.connect()
        // — the SDK set it during connect; we delegate to the SDK handler
        // and just pre-record start_ts for tools/call requests so we can
        // observe handler duration at close. Non-tools/call messages
        // (initialize, list, notifications/*) are passed through untouched.
        const sdkOnMessage = transport.onmessage;
        transport.onmessage = (message, extra) => {
          const m = message as { method?: string; id?: string | number };
          if (m.method === 'tools/call' && m.id !== undefined) {
            session!.inFlight.set(m.id, performance.now());
          }
          sdkOnMessage?.(message, extra);
        };
        // Wrap send() to clear inFlight on SUCCESSFUL response delivery.
        // If sdkSend throws (the "No connection established" failure mode),
        // we deliberately do NOT clear — the entry stays so the eventual
        // onclose sees it and observes the abandoned duration. Replay-
        // delivered responses don't pass through transport.send, so a
        // call that survives via eventStore replay will still appear in
        // the abandoned bucket at close; that's an acceptable upper-bound
        // approximation called out in the metric help text.
        const sdkSend = transport.send.bind(transport);
        transport.send = async (message, options) => {
          await sdkSend(message, options);
          const m = message as { id?: string | number; result?: unknown; error?: unknown };
          if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
            session!.inFlight.delete(m.id);
          }
        };
        transport.onerror = (err) => {
          // SDK throws `No connection established for request ID: X` when
          // the per-POST response stream is gone at send time. Any error
          // matching that pattern is the failure mode this BOM protects.
          const msg = err?.message ?? '';
          if (msg.includes('No connection established') || msg.includes('controller')) {
            recordToolResponseDeliveryFailed('send_error');
          }
        };
        transport.onclose = () => {
          // Phase 3 — anything left in inFlight at close is "abandoned by
          // close": handler ran (or was running), session died, response
          // can no longer be delivered cleanly. Observe duration and count.
          for (const start of session!.inFlight.values()) {
            recordToolResponseDeliveryFailed('abandoned_by_close');
            recordToolHandlerDurationAtClose((performance.now() - start) / 1000);
          }
          session!.inFlight.clear();
          if (session!.keepalive) {
            clearInterval(session!.keepalive);
            session!.keepalive = undefined;
          }
          const tid = transport.sessionId;
          if (tid) sseSessions.delete(tid);
          broker.removeSession(handle.sessionId);
          refreshSseGauge();
          // OOM leak-hunt: proves cleanup is firing. The session count is
          // captured AFTER removal so the value the operator sees in `stavr
          // tail` matches the in-memory state immediately after the close.
          void broker
            .publish({
              kind: 'sse_session_closed',
              at: new Date().toISOString(),
              source_agent: 'stavr-daemon',
              correlation_id: tid ?? handle.sessionId,
              payload: {
                session_id: tid ?? handle.sessionId,
                sse_sessions_size: sseSessions.size,
                broker_session_count: broker.sessionCount(),
              },
            })
            .catch(() => {
              /* persistence-failed; broker.publish already logs */
            });

          // bom-oom-leak-hunt C2.4 — defensive timeout. If the session is
          // still in either map 30s after onclose, the cleanup raced (or
          // missed). Force-remove and emit sse_session_force_removed so the
          // operator sees it in the event tail; the dashboard surfaces it
          // as a yellow warning. unref'd so it doesn't block shutdown.
          const sweepHandle = setTimeout(() => {
            const stillInMap = tid ? sseSessions.has(tid) : false;
            if (!stillInMap) return;
            sseSessions.delete(tid!);
            broker.removeSession(handle.sessionId);
            refreshSseGauge();
            void broker
              .publish({
                kind: 'sse_session_force_removed',
                at: new Date().toISOString(),
                source_agent: 'stavr-daemon',
                correlation_id: tid ?? handle.sessionId,
                payload: {
                  session_id: tid ?? handle.sessionId,
                  age_ms: 30_000,
                  reason: 'onclose-fired-but-map-entry-remained',
                  sse_sessions_size: sseSessions.size,
                },
              })
              .catch(() => {
                /* persistence-failed; broker.publish already logs */
              });
          }, 30_000);
          sweepHandle.unref?.();
        };
      }

      // Phase 4.5 — actor_id was stamped by the global middleware above,
      // so the chokepoint gate's `logContext.getStore()?.actor_id` is
      // available inside transport.handleRequest without per-route
      // re-wrapping. The Phase 2 inline wrap is gone — the lift to a
      // general middleware also covers the /dashboard/.../respond path
      // that Phase 4.5's mayRespond depends on.
      await session!.transport.handleRequest(req, res, req.body);

      // After handleRequest, sessionId is populated on the first POST.
      // Register so subsequent requests find the same session.
      if (isNew && session.transport.sessionId) {
        sseSessions.set(session.transport.sessionId, session);
        refreshSseGauge();
        log(`MCP session ${session.transport.sessionId} connected`);
        // Per BOM Phase 2b. The Phase 0 cadence findings classified the
        // ~15-min recycle as a wall-clock client timer, so this heartbeat
        // is NOT the load-bearing fix for that. Its job is the orthogonal
        // threat: a TCP/proxy idle close on the standalone GET control
        // stream. A spec-clean server-initiated `notifications/message`
        // every 20s keeps that stream warm. Per-POST response streams
        // are protected by Phase 2a's resumable eventStore. The SDK
        // exposes no hook for raw SSE comments, so this is the cheapest
        // protocol-compliant keepalive available; spike doc:
        // proposed/mcp-session-stability-bom.md Phase 2b.
        const keepaliveHandle = setInterval(() => {
          void session!.transport
            .send({
              jsonrpc: '2.0',
              method: 'notifications/message',
              params: { level: 'debug', logger: 'stavr-keepalive', data: { at: Date.now() } },
            })
            .catch(() => {
              /* stream gone; onclose will tear the interval down */
            });
        }, keepaliveIntervalMs);
        keepaliveHandle.unref?.();
        session.keepalive = keepaliveHandle;
        // OOM leak-hunt: paired with `sse_session_closed` below. The count
        // INCLUDES the just-registered session so it reflects the live map.
        void broker
          .publish({
            kind: 'sse_session_opened',
            at: new Date().toISOString(),
            source_agent: 'stavr-daemon',
            correlation_id: session.transport.sessionId,
            payload: {
              session_id: session.transport.sessionId,
              sse_sessions_size: sseSessions.size,
              broker_session_count: broker.sessionCount(),
            },
          })
          .catch(() => {
            /* persistence-failed; broker.publish already logs */
          });
      } else if (isNew) {
        // v0.6.x memory-leak fix — stateless one-shot (no initialize) or
        // SDK-rejected request: the transport never adopted a session id,
        // so it's not in sseSessions and `transport.onclose` will never
        // fire. We must release the per-request McpServer + transport
        // explicitly or broker.subscribers retains the entire object
        // graph (and the connected transport with its internal Maps)
        // forever. See proposed/v0_6_x-memory-leak-findings.md.
        broker.removeSession(session.handle.sessionId);
        try {
          await session.transport.close?.();
        } catch {
          /* socket likely already gone */
        }
        refreshSseGauge();
        oneshotCleanup.tick();
      }
      } catch (err) {
        // A throw during session setup or handleRequest leaves a half-built
        // session that nothing will ever clean up — the transport's `onclose`
        // only fires for sessions that fully connected. Tear it down here so a
        // failed init cannot leak an McpServer + transport object graph, which
        // is exactly the v0.6.x heap-growth failure mode.
        log(`/mcp handler error: ${(err as Error).message}`);
        if (isNew && session) {
          const tid = session.transport.sessionId;
          if (tid) sseSessions.delete(tid);
          broker.removeSession(session.handle.sessionId);
          try {
            await session.transport.close?.();
          } catch {
            /* socket likely already gone */
          }
          refreshSseGauge();
        }
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: (req.body as { id?: unknown } | undefined)?.id ?? null,
          });
        }
      }
    });

    // Raw SSE event stream for `stavr tail` and programmatic consumers.
    // Supports ?since_id=<event-id>, ?since_at=<ISO>, ?kind=a,b,c, ?source_agent=<name>.
    app.get('/events/sse', (req: Request, res: Response) => {
      const sinceId = req.query.since_id ? String(req.query.since_id) : undefined;
      const sinceAt = req.query.since_at ? String(req.query.since_at) : undefined;
      const kinds = req.query.kind ? String(req.query.kind).split(',') : undefined;
      const sourceAgent = req.query.source_agent ? String(req.query.source_agent) : undefined;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':ok\n\n');
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* socket gone */ }
        }
      }, 25_000);
      heartbeat.unref?.();

      const kindSet = kinds && !kinds.includes('*') ? new Set(kinds) : null;
      const shouldSend = (ev: StoredEvent): boolean => {
        if (kindSet && !kindSet.has(ev.kind)) return false;
        if (sourceAgent && ev.source_agent !== sourceAgent) return false;
        return true;
      };

      const send = (ev: StoredEvent): void => {
        if (!shouldSend(ev)) return;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      };

      // Replay historical events before subscribing to live ones
      const filter: Parameters<typeof broker.store.getEvents>[0] = {};
      if (sinceId) filter.sinceEventId = sinceId;
      else if (sinceAt) filter.sinceAt = sinceAt;
      if (kindSet) filter.kinds = [...kindSet];
      if (sourceAgent) filter.sourceAgent = sourceAgent;
      const { events: historical } = broker.store.getEvents(filter);
      for (const ev of historical) send(ev);

      // Subscribe to live events
      const off = broker.onRawEvent(send);
      req.on('close', () => { off(); clearInterval(heartbeat); });
    });

    // Spec 49 / Stream C C1 — loopback-only event injection. The
    // `stavr steward bug-fix` CLI uses this to emit trust_scope_proposed
    // and trust_scope_granted events through the broker (so subscribers see
    // them in the dashboard event tail and the audit log). The endpoint is
    // strictly local — it lets any caller on this machine publish arbitrary
    // events, which is fine when the bind is 127.0.0.1 and the kernel
    // gates non-local access, but would be unsafe otherwise. We refuse
    // non-loopback callers explicitly.
    app.post('/internal/emit', async (req: Request, res: Response) => {
      const ra = req.socket.remoteAddress ?? '';
      const ip = ra.replace(/^::ffff:/, '');
      const isLoop = ip === '127.0.0.1' || ip === '::1' || ip === '';
      if (!isLoop) {
        res.status(403).json({ ok: false, error: 'loopback only' });
        return;
      }
      const body = (req.body ?? {}) as {
        kind?: string;
        at?: string;
        source_agent?: string;
        correlation_id?: string;
        payload?: unknown;
      };
      if (!body.kind || typeof body.kind !== 'string') {
        res.status(400).json({ ok: false, error: 'kind required' });
        return;
      }
      if (!body.source_agent || typeof body.source_agent !== 'string') {
        res.status(400).json({ ok: false, error: 'source_agent required' });
        return;
      }
      try {
        await broker.publish({
          kind: body.kind as Parameters<typeof broker.publish>[0]['kind'],
          at: body.at ?? new Date().toISOString(),
          source_agent: body.source_agent,
          correlation_id: body.correlation_id,
          payload: body.payload,
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ ok: false, error: (err as Error).message });
      }
    });

    // v0.4 — refresh the Ollama model list every 60s in the background.
    // The Capabilities page reads from this snapshot synchronously so the
    // page render never blocks on the local Ollama daemon being reachable.
    let ollamaModelsCache: string[] = [];
    const refreshOllamaModels = async (): Promise<void> => {
      try {
        const { getOllamaProvider } = await import('./daemon.js');
        const models = await getOllamaProvider().listAvailableModels();
        ollamaModelsCache = models;
      } catch {
        ollamaModelsCache = [];
      }
    };
    void refreshOllamaModels();
    const ollamaRefreshHandle = setInterval(() => void refreshOllamaModels(), 60_000);
    ollamaRefreshHandle.unref?.();

    mountDashboardRoutes(app, broker, {
      port: opts.port,
      startedAt: daemonStartedAt,
      version,
      sseSessions,
      ollamaModels: () => ollamaModelsCache,
    });

    // v0.7 Phase 1 — operator passkey ceremony endpoints under /api/auth/*.
    // The coordinator and identity store are broker-scoped, so re-fetching
    // them per-request is essentially free.
    mountWebAuthnRoutes(app, {
      getCoordinator: () => getOrCreateWebAuthnCoordinator(broker),
      getIdentityStore: () => getOrCreateIdentityStore(broker),
      getBroker: () => broker,
    });

    // v0.7 Phase 2-trimmed — federation HTTP surface under /api/federation/*.
    // The subsystem itself (mDNS + ping loop) is started after the HTTP
    // listener binds — see the .listen() block below.
    const federation = getOrCreateFederation(broker);
    mountFederationRoutes(app, {
      getRegistry: () => federation.registry,
      selfId: () => federation.selfId(),
      daemonVersion: version,
      startedAt: daemonStartedAt,
    });

    // bom-oom-leak-hunt C2.4 — periodic SSE session janitor. Every 5 min,
    // walk sseSessions and remove any entry whose underlying transport
    // reports closed. Prevents long-tail leaks where onclose never fired
    // (e.g. socket dropped without TCP RST + 30s sweep also missed).
    // unref'd so it doesn't keep the event loop alive on shutdown.
    const janitorHandle = setInterval(() => {
      let removed = 0;
      for (const [sid, sess] of sseSessions.entries()) {
        // The SDK transport doesn't expose a `closed` boolean directly;
        // we rely on the fact that handleRequest sets `sessionId`
        // populated only after a successful negotiation, and that
        // sessions whose underlying socket is gone will have already
        // triggered onclose. The conservative check: if the entry is
        // older than the janitor interval and the socket-layer res is
        // missing/closed, remove it.
        const t = sess.transport as unknown as { _writable?: { destroyed?: boolean } };
        if (t?._writable?.destroyed) {
          // Mirror the onclose accounting: a janitor force-remove is a
          // session close that happens to skip onclose, so any in-flight
          // calls at this moment are still "abandoned by close".
          for (const start of sess.inFlight.values()) {
            recordToolResponseDeliveryFailed('abandoned_by_close');
            recordToolHandlerDurationAtClose((performance.now() - start) / 1000);
          }
          sess.inFlight.clear();
          if (sess.keepalive) {
            clearInterval(sess.keepalive);
            sess.keepalive = undefined;
          }
          sseSessions.delete(sid);
          broker.removeSession(sess.handle.sessionId);
          refreshSseGauge();
          removed++;
          void broker
            .publish({
              kind: 'sse_session_force_removed',
              at: new Date().toISOString(),
              source_agent: 'stavr-daemon',
              correlation_id: sid,
              payload: {
                session_id: sid,
                age_ms: -1,
                reason: 'janitor-found-destroyed-socket',
                sse_sessions_size: sseSessions.size,
              },
            })
            .catch(() => {
              /* persistence-failed */
            });
        }
      }
      if (removed > 0) log(`SSE janitor force-removed ${removed} session(s)`);
    }, 5 * 60_000);
    janitorHandle.unref?.();
    sessionJanitorHandle = janitorHandle;

    httpServer = await new Promise<HttpServer | undefined>((resolve, reject) => {
      const s = app.listen(opts.port!, bindHost, () => {
        // bonjour-service (mDNS) rejects port 0; when opts.port was 0 (tests
        // use the ephemeral-port path), read the actual bound port from
        // s.address() instead of forwarding the literal 0 into federation.
        const addr = s.address();
        const boundPort =
          addr && typeof addr === 'object' ? addr.port : (opts.port ?? 0);
        log(`HTTP/SSE listening on ${bindHost}:${boundPort}`);
        // v0.7 Phase 2-trimmed — start federation subsystem now that the HTTP
        // surface other peers will dial is actually up. mDNS errors are
        // non-fatal; federation degrades to peers.yaml-only when multicast
        // is blocked or unavailable (Docker, Hyper-V container, etc.).
        federation
          .start({ port: boundPort, startedAt: daemonStartedAt })
          .catch((err) => {
            log(`federation start failed: ${(err as Error).message}; continuing without it`);
          });
        resolve(s);
      });
      s.on('error', (err: NodeJS.ErrnoException) => {
        if (mode === 'daemon') {
          // Daemon mode: bind failure is fatal — there's nothing else for us to do.
          reject(err);
          return;
        }
        // 'both' mode: legacy `stavr start` behaviour — degrade to stdio-only.
        if (err.code === 'EADDRINUSE') {
          log(
            `port ${opts.port} already in use; continuing with stdio-only ` +
              `(another Switch instance is probably holding it — this is expected when ` +
              `Cowork spawns multiple MCP sessions)`,
          );
        } else {
          log(`HTTP/SSE failed to start: ${err.message}; continuing with stdio-only`);
        }
        resolve(undefined);
      });
    });
  }

  const shutdown = async () => {
    if (sessionJanitorHandle) clearInterval(sessionJanitorHandle);
    try {
      // Federation subsystem is broker-scoped via WeakMap; re-resolving
      // here is cheap and avoids needing to lift the local binding from
      // the HTTP-mount block.
      getOrCreateFederation(broker).stop();
    } catch {
      /* federation teardown best-effort; mDNS sockets close on process exit anyway */
    }
    // Close MCP transports BEFORE the HTTP server. `httpServer.close()` waits
    // for in-flight connections to drain; an open SSE stream never drains on
    // its own, so closing the server first hangs shutdown indefinitely. Close
    // the transports (which ends their streams), force any stragglers, then
    // close the listener.
    for (const s of sseSessions.values()) await s.transport.close().catch(() => {});
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise<void>((r) => httpServer!.close(() => r()));
    }
    broker.store.close();
  };

  return {
    httpServer,
    shutdown,
    sseSessionCount: () => sseSessions.size,
    pairingRegistry,
  };
}

/**
 * family-mode-phase-1 Phase 5 — paths that expose operator audit data
 * and must refuse non-loopback callers regardless of bearer state. The
 * /dashboard/* prefix covers every dashboard read endpoint + the
 * dashboard API (memory / perf / storage diagnostics + history feeds);
 * /events/sse is the raw event-tail stream consumed by `stavr tail` and
 * the dashboard's live updates. Exported so the integration test in
 * tests/federation/phase5-bind-and-fence.test.ts can verify the
 * predicate without booting a server.
 */
export function isLoopbackOnlyPath(path: string): boolean {
  return path === '/dashboard' ||
    path.startsWith('/dashboard/') ||
    path === '/events/sse';
}

/**
 * Spec 52 A2 — true iff the request socket connected from a loopback address.
 * Accounts for IPv6-mapped IPv4 (`::ffff:127.0.0.1`).
 */
export function isLoopbackRequest(req: Request): boolean {
  const raw = req.socket.remoteAddress ?? '';
  const ip = raw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

/** Extract the bearer token from `Authorization: Bearer <token>`. Returns undefined if malformed. */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : undefined;
}

/**
 * Spec 52 A2 — pure auth-gate decision. Used by the HTTP middleware and unit
 * tests. Allows when public path / loopback / valid token; refuses otherwise.
 * `findActiveDevice` is the small shim the caller supplies — production code
 * passes `(hash) => broker.store.findActiveDeviceByTokenHash(hash)`.
 */
export function checkBearerAuth(args: {
  path: string;
  isLoopbackReq: boolean;
  authHeader: string | undefined;
  findActiveDevice: (tokenHash: string) => { id: string; name: string } | undefined;
}): { ok: true; device?: { id: string; name: string } } | { ok: false; status: number; error: string } {
  // Public allow-list bypasses auth regardless.
  if (args.path === '/healthz' || args.path === '/pair/complete' || args.path === '/pair/initiate') {
    return { ok: true };
  }
  // Loopback callers always allowed — the kernel boundary already gates them.
  if (args.isLoopbackReq) return { ok: true };

  const presented = parseBearerToken(args.authHeader);
  if (!presented) {
    return { ok: false, status: 401, error: 'missing_or_invalid_authorization' };
  }
  const presentedHash = hashToken(presented);
  const device = args.findActiveDevice(presentedHash);
  if (!device) return { ok: false, status: 401, error: 'invalid_token' };
  return { ok: true, device };
}

interface DashboardCtx {
  port: number;
  startedAt: Date;
  version: string;
  sseSessions: Map<string, { transport: StreamableHTTPServerTransport; handle: ReturnType<typeof createSwitchServer> }>;
  /** v0.4 — optional snapshot getter for the Ollama models list. Wired
   *  to the daemon's lazy provider via `getOllamaProvider().listAvailableModels()`
   *  refreshed every ~60s. */
  ollamaModels?: () => string[];
}

/**
 * Spec 40 Phase 3 — audit dashboard. Mounts a local-only set of read endpoints
 * plus one decision-respond write and one live SSE stream. All routes live
 * under `/dashboard*` so the MCP transport above is untouched.
 *
 * Security model: bind is already `127.0.0.1` only (no CORS, no auth) — the
 * dashboard is an oversight surface for the human running the daemon, not a
 * multi-tenant service. See ADR-006.
 */
export function mountDashboardRoutes(
  app: ReturnType<typeof express>,
  broker: Broker,
  ctx: DashboardCtx,
): void {
  const trustStore = getOrCreateTrustStore(broker);

  // bom-oom-leak-hunt C2.2 — memoize hot dashboard data builders. Home is
  // hit by /dashboard/home/data every 5s from the page poll; Workers reads
  // up to 100 events per render and joins them against the workers table.
  // Both were per-call leaky in the 2026-05-15 OOM. TTL is configurable via
  // STAVR_DASHBOARD_CACHE_MS (default 2000ms).
  const dashboardCacheMs = resolveDashboardCacheMs(2000);
  const workersMaxEvents = resolveWorkersMaxEvents(100);

  // v0.3 dashboard Home aggregator — shared by the server-side initial
  // paint and the JSON endpoint that drives live refresh. The memoized
  // accessor `homeData` is what callers below use; `homeDataRaw` is the
  // expensive builder.
  function homeDataRaw() {
    const active = trustStore.list({ status: 'active' });
    const recentBoms = broker.store.listBoms({ limit: 3 });
    const allDecisions = broker.store.listRecentDecisions(50);
    const openDecisions = allDecisions.filter((d) => d.status === 'open');
    return {
      health: {
        ok: true,
        version: ctx.version,
        port: ctx.port,
        started_at: ctx.startedAt.toISOString(),
        uptime_sec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
        connected_clients: ctx.sseSessions.size,
        event_count: broker.store.eventCount(),
        active_scopes: active.length,
        profile_mode: broker.store.getActiveProfileMode(),
      },
      boms: {
        recent: recentBoms,
        total: broker.store.listBoms().length,
        open: broker.store.listBoms({ status: 'proposed' }).length,
      },
      decisions: {
        recent: allDecisions.slice(0, 5),
        open: openDecisions.length,
      },
    };
  }

  // Plans page snapshot — full list of BOMs plus per-status totals so
  // the toolbar chips can show counts on first paint without a second
  // round-trip. Shared with the JSON endpoint downstream.
  function plansData() {
    const boms = broker.store.listBoms();
    const totals = {
      proposed: 0, approved: 0, running: 0, done: 0,
      failed: 0, cancelled: 0, rejected: 0,
    } as Record<typeof boms[number]['status'], number>;
    for (const b of boms) totals[b.status]++;
    // v0.6.10 Task 2 — in-flight BOMs sidebar lifted from Topology to
    // Plans. Carry both the BOM list and the scopes referenced by them
    // so the side panel can render scope-group headers without a second
    // store query.
    const inFlightBoms = boms.filter(
      (b) => b.status === 'approved' || b.status === 'running' || b.status === 'proposed',
    );
    const active = trustStore.list({ status: 'active' });
    const scopes = active.map((s) => ({
      id: s.id,
      title: s.title,
      expires_at: s.expires_at,
      actions_executed: s.actions_executed,
      expires_after_actions: s.expires_after_actions,
    }));
    return { boms, totals, inFlightBoms, scopes };
  }

  // Decide page snapshot — open decisions for action, plus the most
  // recently resolved (last 24h) so the operator sees their own
  // history. Context per decision is loaded lazily by the client.
  function decideData() {
    const all = broker.store.listRecentDecisions(100);
    const open = all.filter((d) => d.status === 'open');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const resolved = all
      .filter((d) => d.status !== 'open')
      .filter((d) => {
        const at = d.responded_at ? Date.parse(d.responded_at) : Date.parse(d.requested_at);
        return Number.isFinite(at) ? at >= cutoff : true;
      })
      .slice(0, 20);
    return { open, resolved };
  }

  // v0.3 dashboard shell — /dashboard redirects to /dashboard/home; per-page
  // routes (home, topology, workers, plans, decide, toolkit, capabilities,
  // settings) render the shared shell. Must run BEFORE any /dashboard/<page>/*
  // JSON endpoints so Express dispatches the page route for bare GETs.
  // Topology page snapshot — current workers + installed bricks + in-flight
  // BOMs grouped by trust scope. Lightweight; the page reloads on relevant
  // SSE events rather than tracking deltas.
  function topologyData() {
    const workers = broker.store.listWorkers();
    const installed = broker.store.listInstalledBricks();
    const bricks = installed.map((b) => ({
      id: b.id,
      kind: b.kind,
      display_name: b.display_name,
      enabled: b.enabled,
    }));
    const allBoms = broker.store.listBoms();
    const inFlightBoms = allBoms.filter((b) =>
      b.status === 'approved' || b.status === 'running' || b.status === 'proposed',
    );
    const active = trustStore.list({ status: 'active' });
    const scopes = active.map((s) => ({
      id: s.id,
      title: s.title,
      expires_at: s.expires_at,
      actions_executed: s.actions_executed,
      expires_after_actions: s.expires_after_actions,
    }));
    // v0.6.10 Task 1 — MCP-category nodes (registry-derived) + peers
    // (peers.yaml). Task 3 — heatmap timeline buckets from the event
    // store. Task 4a — actor-nodes from source_agent + peers. Pulled
    // together so the topology snapshot stays a single round-trip
    // from the dashboard.
    const { mcpCategoryNodes, peers, eventDensity, actorNodes } = fetchTopologyExtras({
      registry: getOrCreateToolRegistry(broker),
      store: broker.store,
    });
    // v0.6.10 Task 5 — permissions snapshot for the side-drawer.
    // Reuses the same registry + stores the standalone permissions
    // page consumes; embedded into the page as a JSON blob.
    const permissions = fetchPermissionsData({
      registry: getOrCreateToolRegistry(broker),
      caps: getOrCreateCapabilityOverrideStore(broker),
      perms: getOrCreateActorPermissionStore(broker),
    });
    return {
      workers,
      bricks,
      scopes,
      inFlightBoms,
      port: ctx.port,
      mcpCategoryNodes,
      peers,
      eventDensity,
      actorNodes,
      permissions,
    };
  }

  // Workers page snapshot — workers + last few events per worker.
  // The page caps visible panes at 20 internally; we still hand it the
  // full list so a search match outside the cap can highlight which
  // worker isn't yet visible (future polish).
  //
  // bom-oom-leak-hunt C2.3 — `limit` dropped from 500 to STAVR_WORKERS_MAX_EVENTS
  // (default 100). The recon flagged the 500-per-render allocation as a
  // dominant retainer growth. 100 events × ~300 bytes JSON parse is ~30 kB
  // per render, vs 150 kB with the old cap — manageable even under 5s
  // polling. Operators who want more can bump the env or hit `stavr events`
  // directly.
  // v0.8 — History page initial snapshot. Default range = last 24h,
  // tab = All. Fans out across decisions / scopes / boms (DB) / plans
  // (DB) / host-exec (events) / commits (git log) / notifications.
  // BOM-files (proposed/*.md) + CI runs are NOT fanned out here — they
  // depend on the working tree path and on a future GitHub-Actions
  // cache that doesn't exist yet. The page renders without them at
  // first paint; they appear via the `/dashboard/api/history` XHR
  // endpoint when the operator switches tabs.
  function historyData(): import('./dashboard/pages/history.js').HistoryData {
    const until = new Date().toISOString();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const q = { since, until, limit: 100 };
    const db = broker.store.rawDb;
    // Each fetcher is read-only + bounded; we wrap in try so a schema
    // skew on any single source can't take the page down.
    const pages: import('./dashboard/data/history/types.js').HistoryPage[] = [];
    try { pages.push(fetchDecisionsHistory({ db }, q)); } catch { /* empty */ }
    try { pages.push(fetchScopesHistory({ db }, q)); } catch { /* empty */ }
    try { pages.push(fetchPlansHistory({ db }, q)); } catch { /* empty */ }
    try { pages.push(fetchHostExecHistory({ db }, q)); } catch { /* empty */ }
    try { pages.push(fetchNotificationsHistory({ db }, q)); } catch { /* empty */ }
    const merged = mergeTimeline({ pages }, q);
    return {
      items: merged.items,
      total_estimate: merged.total_estimate,
      range: '24h',
      has_more: merged.next_cursor !== null,
    };
  }

  function workersDataRaw() {
    const workers = broker.store.listWorkers();
    const recent: Record<string, StoredEvent[]> = {};
    if (workers.length > 0) {
      const allRecent = broker.store.getEvents({ limit: workersMaxEvents }).events;
      const idSet = new Set(workers.map((w) => w.id));
      for (const ev of allRecent) {
        const corr = ev.correlation_id;
        const payloadId = (ev.payload as { id?: string } | null | undefined)?.id;
        const targetId = corr && idSet.has(corr)
          ? corr
          : payloadId && idSet.has(payloadId)
          ? payloadId
          : undefined;
        if (!targetId) continue;
        (recent[targetId] ??= []).push(ev);
      }
      for (const id of Object.keys(recent)) {
        recent[id] = recent[id].slice(-8);
      }
    }
    return { workers, recent };
  }

  // Toolkit page snapshot — every registered connector with its
  // configSchema, position, and current status. When v0.2 subsystem
  // isn't wired (legacy or test paths), bricks fall back to the bare
  // installed-brick records minus the live config schema.
  function toolkitData(): import('./dashboard/pages/toolkit.js').ToolkitData {
    const sub = getV02Subsystem(broker);
    const out: import('./dashboard/pages/toolkit.js').ToolkitData = { bricks: [] };
    if (sub) {
      for (const c of sub.connectors.list()) {
        out.bricks.push({
          id: c.id,
          kind: c.kind,
          displayName: c.displayName,
          position: c.position,
          configSchema: c.configSchema(),
          status: c.status(),
        });
      }
    } else {
      for (const b of broker.store.listInstalledBricks()) {
        out.bricks.push({
          id: b.id,
          kind: b.kind,
          displayName: b.display_name,
          position: 'above',
          configSchema: [],
          status: { kind: 'needs_setup', detail: 'subsystem not wired', lastChecked: new Date().toISOString() },
        });
      }
    }
    return out;
  }

  // Capabilities page snapshot — active profile mode (read-only for
  // v0.3) + the DEFAULT_PROFILES routing tables. When the daemon has
  // a custom profile config DB, that overlay can replace the defaults
  // here; v0.3 ships the static defaults so the page shows the canonical
  // mapping operators read in the docs.
  function capabilitiesData(): import('./dashboard/pages/capabilities.js').CapabilitiesData {
    return {
      activeMode: broker.store.getActiveProfileMode(),
      // v0.4 — page-render-time snapshot of available Ollama models. We
      // intentionally don't block on the network here: ctx.ollamaModels
      // is updated by a background refresher (see ctx wiring). When the
      // refresher hasn't run yet, this is [] which gives the matrix a
      // graceful "no local models available" rendering.
      ollamaModels: ctx.ollamaModels?.() ?? [],
    };
  }

  // Settings page snapshot — active profile, full scopes list, no-go
  // list, installed bricks. Read once per page load; writes happen via
  // dedicated POST endpoints below.
  function settingsData(): import('./dashboard/pages/settings.js').SettingsData {
    const all = trustStore.list();
    // v0.4 — runtime toggles + recent diagnostic capture events for the
    // Settings → Diagnostics sub-section.
    const runtimeToggles = broker.store.listRuntimeToggles();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const diagKinds = new Set(['heap_snapshot_taken', 'cpu_profile_taken', 'diagnostic_report_taken']);
    const recentDiagnostics = broker.store
      .getEvents({ limit: 100 })
      .events
      .filter((e) => diagKinds.has(e.kind))
      .filter((e) => {
        const t = Date.parse(e.at);
        return Number.isFinite(t) ? t >= cutoff : true;
      })
      .map((e) => ({ kind: e.kind, at: e.at, payload: (e.payload ?? {}) as Record<string, unknown> }));
    return {
      activeMode: broker.store.getActiveProfileMode(),
      scopes: all.filter((s) => s.status === 'active' || s.status === 'proposed').map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        description: s.description,
        allowed_actions: s.allowed_actions.map((a) => ({
          tool: a.tool,
          param_constraints: a.param_constraints,
        })),
        expires_at: s.expires_at ?? undefined,
        actions_executed: s.actions_executed,
        expires_after_actions: s.expires_after_actions ?? undefined,
      })),
      noGo: broker.store.listNoGoRules(),
      bricks: broker.store.listInstalledBricks().map((b) => ({
        id: b.id,
        kind: b.kind,
        display_name: b.display_name,
        enabled: b.enabled,
      })),
      runtimeToggles,
      recentDiagnostics,
      // v0.6 — channels view. undefined when fabric is disabled (no secret).
      channels: getNotifier(broker) ? loadChannelStatuses(getNotifier(broker)) : undefined,
    };
  }

  // bom-oom-leak-hunt C2.2 — memoized accessors. Workers page is the
  // hotter path (full event scan per render); home is the more frequent
  // path (5s poll). Both wrapped at the same TTL — overrideable via env.
  const homeData = memoize(homeDataRaw, dashboardCacheMs);
  const workersData = memoize(workersDataRaw, Math.max(1, Math.floor(dashboardCacheMs / 2)));

  // v0.4 Helm page — derived from the same underlying state as Home (we want
  // the same memoization to amortise the cost of broker.store reads). The
  // shape is denser (workers row, sys-chips, intent summary).
  function helmDataRaw(): import('./dashboard/pages/helm.js').HelmData {
    const h = homeData();
    // BOM v0.6.6 — derive lifecycle_state for every worker and feed it
    // through to the L2 chip + counter summary. Cap raw scan at 64 (twice
    // the historical 32-chip cap) so the counter math sees enough rows
    // for "lifetime" but render still slices to 6 active chips in helm.ts.
    const allWorkers = broker.store.listWorkers();
    const now = Date.now();
    const counters = fetchWorkerCounters(allWorkers, now);
    const workers = allWorkers.slice(0, 32).map((w) => {
      const lifecycle = deriveLifecycleState(w, now);
      return {
        id: w.id,
        type: w.type,
        status: ((): 'idle' | 'running' | 'crashed' | 'cleanup' => {
          if (w.status === 'running') return 'running';
          if (w.status === 'crashed') return 'crashed';
          if (w.status === 'starting') return 'cleanup';
          return 'idle';
        })(),
        lifecycle_state: lifecycle,
        current_step: undefined,
      };
    });
    const bricks = broker.store.listInstalledBricks();
    const systems = bricks.slice(0, 32).map((b) => ({
      id: b.id,
      label: b.display_name,
      glyph: b.kind === 'mcp' ? '🧩' : b.kind === 'http' ? '🌐' : '⚙️',
      health: (b.enabled ? 'ok' : 'down') as 'ok' | 'degraded' | 'down' | 'unknown',
      detail: `${b.kind} · ${b.enabled ? 'enabled' : 'disabled'}`,
    }));
    const activeBom = h.boms.recent.find((b) => b.status === 'running' || b.status === 'approved');
    const intent = activeBom
      ? { summary: activeBom.goal, sub: `${h.boms.open} open · profile ${h.health.profile_mode}` }
      : { summary: 'Steward is idle.', sub: `profile ${h.health.profile_mode} · ${h.boms.total} total BOMs` };
    // v0.6 — daily digest state from the DigestScheduler. Read-only here;
    // edits go through /dashboard/settings/digest below.
    const sched = getDigestScheduler(broker);
    const digest = sched ? sched.snapshotState() : undefined;
    return {
      intent,
      health: {
        ok: h.health.ok,
        version: h.health.version,
        port: h.health.port,
        started_at: h.health.started_at,
        uptime_sec: h.health.uptime_sec,
        profile_mode: h.health.profile_mode,
        event_count: h.health.event_count,
        active_scopes: h.health.active_scopes,
      },
      boms: h.boms,
      decisions: h.decisions,
      workers,
      worker_counters: {
        active: counters.active,
        completed: counters.completed_clean + counters.completed_error,
        crashed: counters.crashed + counters.killed_by_system,
        killed_by_operator: counters.killed_by_operator,
        stale: counters.stale,
        total: counters.total,
      },
      systems,
      digest,
    };
  }
  const helmData = memoize(helmDataRaw, dashboardCacheMs);

  // v0.4 MCPs page — installed bricks come straight from the brick registry;
  // the static github.com/mcp snapshot lives in the page module itself so
  // it's bundled with the daemon and doesn't require a registry lookup.
  // v0.6.11 Phase 6e (UX audit B3) — Diagnostics Section 3 was reading
  // its workers from `data.workers ?? []` but mountDashboardPages had no
  // diagnosticsData getter wired, so the page always saw an empty list
  // and reported "0 active · 0 lifetime" while Streams + Topology saw
  // the live 16. This getter feeds the same single source of truth
  // (broker.store.listWorkers + listInstalledBricks) all three pages
  // consume so the counts agree.
  function diagnosticsData(): import('./dashboard/pages/diagnostics.js').DiagnosticsData {
    return {
      workers: broker.store.listWorkers(),
      bricks: broker.store.listInstalledBricks().map((b) => ({
        id: b.id,
        display_name: b.display_name,
        kind: b.kind,
        enabled: b.enabled,
      })),
      hostCeiling: fetchHostCeilingData(broker),
      durability: getDurabilitySnapshot(),
    };
  }

  function mcpsData(): import('./dashboard/pages/mcps.js').McpsData {
    return {
      installed: broker.store.listInstalledBricks().map((b) => ({
        id: b.id,
        display_name: b.display_name,
        kind: b.kind,
        enabled: b.enabled,
      })),
    };
  }

  function toolsData(): import('./dashboard/data/tools-data.js').ToolsData {
    // v0.6.9 PR #1 — read the broker's ToolRegistry snapshot.
    // `getOrCreateToolRegistry` ensures the registry exists even if no
    // MCP session has been opened yet; the wrap shim populates it on
    // each `createSwitchServer` call.
    const registry = getOrCreateToolRegistry(broker);
    return fetchToolsData(registry);
  }

  function permissionsData(): import('./dashboard/data/permissions-data.js').PermissionsData {
    // v0.6.9 PR #2 — join the registry catalog with Layer 0 disables
    // (`CapabilityOverrideStore`) and per-actor matrix
    // (`ActorPermissionStore`) for the `/dashboard/permissions` page.
    return fetchPermissionsData({
      registry: getOrCreateToolRegistry(broker),
      caps: getOrCreateCapabilityOverrideStore(broker),
      perms: getOrCreateActorPermissionStore(broker),
    });
  }

  function familyModeData(): import('./dashboard/pages/family-mode.js').FamilyModeData {
    // v0.7 Phase 5 — snapshot the federation subsystem state for the
    // family-mode page's server-side initial paint.
    const fed = getOrCreateFederation(broker);
    return {
      self_id: fed.selfId(),
      peers_yaml_path: process.env['STAVR_HOME']
        ? `${process.env['STAVR_HOME']}/peers.yaml`
        : '~/.stavr/peers.yaml',
      peers: fed.registry.list(),
    };
  }

  mountDashboardPages(app, { helmData, homeData, plansData, decideData, topologyData, workersData, historyData, toolkitData, mcpsData, toolsData, permissionsData, capabilitiesData, settingsData, diagnosticsData, familyModeData });

  // v0.8 — XHR endpoint backing the History page's "Load more" + range
  // re-fetch. Same data sources as historyData() but with caller-supplied
  // range/limit/offset. Read-only — POST/PUT/DELETE return 405.
  //
  // The endpoint returns serialized HTML for each row so the page can
  // `innerHTML +=` without round-tripping the renderer. The full
  // HistoryItem is available via the row's data-* attributes if the
  // page needs to introspect.
  app.get('/dashboard/api/history', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const since = typeof q.since === 'string' ? q.since : undefined;
    const until = typeof q.until === 'string' ? q.until : undefined;
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
    const offset = Math.max(0, Math.min(1000, Number(q.offset) || 0));
    const query = { since, until, limit, offset };
    const db = broker.store.rawDb;
    const pages: import('./dashboard/data/history/types.js').HistoryPage[] = [];
    try { pages.push(fetchDecisionsHistory({ db }, query)); } catch { /* empty */ }
    try { pages.push(fetchScopesHistory({ db }, query)); } catch { /* empty */ }
    try { pages.push(fetchPlansHistory({ db }, query)); } catch { /* empty */ }
    try { pages.push(fetchHostExecHistory({ db }, query)); } catch { /* empty */ }
    try { pages.push(fetchNotificationsHistory({ db }, query)); } catch { /* empty */ }
    const merged = mergeTimeline({ pages }, query);
    res.json({
      items: merged.items.map((item) => ({ ...item, html: renderHistoryRow(item) })),
      next_cursor: merged.next_cursor,
      total_estimate: merged.total_estimate,
    });
  });
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    app[method]('/dashboard/api/history', (_req, res) => {
      res.status(405).json({ error: 'history is read-only' });
    });
  }

  // P3 — per-row detail endpoint backing the side drawer. Same read-only
  // posture; missing rows return 200 with `missing: true` so the drawer
  // can render the BOM-no-longer-on-disk placeholder rather than a 404
  // (BOM Footgun #4).
  app.get('/dashboard/api/history/:kind/:id', (req, res) => {
    const kind = String(req.params.kind || '');
    const id = String(req.params.id || '');
    if (!kind || !id) {
      res.status(400).json({ error: 'kind + id required' });
      return;
    }
    const detail = renderHistoryDetail(kind, id, {
      db: broker.store.rawDb,
      bomsDir: process.env.STAVR_BOMS_DIR ?? 'proposed',
      githubRepo: process.env.STAVR_GITHUB_REPO,
    });
    res.json(detail);
  });
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    app[method]('/dashboard/api/history/:kind/:id', (_req, res) => {
      res.status(405).json({ error: 'history is read-only' });
    });
  }

  // P4 — correlation trace endpoint. Returns the walked chain shaped
  // for the trace-drawer renderer. The direction defaults to 'forward'
  // for non-notification rows and 'backward' for notification rows
  // (P4 acceptance criterion). Operator can flip it with ?direction=.
  app.get('/dashboard/api/history/:kind/:id/trace', (req, res) => {
    const kind = String(req.params.kind || '');
    const id = String(req.params.id || '');
    const q = req.query as Record<string, string | undefined>;
    const defaultDir: 'forward' | 'backward' = kind === 'notification' ? 'backward' : 'forward';
    const direction: 'forward' | 'backward' = q.direction === 'backward' || q.direction === 'forward'
      ? q.direction
      : defaultDir;
    const trace = walkCorrelation({ db: broker.store.rawDb }, { kind, id }, direction);
    res.json({
      direction: trace.direction,
      correlation_id: trace.correlation_id,
      hop_depth: trace.hop_depth,
      origin: trace.origin,
      nodes: trace.nodes,
      html: renderTraceHtml(trace),
    });
  });
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    app[method]('/dashboard/api/history/:kind/:id/trace', (_req, res) => {
      res.status(405).json({ error: 'history is read-only' });
    });
  }

  // v0.6.9 PR #2 — Permissions API endpoints. Operator-only path; the
  // dashboard session is implicitly trusted via the existing
  // /dashboard/* auth posture. MCP-tool writes to these tables are
  // hard-NO per BOM hard rule #8 (never allow an MCP client to change
  // permissions). All mutations record set_by and set_at.
  //
  // v0.6.9 P9 — every mutation also emits a `capability_override_changed`
  // or `actor_permission_changed` event so the operator can answer "who
  // set Steward's host_exec to EXPLICIT, when, why?" from the event log.

  app.post('/dashboard/permissions/capability', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const toolId = typeof body.tool_id === 'string' ? body.tool_id : '';
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const setBy = typeof body.set_by === 'string' ? body.set_by : 'operator';
    if (!toolId) {
      res.status(400).json({ error: 'tool_id required' });
      return;
    }
    const caps = getOrCreateCapabilityOverrideStore(broker);
    const prior = caps.get(toolId);
    const fromState = prior ? prior.state : null;
    let toState: 'enabled' | 'disabled-temporary' | 'disabled-permanent';
    let disabledUntil: number | null = null;
    if (mode === 'permanent') {
      caps.disablePermanent(toolId, { reason, setBy });
      toState = 'disabled-permanent';
    } else if (mode === 'temporary') {
      const untilMs = typeof body.until_ms === 'number' ? body.until_ms : NaN;
      if (!Number.isFinite(untilMs)) {
        res.status(400).json({ error: 'until_ms required when mode=temporary' });
        return;
      }
      caps.disableTemporary(toolId, { untilMs, reason, setBy });
      toState = 'disabled-temporary';
      disabledUntil = untilMs;
    } else if (mode === 'enable') {
      caps.enable(toolId, setBy);
      toState = 'enabled';
    } else {
      res.status(400).json({ error: 'mode must be one of: permanent | temporary | enable' });
      return;
    }
    if (fromState !== toState) {
      await broker.publish({
        kind: 'capability_override_changed',
        at: new Date().toISOString(),
        source_agent: 'dashboard',
        payload: {
          tool_id: toolId,
          set_by: setBy,
          from_state: fromState,
          to_state: toState,
          reason,
          disabled_until: disabledUntil,
        },
      });
    }
    res.json({ ok: true, tool_id: toolId, state: caps.get(toolId) ?? null });
  });

  app.delete('/dashboard/permissions/capability/:toolId', async (req, res) => {
    const caps = getOrCreateCapabilityOverrideStore(broker);
    const prior = caps.get(req.params.toolId);
    const fromState = prior ? prior.state : null;
    caps.enable(req.params.toolId, 'operator');
    if (fromState !== null && fromState !== 'enabled') {
      await broker.publish({
        kind: 'capability_override_changed',
        at: new Date().toISOString(),
        source_agent: 'dashboard',
        payload: {
          tool_id: req.params.toolId,
          set_by: 'operator',
          from_state: fromState,
          to_state: 'enabled',
        },
      });
    }
    res.json({ ok: true, tool_id: req.params.toolId });
  });

  app.post('/dashboard/permissions/actor', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorId = typeof body.actor_id === 'string' ? body.actor_id : '';
    const toolId = typeof body.tool_id === 'string' ? body.tool_id : '';
    const tier = typeof body.tier === 'string' ? (body.tier as Tier) : '' as Tier;
    const setBy = typeof body.set_by === 'string' ? body.set_by : 'operator';
    if (!actorId || !toolId) {
      res.status(400).json({ error: 'actor_id + tool_id required' });
      return;
    }
    if (!TIERS.includes(tier)) {
      res.status(400).json({ error: 'tier must be one of: AUTO | CONFIRM | EXPLICIT | NO_GO' });
      return;
    }
    const perms = getOrCreateActorPermissionStore(broker);
    const prior = perms.get(actorId, toolId);
    const fromTier = prior ? prior.tier : null;
    perms.set(actorId, toolId, tier, setBy);
    if (fromTier !== tier) {
      await broker.publish({
        kind: 'actor_permission_changed',
        at: new Date().toISOString(),
        source_agent: 'dashboard',
        payload: {
          actor_id: actorId,
          tool_id: toolId,
          set_by: setBy,
          from_tier: fromTier,
          to_tier: tier,
          source: 'matrix-cell',
        },
      });
    }
    res.json({ ok: true, actor_id: actorId, tool_id: toolId, tier });
  });

  app.delete('/dashboard/permissions/actor/:actorId/:toolId', async (req, res) => {
    const perms = getOrCreateActorPermissionStore(broker);
    const prior = perms.get(req.params.actorId, req.params.toolId);
    perms.reset(req.params.actorId, req.params.toolId);
    if (prior) {
      await broker.publish({
        kind: 'actor_permission_changed',
        at: new Date().toISOString(),
        source_agent: 'dashboard',
        payload: {
          actor_id: req.params.actorId,
          tool_id: req.params.toolId,
          set_by: 'operator',
          from_tier: prior.tier,
          to_tier: defaultTierFor(req.params.toolId),
          source: 'reset',
        },
      });
    }
    res.json({ ok: true, actor_id: req.params.actorId, tool_id: req.params.toolId });
  });

  // v0.6.9 P6 — Apply a built-in named policy preset to one actor in
  // a single click. Equivalent to the operator setting every dropdown
  // manually but atomic + audited (one `actor_permission_changed` event
  // per affected tool with `source: 'policy-apply'`).
  app.post('/dashboard/permissions/policy/apply', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorId = typeof body.actor_id === 'string' ? body.actor_id : '';
    const policyId = typeof body.policy_id === 'string' ? body.policy_id : '';
    const setBy = typeof body.set_by === 'string' ? body.set_by : 'operator';
    if (!actorId || !policyId) {
      res.status(400).json({ error: 'actor_id + policy_id required' });
      return;
    }
    let preset;
    try {
      preset = getPolicyPreset(policyId);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const perms = getOrCreateActorPermissionStore(broker);
    const result = applyPolicyToActor(preset, actorId, perms, setBy);
    const at = new Date().toISOString();
    for (const change of result.changes) {
      await broker.publish({
        kind: 'actor_permission_changed',
        at,
        source_agent: 'dashboard',
        payload: {
          actor_id: actorId,
          tool_id: change.tool_id,
          set_by: setBy,
          from_tier: change.from_tier,
          to_tier: change.to_tier,
          source: 'policy-apply',
          policy_id: preset.id,
        },
      });
    }
    res.json({
      ok: true,
      actor_id: actorId,
      policy_id: preset.id,
      cells_written: result.cellsWritten,
    });
  });

  app.get('/dashboard/permissions/policies', (_req, res) => {
    res.json({ policies: listPolicyPresets() });
  });

  // ---- C9 Settings endpoints ----

  // v0.4 — capture ⊕ endpoint. The dashboard's floating button POSTs a
  // snapshot + comment + type/priority. The write goes to
  // `~/.stavr/captures/<type>.jsonl` (per the brief's v0.4 routing); a
  // `capture_filed` audit event mirrors it onto the event log so it
  // survives the 90d audit retention window.
  app.post('/dashboard/capture', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    const type = typeof body.type === 'string' ? body.type : '';
    const priority = typeof body.priority === 'string' ? body.priority : 'normal';
    if (!comment || !type) {
      res.status(400).json({ error: 'body { comment: string, type: string, snapshot: object, priority?: string, related_id?: string } required' });
      return;
    }
    try {
      const { fileCapture, isCaptureType, isCapturePriority } = await import('./tools/capture.js');
      if (!isCaptureType(type)) {
        res.status(400).json({ error: `type must be one of bug|feature|investigate|todo` });
        return;
      }
      const pr = isCapturePriority(priority) ? priority : 'normal';
      const snapshot = (body.snapshot as Record<string, unknown> | undefined) ?? {};
      const relatedId = typeof body.related_id === 'string' ? body.related_id : undefined;
      const result = fileCapture({
        comment,
        type,
        priority: pr,
        snapshot: snapshot as never,
        related_id: relatedId,
      });
      await broker.publish({
        kind: 'capture_filed',
        at: new Date().toISOString(),
        correlation_id: relatedId,
        source_agent: 'dashboard',
        payload: { id: result.id, type, priority: pr, destination: result.destination, related_id: relatedId },
      });
      res.json({ ok: true, id: result.id, destination: result.destination });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // v0.4 — runtime toggles for the /debug/* endpoints. Audit-class events
  // make the on/off lineage survive 90d (ADR-030). Operators can flip
  // STAVR_DEBUG_HEAP, STAVR_DEBUG_CPU, STAVR_DEBUG_REPORT individually or
  // STAVR_DEBUG_ENABLED as a master.
  app.get('/dashboard/settings/runtime-toggles', (_req, res) => {
    res.json({ toggles: broker.store.listRuntimeToggles() });
  });
  app.post('/dashboard/settings/runtime-toggles', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body.key === 'string' ? body.key : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const ttlMinutes = typeof body.ttl_minutes === 'number' ? body.ttl_minutes : undefined;
    const setBy = typeof body.set_by === 'string' ? body.set_by : 'dashboard';
    const validKeys = new Set([
      'STAVR_DEBUG_ENABLED', 'STAVR_DEBUG_HEAP', 'STAVR_DEBUG_CPU', 'STAVR_DEBUG_REPORT',
    ]);
    if (!validKeys.has(key)) {
      res.status(400).json({ error: 'unknown key', allowed: [...validKeys] });
      return;
    }
    const expiresAt = broker.store.setRuntimeToggle(key, value, setBy, ttlMinutes);
    await broker.publish({
      kind: 'runtime_toggle_changed',
      at: new Date().toISOString(),
      source_agent: setBy === 'dashboard' ? 'dashboard' : 'stavr-cli',
      payload: { key, value, ttl_minutes: ttlMinutes ?? null, expires_at: expiresAt, set_by: setBy },
    });
    res.json({ ok: true, key, value, expires_at: expiresAt });
  });
  app.delete('/dashboard/settings/runtime-toggles/:key', async (req, res) => {
    const key = req.params.key;
    const had = broker.store.deleteRuntimeToggle(key);
    if (had) {
      await broker.publish({
        kind: 'runtime_toggle_changed',
        at: new Date().toISOString(),
        source_agent: 'dashboard',
        payload: { key, value: null, set_by: 'dashboard', expires_at: null },
      });
    }
    res.json({ ok: true, had });
  });

  app.post('/dashboard/settings/profile', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: string };
    if (body.mode !== 'turbo' && body.mode !== 'balanced' && body.mode !== 'eco') {
      res.status(400).json({ error: "body { mode: 'turbo' | 'balanced' | 'eco' } required" });
      return;
    }
    broker.store.setActiveProfileMode(body.mode, 'dashboard-user');
    await broker.publish({
      kind: 'profile_mode_switched',
      at: new Date().toISOString(),
      source_agent: 'dashboard',
      payload: { mode: body.mode, switched_by: 'dashboard-user' },
    });
    res.json({ ok: true, mode: body.mode });
  });

  app.post('/dashboard/settings/scopes/:id/revoke', async (req, res) => {
    const scope = trustStore.revoke(req.params.id);
    if (!scope) { res.status(404).json({ error: 'not_found' }); return; }
    await broker.publish({
      kind: 'trust_scope_revoked',
      at: new Date().toISOString(),
      correlation_id: scope.id,
      source_agent: 'dashboard',
      payload: { id: scope.id, revoked_by: 'dashboard-user' },
    });
    res.json({ ok: true, scope });
  });

  // Storm F2 — operator-driven grant from the Pending Scopes UI. The MCP
  // tool `trust_scope_grant` goes through gatedAction → await_decision so a
  // human can rubber-stamp it from the dashboard. THIS endpoint *is* that
  // human surface, so it flips proposed→active directly (no second decision
  // loop). The MCP-tool path remains untouched.
  app.post('/dashboard/settings/scopes/:id/grant', async (req, res) => {
    const existing = trustStore.get(req.params.id);
    if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
    if (existing.status !== 'proposed') {
      res.status(409).json({ error: `scope is not 'proposed' (status=${existing.status})` });
      return;
    }
    const granted = trustStore.grant(req.params.id, 'dashboard-user');
    if (!granted || granted.status !== 'active') {
      res.status(500).json({ error: 'grant_failed' });
      return;
    }
    await broker.publish({
      kind: 'trust_scope_granted',
      at: new Date().toISOString(),
      correlation_id: granted.id,
      source_agent: 'dashboard',
      payload: {
        scope_id: granted.id,
        title: granted.title,
        granted_by: granted.granted_by,
        granted_at: granted.granted_at,
        expires_at: granted.expires_at,
        expires_after_actions: granted.expires_after_actions,
      },
    });
    res.json({ ok: true, scope: granted });
  });

  app.post('/dashboard/settings/scopes/:id/extend', async (req, res) => {
    const body = (req.body ?? {}) as { new_expires_at?: string; new_expires_after_actions?: number };
    if (!body.new_expires_at && body.new_expires_after_actions === undefined) {
      res.status(400).json({ error: 'extend requires new_expires_at and/or new_expires_after_actions' });
      return;
    }
    const updated = trustStore.extend(req.params.id, {
      expires_at: body.new_expires_at,
      expires_after_actions: body.new_expires_after_actions,
    });
    if (!updated) { res.status(404).json({ error: 'not_found' }); return; }
    await broker.publish({
      kind: 'trust_scope_extended',
      at: new Date().toISOString(),
      correlation_id: updated.id,
      source_agent: 'dashboard',
      payload: { id: updated.id, new_expires_at: updated.expires_at, extended_by: 'dashboard-user' },
    });
    res.json({ ok: true, scope: updated });
  });

  app.post('/dashboard/settings/nogo', (req, res) => {
    const body = (req.body ?? {}) as { rule?: { id?: string; action_pattern?: string; risk_class?: string; reason?: string } };
    const r = body.rule;
    if (!r || !r.id || !r.action_pattern || !r.risk_class || !r.reason) {
      res.status(400).json({ error: 'rule { id, action_pattern, risk_class, reason } required' });
      return;
    }
    const result = broker.store.addNoGoRule({
      id: r.id,
      action_pattern: r.action_pattern,
      risk_class: r.risk_class,
      reason: r.reason,
    });
    if (!result.added) { res.status(409).json({ error: 'rule already exists' }); return; }
    res.json({ ok: true });
  });

  app.post('/dashboard/settings/nogo/:id/toggle', (req, res) => {
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'body { enabled: boolean } required' });
      return;
    }
    const r = broker.store.setNoGoRuleEnabled(req.params.id, body.enabled);
    if (!r.changed) { res.status(404).json({ error: 'not_found_or_readonly' }); return; }
    res.json({ ok: true });
  });

  app.post('/dashboard/settings/nogo/:id/delete', (req, res) => {
    const r = broker.store.deleteNoGoRule(req.params.id);
    if (!r.deleted) { res.status(404).json({ error: 'not_found_or_readonly' }); return; }
    res.json({ ok: true });
  });

  // v0.6 — notification channel test-send. POSTs an info-severity notification
  // to a single channel so the operator can verify env vars + reachability
  // without leaving the dashboard. NO secret display — the channel's
  // isConfigured() result is the only env signal the UI gets.
  app.post('/dashboard/settings/channels/:id/test', async (req, res) => {
    const notifier = getNotifier(broker);
    if (!notifier) { res.status(503).json({ error: 'notification fabric not configured' }); return; }
    const id = req.params.id;
    const channel = notifier.listChannels().find((c) => c.id === id);
    if (!channel) { res.status(404).json({ error: 'unknown_channel' }); return; }
    if (!channel.isConfigured()) { res.status(400).json({ error: 'channel_not_configured' }); return; }
    try {
      const result = await notifier.notify({
        kind: 'health_alert',
        severity: 'info',
        title: 'Channel test',
        body: `Test message from stavR Settings · channel ${id}`,
      });
      // For non-crit notifications dispatch is async; we can't report delivered:true
      // synchronously, but we can report 'queued'. The settings UI updates the
      // row's last-success timestamp via reload after a short delay.
      res.json({ ok: true, id: result.id, delivered: result.delivered, queued_to: result.dispatchedChannels });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // v0.6 — daily digest config. GET returns current state; POST mutates
  // (hour/minute and/or enabled). Persistence: hour/minute are in-memory only
  // (operator restarts the daemon to set permanently via STAVR_NOTIFY_DIGEST_*
  // env vars); the enable/disable toggle persists for the daemon's lifetime.
  app.get('/dashboard/settings/digest', (_req, res) => {
    const sched = getDigestScheduler(broker);
    if (!sched) { res.status(503).json({ error: 'notification fabric not configured' }); return; }
    res.json(sched.snapshotState());
  });
  app.post('/dashboard/settings/digest', (req, res) => {
    const sched = getDigestScheduler(broker);
    if (!sched) { res.status(503).json({ error: 'notification fabric not configured' }); return; }
    const body = (req.body ?? {}) as { hour?: number; minute?: number; enabled?: boolean };
    if (typeof body.hour === 'number' || typeof body.minute === 'number') {
      sched.setSchedule(
        typeof body.hour === 'number' ? body.hour : sched.snapshotState().hour,
        typeof body.minute === 'number' ? body.minute : sched.snapshotState().minute,
      );
    }
    if (typeof body.enabled === 'boolean') {
      body.enabled ? sched.enable() : sched.disable();
    }
    res.json(sched.snapshotState());
  });

  // v0.6 — operator-facing notifications help page (renders the docs markdown
  // verbatim with a small wrapper). Linked from the [Help] button on NOT-SET
  // channel rows. Loopback-only — see /dashboard/settings auth posture.
  app.get('/dashboard/settings/notifications-help', (_req, res) => {
    res.redirect('/dashboard/settings#section-channels');
  });

  app.post('/dashboard/bricks/:id/uninstall', async (req, res) => {
    const sub = getV02Subsystem(broker);
    if (!sub) { res.status(503).json({ error: 'connector subsystem not wired' }); return; }
    try {
      const ok = await sub.bricks.uninstall(req.params.id);
      if (!ok) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- C7 Toolkit endpoints ----

  app.post('/dashboard/bricks/:id/test', async (req, res) => {
    const sub = getV02Subsystem(broker);
    if (!sub) { res.status(503).json({ error: 'connector subsystem not wired' }); return; }
    const c = sub.connectors.get(req.params.id);
    if (!c) { res.status(404).json({ error: 'not_found' }); return; }
    try {
      const status = await c.testConnection();
      res.json(status);
    } catch (err) {
      res.status(500).json({ kind: 'error', detail: (err as Error).message });
    }
  });

  app.post('/dashboard/bricks/:id/apply', async (req, res) => {
    const sub = getV02Subsystem(broker);
    if (!sub) { res.status(503).json({ error: 'connector subsystem not wired' }); return; }
    const c = sub.connectors.get(req.params.id);
    if (!c) { res.status(404).json({ error: 'not_found' }); return; }
    const body = (req.body ?? {}) as { config?: Record<string, unknown> };
    if (!body.config || typeof body.config !== 'object') {
      res.status(400).json({ error: 'body { config: object } required' });
      return;
    }
    try {
      const status = await c.applyConfig(body.config);
      res.json(status);
    } catch (err) {
      res.status(400).json({ kind: 'error', detail: (err as Error).message });
    }
  });

  app.post('/dashboard/bricks/install', async (req, res) => {
    const sub = getV02Subsystem(broker);
    if (!sub) { res.status(503).json({ error: 'connector subsystem not wired' }); return; }
    const body = (req.body ?? {}) as { source_path?: string };
    if (!body.source_path || typeof body.source_path !== 'string') {
      res.status(400).json({ error: 'body { source_path: string } required' });
      return;
    }
    try {
      const brick = await sub.bricks.installLocal(body.source_path);
      res.json({ ok: true, brick });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/dashboard/plans/list', (req, res) => {
    const statusParam = (req.query.status as string | undefined) ?? undefined;
    const allowed = new Set(['proposed','approved','running','done','failed','cancelled','rejected']);
    const status = statusParam && allowed.has(statusParam)
      ? (statusParam as 'proposed' | 'approved' | 'running' | 'done' | 'failed' | 'cancelled' | 'rejected')
      : undefined;
    const boms = status ? broker.store.listBoms({ status }) : broker.store.listBoms();
    res.json({ boms });
  });

  app.get('/dashboard/plans/:bomId', (req, res) => {
    const bom = broker.store.getBom(req.params.bomId);
    if (!bom) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const steps = broker.store.listBomSteps(bom.id, bom.active_version);
    res.json({ bom, steps });
  });

  app.post('/dashboard/plans/:bomId/respond', async (req, res) => {
    const bomId = req.params.bomId;
    const verdict = (req.body?.verdict as 'approve' | 'reject' | undefined) ?? undefined;
    if (verdict !== 'approve' && verdict !== 'reject') {
      res.status(400).json({ error: "body { verdict: 'approve' | 'reject' } required" });
      return;
    }
    const bom = broker.store.getBom(bomId);
    if (!bom) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (bom.status !== 'proposed') {
      res.status(409).json({ error: `bom status is ${bom.status}, cannot respond` });
      return;
    }
    const at = new Date().toISOString();
    if (verdict === 'reject') {
      broker.store.updateBomStatus(bomId, { status: 'rejected', ended_at: at });
      await broker.publish({
        kind: 'bom_rejected',
        at,
        correlation_id: bom.correlation_id,
        source_agent: 'dashboard',
        payload: { bom_id: bomId, version: bom.active_version, rejected_by: 'dashboard-user' },
      });
      res.json({ ok: true, status: 'rejected' });
      return;
    }
    // Approve: mark status, fan out bom_approved. The executor's subscription
    // picks it up and creates the trust scope + runs the steps.
    broker.store.updateBomStatus(bomId, { status: 'approved', approved_at: at });
    await broker.publish({
      kind: 'bom_approved',
      at,
      correlation_id: bom.correlation_id,
      source_agent: 'dashboard',
      payload: {
        bom_id: bomId,
        version: bom.active_version,
        scope_id: '', // executor will create + persist it
        approver: 'dashboard-user',
      },
    });
    res.json({ ok: true, status: 'approved' });
  });

  app.get('/dashboard/status', (_req, res) => {
    const active = trustStore.list({ status: 'active' });
    res.json({
      ok: true,
      version: ctx.version,
      port: ctx.port,
      started_at: ctx.startedAt.toISOString(),
      uptime_sec: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
      connected_clients: ctx.sseSessions.size,
      event_count: broker.store.eventCount(),
      pending_decisions: broker.store.pendingDecisionCount(),
      active_scopes: active.length,
      scopes: active.map((s) => ({
        id: s.id,
        title: s.title,
        expires_at: s.expires_at,
        actions_executed: s.actions_executed,
        expires_after_actions: s.expires_after_actions,
      })),
    });
  });

  // v0.3 dashboard Home aggregator. One fetch returns everything the Home
  // page needs: daemon health, recent BOMs, recent decisions. Single
  // round-trip keeps page load fast; live updates come over /dashboard/stream.
  app.get('/dashboard/home/data', (_req, res) => {
    res.json(homeData());
  });

  // chore/streams-to-workers — the bare `/dashboard/workers` URL now
  // serves the renamed page (was Streams). The JSON list lives under
  // `/dashboard/workers/data`, matching the `/dashboard/home/data`
  // pattern; the per-worker drill-down at `/dashboard/workers/:id` is
  // unchanged.
  app.get('/dashboard/workers/data', (_req, res) => {
    res.json({ workers: broker.store.listWorkers() });
  });

  // F9 / F69 — operator-trust pass. Real top-tools + windowed traffic stats,
  // sourced from the audit event log (not the synthetic numbers the v8 mockup
  // shipped with). Both endpoints accept a single `range` param drawn from
  // {5m,1h,24h,7d}; the Helm L1 panel and Diagnostics window selector both
  // call them.
  function parseRange(raw: unknown): { window: '5m' | '1h' | '24h' | '7d'; sinceAt: string } {
    const allowed: Record<string, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000 };
    const win = typeof raw === 'string' && raw in allowed ? raw : '1h';
    const sinceAt = new Date(Date.now() - allowed[win]).toISOString();
    return { window: win as '5m' | '1h' | '24h' | '7d', sinceAt };
  }

  app.get('/dashboard/api/top-tools', (req, res) => {
    const { window, sinceAt } = parseRange(req.query.range);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 25);
    const { events } = broker.store.getEvents({ kinds: ['steward_tool_call'], sinceAt, limit: 5000 });
    const counts = new Map<string, number>();
    for (const ev of events) {
      const tool = typeof (ev.payload as { tool?: unknown })?.tool === 'string'
        ? (ev.payload as { tool: string }).tool
        : null;
      if (!tool) continue;
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    const max = ranked.length > 0 ? ranked[0]!.count : 0;
    const tools = ranked.map((t) => ({
      name: t.name,
      count: t.count,
      pct: max > 0 ? Math.round((t.count / max) * 100) : 0,
    }));
    res.json({ window, since: sinceAt, total_tool_calls: events.length, tools });
  });

  // F69 — range-aware traffic summary for the Diagnostics window selector.
  // Returns 12 buckets across the window for each of {mcp, workers, errors}
  // plus a total. The page JS turns each bucket array into SVG polyline
  // coords against the existing 300×120 viewBox.
  app.get('/dashboard/api/traffic-summary', (req, res) => {
    const { window, sinceAt } = parseRange(req.query.range);
    const sinceMs = Date.parse(sinceAt);
    const nowMs = Date.now();
    const bucketCount = 12;
    const bucketWidthMs = (nowMs - sinceMs) / bucketCount;
    const events = broker.store.getEvents({ sinceAt, limit: 5000 }).events;
    const mcpKinds = new Set(['steward_tool_call']);
    const workerKinds = new Set(['worker_spawned', 'worker_progress', 'worker_activity', 'worker_log']);
    const errorKinds = new Set(['error', 'worker_error', 'bom_step_failed', 'host_exec_denied']);
    const mcp = new Array(bucketCount).fill(0);
    const workers = new Array(bucketCount).fill(0);
    const errors = new Array(bucketCount).fill(0);
    for (const ev of events) {
      const t = Date.parse(ev.at);
      if (!Number.isFinite(t)) continue;
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - sinceMs) / bucketWidthMs)));
      if (mcpKinds.has(ev.kind)) mcp[idx]++;
      if (workerKinds.has(ev.kind)) workers[idx]++;
      if (errorKinds.has(ev.kind)) errors[idx]++;
    }
    const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);
    res.json({
      window,
      since: sinceAt,
      buckets: bucketCount,
      bucket_width_ms: Math.round(bucketWidthMs),
      mcp: { points: mcp, total: sum(mcp) },
      workers: { points: workers, total: sum(workers) },
      errors: { points: errors, total: sum(errors) },
    });
  });


  app.get('/dashboard/workers/:id', (req, res) => {
    const worker = broker.store.getWorker(req.params.id);
    if (!worker) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Last 50 events with this worker's id either in correlation_id or in payload.id.
    const recent = broker.store.getEvents({ limit: 500 }).events;
    const matchesWorker = (ev: StoredEvent) => {
      if (ev.correlation_id === worker.id) return true;
      const p = ev.payload as { id?: string } | null | undefined;
      return !!(p && typeof p === 'object' && p.id === worker.id);
    };
    const filtered = recent.filter(matchesWorker);
    const events = filtered.slice(-50).reverse();
    const tool_calls = filtered
      .filter((e) => e.kind === 'command_run')
      .slice(-50)
      .reverse();
    res.json({ worker, events, tool_calls });
  });

  app.get('/dashboard/decisions', (req, res) => {
    const requested = (req.query.status as string | undefined) ?? 'open';
    const all = broker.store.listRecentDecisions(100);
    const filtered = requested === 'all' ? all : all.filter((d) => d.status === requested);
    res.json({ decisions: filtered });
  });

  app.post('/dashboard/decisions/:correlationId/respond', async (req, res) => {
    const corr = req.params.correlationId;
    const body = (req.body ?? {}) as {
      chosen_option_id?: string;
      reason?: string;
      responder?: string;
    };
    if (!body.chosen_option_id) {
      res.status(400).json({ error: 'chosen_option_id required' });
      return;
    }
    const existing = broker.store.getDecision(corr);
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // family-mode-phase-1 Phase 4.5 — same verified-identity discipline
    // as the respond_to_decision MCP tool. The `body.responder` field is
    // advisory only; the authorization identity comes from the actor_id
    // stamped by the upstream middleware (logContext.actor_id) which
    // reads the kernel-enforced loopback signal or req.device. The
    // dashboard mounts under /dashboard/* which is loopback-only by the
    // bind itself (ADR-006), so verifiedCaller will be `loopback:*` or
    // `unstamped-loopback` here in practice.
    const verifiedCaller = logContext.getStore()?.actor_id ?? 'unstamped-loopback';
    const policy = mayRespond(existing, verifiedCaller);
    if (!policy.ok) {
      await broker.publish({
        kind: 'decision_self_approval_rejected',
        at: new Date().toISOString(),
        correlation_id: corr,
        source_agent: verifiedCaller,
        payload: {
          error: policy.error,
          attempted_responder: body.responder ?? null,
          verified_caller: verifiedCaller,
          decision_source_agent: existing.source_agent,
          decision_tier: existing.tier,
          chosen_option_id: body.chosen_option_id,
          reason: policy.reason,
        },
      });
      res.status(403).json({ ok: false, error: policy.error });
      return;
    }
    const result = broker.store.respondToDecision(
      corr,
      body.chosen_option_id,
      body.reason ?? '',
      verifiedCaller,
    );
    if (!result.ok) {
      if (result.error === 'already_responded') {
        await broker.publish({
          kind: 'decision_late_response',
          at: new Date().toISOString(),
          correlation_id: corr,
          source_agent: verifiedCaller,
          payload: {
            chosen_option_id: body.chosen_option_id,
            reason: body.reason,
            responder: verifiedCaller,
            fallback_was: existing.chosen_option_id,
          },
        });
      }
      res.status(409).json({ ok: false, error: result.error });
      return;
    }
    await broker.publish({
      kind: 'decision_response',
      at: result.result.responded_at,
      correlation_id: corr,
      source_agent: verifiedCaller,
      payload: {
        chosen_option_id: body.chosen_option_id,
        reason: body.reason,
        responder: verifiedCaller,
      },
    });
    res.json({ ok: true, responded_at: result.result.responded_at });
  });

  app.get('/dashboard/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 5000);
    const since = req.query.since as string | undefined;
    const kindParam = req.query.kind as string | undefined;
    const kinds = kindParam ? kindParam.split(',').filter(Boolean) : undefined;
    const sourceAgent = req.query.source_agent as string | undefined;
    const correlationId = req.query.correlation_id as string | undefined;

    const filter: Parameters<typeof broker.store.getEvents>[0] = { limit };
    if (since) filter.sinceEventId = since;
    if (kinds && kinds.length) filter.kinds = kinds;
    if (sourceAgent) filter.sourceAgent = sourceAgent;

    let { events, has_more } = broker.store.getEvents(filter);
    if (correlationId) {
      events = events.filter((e) => e.correlation_id === correlationId);
    }
    res.json({ events, has_more });
  });

  app.get('/dashboard/export', (req, res) => {
    const format = (req.query.format as string | undefined) === 'csv' ? 'csv' : 'json';
    const since = req.query.since as string | undefined;
    const filter: Parameters<typeof broker.store.getEvents>[0] = { limit: 5000 };
    if (since) filter.sinceEventId = since;
    const { events } = broker.store.getEvents(filter);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'csv') {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="stavr-audit-${ts}.csv"`);
      const cols = ['id', 'at', 'persisted_at', 'kind', 'source_agent', 'correlation_id', 'tenant_id', 'payload'];
      const csvEscape = (v: unknown) => {
        const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      res.write(cols.join(',') + '\n');
      for (const e of events) {
        res.write(
          [
            e.id,
            e.at,
            e.persisted_at,
            e.kind,
            e.source_agent,
            e.correlation_id ?? '',
            e.tenant_id ?? '',
            e.payload,
          ]
            .map(csvEscape)
            .join(',') + '\n',
        );
      }
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="stavr-audit-${ts}.json"`);
    res.json({
      exported_at: new Date().toISOString(),
      count: events.length,
      events,
    });
  });

  // Spec 49 Layer 2 — operator input channel for the dashboard chat panel.
  // POST publishes a steward_prompt event with a fresh correlation_id and
  // returns 202 + correlation_id. The chat panel then opens an SSE on
  // /dashboard/steward/responses?correlation_id=<id> to render live thinking,
  // tool_call, response, and usage events for that correlation.
  app.post('/dashboard/steward/prompt', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      res.status(400).json({ ok: false, error: 'text required' });
      return;
    }
    const correlation_id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await broker.publish({
        kind: 'steward_prompt',
        at: new Date().toISOString(),
        correlation_id,
        source_agent: 'dashboard',
        payload: { text, source: 'dashboard' },
      });
      res.status(202).json({ ok: true, correlation_id });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/dashboard/steward/responses', (req: Request, res: Response) => {
    const correlationId = String(req.query.correlation_id ?? '');
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    const targetKinds = new Set([
      'steward_thinking',
      'steward_tool_call',
      'steward_response',
      'steward_usage',
    ]);
    const write = (kind: string, data: unknown) => {
      try {
        res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* socket closing */
      }
    };
    write('ping', { at: new Date().toISOString(), correlation_id: correlationId });
    const keepalive = setInterval(
      () => write('ping', { at: new Date().toISOString(), correlation_id: correlationId }),
      25_000,
    );
    const dispose = broker.onEvent((ev) => {
      if (!targetKinds.has(ev.kind)) return;
      if (correlationId && ev.correlation_id !== correlationId) return;
      write(ev.kind, ev);
    });
    const onClose = () => {
      clearInterval(keepalive);
      dispose();
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };
    res.on('close', onClose);
  });

  // Live SSE tail for the browser. Distinct from /mcp: this is plain
  // text/event-stream with raw event JSON; no MCP handshake required. Lives
  // and dies entirely on the broker's onEvent tap.
  app.get('/dashboard/stream', (_req: Request, res: Response) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const write = (kind: string, data: unknown) => {
      try {
        res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Socket may be closed mid-write — the unsub below will land momentarily.
      }
    };

    write('ping', { at: new Date().toISOString() });
    const keepalive = setInterval(() => write('ping', { at: new Date().toISOString() }), 25_000);

    const dispose = broker.onEvent((ev) => write('event', ev));

    const onClose = () => {
      clearInterval(keepalive);
      dispose();
      try { res.end(); } catch { /* already gone */ }
    };
    res.on('close', onClose);
  });
}
