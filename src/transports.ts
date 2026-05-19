import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import { fetchTopologyExtras } from './dashboard/data/topology-data.js';
import { deriveLifecycleState } from './workers/lifecycle.js';
import { fetchPermissionsData } from './dashboard/data/permissions-data.js';
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
import { memoize, resolveDashboardCacheMs, resolveStreamsMaxEvents } from './dashboard/memo.js';
import {
  normalizeRoute,
  registry as metricsRegistry,
  setSseSessionsGauge,
  stavrHttpRequestDuration,
} from './observability/metrics.js';
import { logContext } from './observability/logger.js';
import { mountDebugEndpoints } from './observability/debug-endpoints.js';
import { attachMcpAttributes } from './observability/spans.js';
import { getV02Subsystem } from './steward/v02-wiring.js';
import { computeUsage, fetchAnthropicBalance, type ComputeUsageOpts } from './usage.js';
import {
  PendingPairingRegistry,
  generateDeviceToken,
  hashToken,
} from './pairing.js';

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
   * In-memory pending-pairing registry shared between `pair --bootstrap` and the
   * remote `/pair/complete` endpoint. Spec 52 A2. Caller may pass their own (tests
   * do); otherwise mountTransports creates a fresh registry per daemon process.
   */
  pairingRegistry?: PendingPairingRegistry;
  /**
   * Override `Date.now()` for the pairing TTL. Test seam.
   */
  now?: () => number;
}

export interface MountedTransports {
  httpServer?: HttpServer;
  shutdown: () => Promise<void>;
  /** Live count of connected SSE sessions (daemon mode only). */
  sseSessionCount: () => number;
  /**
   * The pending-pairing registry the HTTP transport is using. Exposed so the
   * `stavr pair --bootstrap` CLI (which runs in the same daemon process) can
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
  };
  const sseSessions = new Map<string, McpSession>();
  const refreshSseGauge = (): void => setSseSessionsGauge(sseSessions.size);
  refreshSseGauge();
  // Always create the registry — `pair --bootstrap` may run in this same
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
          'Run `stavr pair --bootstrap` first or set `network.require_auth_when_non_local: false` ' +
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
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/metrics') return next();
      const endTimer = stavrHttpRequestDuration.startTimer({ method: req.method });
      const route = normalizeRoute(req.path);
      res.on('finish', () => {
        endTimer({ route, status: String(res.statusCode) });
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
    const version = process.env.STAVR_VERSION ?? '0.1.0';
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

    // ---- Spec 52 A2 — pairing endpoints (public for /pair/complete) ----

    // Loopback-only: opens a pairing window and returns the 6-digit code. The
    // bootstrap operator runs `stavr pair --bootstrap` on the daemon machine,
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
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const handle = createSwitchServer(broker);
        await handle.server.connect(transport);
        transport.onclose = () => {
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
        session = { transport, handle };
        isNew = true;
      }

      await session.transport.handleRequest(req, res, req.body);

      // After handleRequest, sessionId is populated on the first POST.
      // Register so subsequent requests find the same session.
      if (isNew && session.transport.sessionId) {
        sseSessions.set(session.transport.sessionId, session);
        refreshSseGauge();
        log(`MCP session ${session.transport.sessionId} connected`);
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
        log(`HTTP/SSE listening on ${bindHost}:${opts.port}`);
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
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    for (const s of sseSessions.values()) await s.transport.close().catch(() => {});
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
  // hit by /dashboard/home/data every 5s from the page poll; Streams reads
  // up to 100 events per render and joins them against the workers table.
  // Both were per-call leaky in the 2026-05-15 OOM. TTL is configurable via
  // STAVR_DASHBOARD_CACHE_MS (default 2000ms).
  const dashboardCacheMs = resolveDashboardCacheMs(2000);
  const streamsMaxEvents = resolveStreamsMaxEvents(100);

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
    return { boms, totals };
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
  // routes (home, topology, streams, plans, decide, toolkit, capabilities,
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
    // store. Pulled together so the topology snapshot stays a single
    // round-trip from the dashboard.
    const { mcpCategoryNodes, peers, eventDensity } = fetchTopologyExtras({
      registry: getOrCreateToolRegistry(broker),
      store: broker.store,
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
    };
  }

  // Streams page snapshot — workers + last few events per worker.
  // The page caps visible panes at 20 internally; we still hand it the
  // full list so a search match outside the cap can highlight which
  // worker isn't yet visible (future polish).
  //
  // bom-oom-leak-hunt C2.3 — `limit` dropped from 500 to STAVR_STREAMS_MAX_EVENTS
  // (default 100). The recon flagged the 500-per-render allocation as a
  // dominant retainer growth. 100 events × ~300 bytes JSON parse is ~30 kB
  // per render, vs 150 kB with the old cap — manageable even under 5s
  // polling. Operators who want more can bump the env or hit `stavr events`
  // directly.
  function streamsDataRaw() {
    const workers = broker.store.listWorkers();
    const recent: Record<string, StoredEvent[]> = {};
    if (workers.length > 0) {
      const allRecent = broker.store.getEvents({ limit: streamsMaxEvents }).events;
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

  // bom-oom-leak-hunt C2.2 — memoized accessors. Streams page is the
  // hotter path (full event scan per render); home is the more frequent
  // path (5s poll). Both wrapped at the same TTL — overrideable via env.
  const homeData = memoize(homeDataRaw, dashboardCacheMs);
  const streamsData = memoize(streamsDataRaw, Math.max(1, Math.floor(dashboardCacheMs / 2)));

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

  mountDashboardPages(app, { helmData, homeData, plansData, decideData, topologyData, streamsData, toolkitData, mcpsData, toolsData, permissionsData, capabilitiesData, settingsData });

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

  app.get('/dashboard/workers', (_req, res) => {
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
    const responder = body.responder || 'dashboard-user';
    const result = broker.store.respondToDecision(
      corr,
      body.chosen_option_id,
      body.reason ?? '',
      responder,
    );
    if (!result.ok) {
      if (result.error === 'already_responded') {
        await broker.publish({
          kind: 'decision_late_response',
          at: new Date().toISOString(),
          correlation_id: corr,
          source_agent: responder,
          payload: {
            chosen_option_id: body.chosen_option_id,
            reason: body.reason,
            responder,
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
      source_agent: responder,
      payload: {
        chosen_option_id: body.chosen_option_id,
        reason: body.reason,
        responder,
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
