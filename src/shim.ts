#!/usr/bin/env node
/**
 * Stdio→SSE shim. Speaks stdio downward (to an MCP client that only supports
 * stdio entries in its config — current Cowork builds, for example) and SSE
 * upward (to a Switch daemon). Forwards JSON-RPC messages byte-for-byte; does
 * not parse or interpret them.
 *
 * Reconnect policy (ADR-019, supersedes the 3-error threshold from ADR-009):
 *  - On SSE error, log + retry with exponential backoff starting at 1s.
 *  - Each subsequent error within 30s doubles the delay, capped at 5min.
 *  - 30s of clean operation resets the counter and backoff.
 *  - After 1h without a successful connection, log `shim_giving_up` and exit 1.
 *
 * On successful reconnect we hit the daemon's `/status` endpoint; if its
 * `started_at` changed since last seen, we log a `daemon restart detected`
 * line and emit a `shim_reconnected` event so subscribers see the gap.
 *
 * Config: STAVR_DAEMON_URL env var (default http://127.0.0.1:7777/mcp),
 * overridable per-invocation via `--url <url>`.
 */
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_URL = 'http://127.0.0.1:7777/mcp';
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const RESET_AFTER_CLEAN_MS = 30_000;
const GIVE_UP_AFTER_MS = 60 * 60_000;

// Streamable HTTP transport (MCP spec 2025-06-18+). Closes audit major #2
// by removing the long-lived SSE body that earlier shims kept open: each
// request gets its own short stream, so undici's bodyTimeout never fires
// on an idle session, and there's no dispatcher-injection gymnastics.
// The variable is still named `sse` for diff stability — Streamable HTTP
// also uses SSE for the GET response framing, just not as a permanent stream.

export interface RunShimOptions {
  url: string;
  stdin?: Readable;
  stdout?: Writable;
  /** When set, runShim resolves once both transports are connected instead of
   *  running until exit. The returned handle exposes shutdown(). For tests. */
  exitOnClose?: boolean;
  /** Test seam: override the initial backoff. Defaults to 1s. */
  initialBackoffMs?: number;
  /** Test seam: override the max backoff. Defaults to 5min. */
  maxBackoffMs?: number;
  /** Test seam: override the give-up window. Defaults to 1h. */
  giveUpAfterMs?: number;
}

