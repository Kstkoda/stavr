import express, { type Request, type Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSwitchServer, getOrCreateTrustStore } from './server.js';
import type { Broker } from './broker.js';
import { startupDecisionSweep } from './tools/decisions.js';
import { getLogger } from './log.js';
import { DASHBOARD_HTML } from './dashboard-html.js';
import type { StoredEvent } from './persistence.js';
import { computeUsage, fetchAnthropicBalance, type ComputeUsageOpts } from './usage.js';

/**
 * Transport modes:
 *  - 'stdio'  : stdio transport only (for direct CC spawn / `cowire run`).
 *  - 'daemon' : HTTP/SSE only; binding the port is required (failure is fatal).
 *  - 'both'   : stdio + optional HTTP/SSE; EADDRINUSE falls back to stdio (back-compat for `cowire start`).
 */
export type TransportMode = 'stdio' | 'daemon' | 'both';

export interface TransportOpts {
  mode?: TransportMode;
  port?: number;
  /** Deprecated: prefer `mode`. Kept for `cowire start --stdio-only`. */
  stdioOnly?: boolean;
  silent?: boolean;
}

export interface MountedTransports {
  httpServer?: HttpServer;
  shutdown: () => Promise<void>;
  /** Live count of connected SSE sessions (daemon mode only). */
  sseSessionCount: () => number;
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

  const wantHttp = mode === 'daemon' || (mode === 'both' && opts.port !== undefined);
  if (wantHttp) {
    if (opts.port === undefined) throw new Error('port is required when mode includes HTTP/SSE');

    const app = express();
    app.use(express.json({ limit: '4mb' }));

    const daemonStartedAt = new Date();
    const version = process.env.COWIRE_VERSION ?? '0.1.0';

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
      res.on('close', () => {
        sseSessions.delete(transport.sessionId);
        broker.removeSession(handle.sessionId);
      });
      await handle.server.connect(transport);
      log(`SSE session ${transport.sessionId} connected`);
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

    mountDashboardRoutes(app, broker, {
      port: opts.port,
      startedAt: daemonStartedAt,
      version,
      sseSessions,
    });

    httpServer = await new Promise<HttpServer | undefined>((resolve, reject) => {
      const s = app.listen(opts.port!, '127.0.0.1', () => {
        log(`HTTP/SSE listening on 127.0.0.1:${opts.port}`);
        resolve(s);
      });
      s.on('error', (err: NodeJS.ErrnoException) => {
        if (mode === 'daemon') {
          // Daemon mode: bind failure is fatal — there's nothing else for us to do.
          reject(err);
          return;
        }
        // 'both' mode: legacy `cowire start` behaviour — degrade to stdio-only.
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

  return { httpServer, shutdown, sseSessionCount: () => sseSessions.size };
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

  app.get('/dashboard', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(DASHBOARD_HTML);
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
      res.setHeader('content-disposition', `attachment; filename="cowire-audit-${ts}.csv"`);
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
    res.setHeader('content-disposition', `attachment; filename="cowire-audit-${ts}.json"`);
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
