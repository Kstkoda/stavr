import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSwitchServer, getOrCreateTrustStore } from './server.js';
import type { Broker } from './broker.js';
import type { StoredEvent } from './persistence.js';
import { startupDecisionSweep } from './tools/decisions.js';
import { getLogger } from './log.js';
import { mountDashboardPages } from './dashboard/index.js';
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
  const sseSessions = new Map<string, SSEServerTransport>();
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

    app.get('/mcp/sse', async (_req: Request, res: Response) => {
      const transport = new SSEServerTransport('/mcp/messages', res);
      const handle = createSwitchServer(broker);
      sseSessions.set(transport.sessionId, transport);
      // Heartbeat — write an SSE comment every 25s so undici's default 300s
      // bodyTimeout on the client side never fires on an idle session. SSE
      // comments are spec-compliant and the MCP SDK's SSEClientTransport
      // ignores them.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* socket gone */ }
        }
      }, 25_000);
      heartbeat.unref?.();
      res.on('close', () => {
        clearInterval(heartbeat);
        sseSessions.delete(transport.sessionId);
        broker.removeSession(handle.sessionId);
      });
      await handle.server.connect(transport);
      log(`SSE session ${transport.sessionId} connected`);
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

    app.post('/mcp/messages', async (req: Request, res: Response) => {
      const sessionId = String(req.query.sessionId ?? '');
      const transport = sseSessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'unknown session' });
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
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

    mountDashboardRoutes(app, broker, {
      port: opts.port,
      startedAt: daemonStartedAt,
      version,
      sseSessions,
    });

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
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    for (const t of sseSessions.values()) await t.close().catch(() => {});
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
  sseSessions: Map<string, SSEServerTransport>;
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

  // v0.3 dashboard Home aggregator — shared by the server-side initial
  // paint and the JSON endpoint that drives live refresh.
  function homeData() {
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

  // v0.3 dashboard shell — /dashboard redirects to /dashboard/home; per-page
  // routes (home, topology, streams, plans, decide, toolkit, capabilities,
  // settings) render the shared shell. Must run BEFORE any /dashboard/<page>/*
  // JSON endpoints so Express dispatches the page route for bare GETs.
  mountDashboardPages(app, { homeData, plansData });

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

  // Live SSE tail for the browser. Distinct from /mcp/sse: this is plain
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