export interface ShimHandle {
  shutdown: (code?: number, reason?: string) => Promise<void>;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function resolveUrl(argv: string[]): string {
  const i = argv.findIndex((a) => a === '--url' || a === '-u');
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return process.env.STAVR_DAEMON_URL ?? DEFAULT_URL;
}

function deriveStatusUrl(sseUrl: string): string | undefined {
  try {
    const u = new URL(sseUrl);
    u.pathname = '/status';
    u.search = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

async function fetchDaemonStartedAt(statusUrl: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(statusUrl, { signal: controller.signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { started_at?: string };
      return body.started_at;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export async function runShim(opts: RunShimOptions): Promise<ShimHandle> {
  const initialBackoffMs = opts.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const giveUpAfterMs = opts.giveUpAfterMs ?? GIVE_UP_AFTER_MS;
  const statusUrl = deriveStatusUrl(opts.url);

  const stdio = new StdioServerTransport(opts.stdin, opts.stdout);

  let sse: StreamableHTTPClientTransport | undefined;
  let closed = false;
  let reconnecting = false;
  let backoffMs = initialBackoffMs;
  let consecutiveErrors = 0;
  let lastErrorAt = 0;
  let lastSuccessAt = Date.now();
  let firstFailureAt: number | null = null;
  let lastKnownDaemonStartedAt: string | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const log = (msg: string) => console.error(`[shim] ${msg}`);

  const shutdown = async (code = 0, reason = 'shutdown'): Promise<void> => {
    if (closed) return;
    closed = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    log(`closing: ${reason}`);
    if (opts.exitOnClose) process.exitCode = code;
    const tasks: Promise<unknown>[] = [stdio.close()];
    if (sse) tasks.push(sse.close());
    await Promise.allSettled(tasks);
    // Don't call process.exit() — on Windows it races EventSource's libuv
    // handle teardown and trips `Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING)`. Setting exitCode and letting the event loop drain
    // naturally is sufficient.
  };

  const wireSse = (transport: StreamableHTTPClientTransport): void => {
    transport.onmessage = (msg: JSONRPCMessage) => {
      stdio.send(msg).catch((err) => {
        log(`forward sse→stdio failed: ${errMessage(err)}`);
      });
    };
    transport.onclose = () => {
      // EventSource's underlying handle closed. If we're not already in the
      // middle of a reconnect attempt (driven by onerror) and we're not
      // shutting down, treat it like a generic disconnect and retry.
      if (!closed && !reconnecting) {
        scheduleReconnect(new Error('sse onclose'));
      }
    };
    transport.onerror = (err) => {
      handleSseError(err);
    };
  };

  const attemptReconnect = async (): Promise<void> => {
    if (closed) return;
    reconnecting = true;
    try {
      const next = new StreamableHTTPClientTransport(new URL(opts.url));
      wireSse(next);
      await next.start();
      // Close the old transport (if any) AFTER the new one is up so we never
      // have a window with zero upstream connections.
      const previous = sse;
      sse = next;
      if (previous) {
        await previous.close().catch(() => {});
      }
      reconnecting = false;
      onReconnected();
    } catch (err) {
      reconnecting = false;
      handleSseError(err);
    }
  };

  const scheduleReconnect = (err: unknown): void => {
    if (closed) return;
    if (pendingTimer) return; // already queued
    const delay = backoffMs;
    log(`SSE error (#${consecutiveErrors}, retry in ${delay}ms): ${errMessage(err)}`);
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void attemptReconnect();
    }, delay);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  };

  const handleSseError = (err: unknown): void => {
    if (closed) return;
    const now = Date.now();

    // Reset window: if we've had a clean stretch since the last error/success,
    // wipe the counter and shrink the backoff back down. This is what makes
    // "the daemon was down for an hour, came back, then blipped once" not
    // count as a 2nd error against the previous window.
    if (
      consecutiveErrors > 0 &&
      now - lastErrorAt > RESET_AFTER_CLEAN_MS &&
      now - lastSuccessAt > RESET_AFTER_CLEAN_MS
    ) {
      consecutiveErrors = 0;
      backoffMs = initialBackoffMs;
      firstFailureAt = null;
    }
    if (firstFailureAt === null) firstFailureAt = now;
    consecutiveErrors += 1;
    lastErrorAt = now;

    if (firstFailureAt !== null && now - firstFailureAt > giveUpAfterMs) {
      log(`shim_giving_up after ${giveUpAfterMs}ms of repeated failures`);
      void shutdown(1, 'daemon unreachable after extended outage');
      return;
    }
    scheduleReconnect(err);
  };

  const onReconnected = (): void => {
    const now = Date.now();
    const wasOutageMs = lastErrorAt > 0 ? now - firstFailureAt! : 0;
    lastSuccessAt = now;
    consecutiveErrors = 0;
    backoffMs = initialBackoffMs;
    firstFailureAt = null;
    if (wasOutageMs > 0) {
      log(`reconnected to daemon (outage ${wasOutageMs}ms)`);
    } else {
      log(`reconnected to daemon`);
    }

    // Detect daemon restart by comparing started_at, and emit a
    // shim_reconnected event so subscribers see the gap. Best-effort: if the
    // /status fetch fails we keep going. The emit goes through MCP tools/call;
    // we hand-craft the JSON-RPC envelope rather than building an MCP Client.
    if (statusUrl && wasOutageMs > 0) {
      void (async () => {
        const startedAt = await fetchDaemonStartedAt(statusUrl);
        if (
          startedAt &&
          lastKnownDaemonStartedAt &&
          startedAt !== lastKnownDaemonStartedAt
        ) {
          log(`daemon restart detected (uptime reset, started_at=${startedAt})`);
        }
        if (startedAt) lastKnownDaemonStartedAt = startedAt;
        emitShimReconnected(wasOutageMs, startedAt);
      })();
    } else if (statusUrl && lastKnownDaemonStartedAt === undefined) {
      void (async () => {
        lastKnownDaemonStartedAt = await fetchDaemonStartedAt(statusUrl);
      })();
    }
  };

  const emitShimReconnected = (outageMs: number, daemonStartedAt: string | undefined): void => {
    if (!sse) return;
    const callId = `shim-reconnect-${Date.now()}`;
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: {
        name: 'emit_event',
        arguments: {
          kind: 'progress',
          source_agent: 'stavr-shim',
          payload: {
            message: `shim_reconnected after ${outageMs}ms${daemonStartedAt ? ` (daemon started_at=${daemonStartedAt})` : ''}`,
          },
        },
      },
    };
    sse.send(message).catch((err) => {
      log(`failed to emit shim_reconnected: ${errMessage(err)}`);
    });
  };

  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (!sse) return;
    sse.send(msg).catch((err) => {
      log(`forward stdio→sse failed: ${errMessage(err)}`);
    });
  };
  stdio.onclose = () => {
    void shutdown(0, 'stdin closed');
  };
  stdio.onerror = (err) => log(`stdio error: ${errMessage(err)}`);

  // Initial connect must succeed — if the daemon isn't there at startup the
  // client sees a missing server rather than a server that silently swallows
  // requests.
  sse = new StreamableHTTPClientTransport(new URL(opts.url));
  wireSse(sse);
  await sse.start();
  log(`connected to ${opts.url}`);
  lastSuccessAt = Date.now();
  if (statusUrl) {
    void (async () => {
      lastKnownDaemonStartedAt = await fetchDaemonStartedAt(statusUrl);
    })();
  }

  await stdio.start();
  log('stdio bridge ready');

  // StdioServerTransport.close() is only triggered when *we* call it; it does
  // not propagate stdin EOF on its own. Watch for 'end' here so the parent
  // closing our stdin causes a clean exit.
  const inStream = opts.stdin ?? process.stdin;
  inStream.once('end', () => {
    void shutdown(0, 'stdin EOF');
  });

  return { shutdown };
}

async function mainCli(): Promise<void> {
  const url = resolveUrl(process.argv.slice(2));
  await runShim({ url, exitOnClose: true });
}

// Run as CLI only when invoked directly (node dist/shim.js), not when imported.
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  mainCli().catch((err) => {
    console.error(`[shim] fatal: ${errMessage(err)}`);
    process.exit(1);
  });
}
