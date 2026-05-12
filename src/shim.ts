#!/usr/bin/env node
/**
 * Stdio→SSE shim. Speaks stdio downward (to an MCP client that only supports
 * stdio entries in its config — current Cowork builds, for example) and SSE
 * upward (to a Switch daemon). Forwards JSON-RPC messages byte-for-byte; does
 * not parse or interpret them.
 *
 * Config: COWIRE_DAEMON_URL env var (default http://127.0.0.1:7777/mcp/sse),
 * overridable per-invocation via `--url <url>`.
 */
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_URL = 'http://127.0.0.1:7777/mcp/sse';

export interface RunShimOptions {
  url: string;
  stdin?: Readable;
  stdout?: Writable;
  /** When set, runShim resolves once both transports are connected instead of
   *  running until exit. The returned handle exposes shutdown(). For tests. */
  exitOnClose?: boolean;
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
  return process.env.COWIRE_DAEMON_URL ?? DEFAULT_URL;
}

export async function runShim(opts: RunShimOptions): Promise<ShimHandle> {
  const stdio = new StdioServerTransport(opts.stdin, opts.stdout);
  const sse = new SSEClientTransport(new URL(opts.url));

  let closed = false;
  const shutdown = async (code = 0, reason = 'shutdown'): Promise<void> => {
    if (closed) return;
    closed = true;
    console.error(`[shim] closing: ${reason}`);
    if (opts.exitOnClose) process.exitCode = code;
    await Promise.allSettled([sse.close(), stdio.close()]);
    // Don't call process.exit() — on Windows it races EventSource's libuv
    // handle teardown and trips `Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING)`. Setting exitCode and letting the event loop drain
    // naturally is sufficient: once stdio listeners detach and the SSE
    // abort propagates, no handles keep Node alive.
  };

  stdio.onmessage = (msg: JSONRPCMessage) => {
    sse.send(msg).catch((err) => {
      console.error(`[shim] forward stdio→sse failed: ${errMessage(err)}`);
    });
  };
  sse.onmessage = (msg: JSONRPCMessage) => {
    stdio.send(msg).catch((err) => {
      console.error(`[shim] forward sse→stdio failed: ${errMessage(err)}`);
    });
  };

  stdio.onclose = () => {
    void shutdown(0, 'stdin closed');
  };
  stdio.onerror = (err) => console.error(`[shim] stdio error: ${errMessage(err)}`);

  sse.onclose = () => {
    void shutdown(1, 'daemon disconnected');
  };
  // The underlying EventSource auto-reconnects on transient errors, which is
  // fine while the daemon is up. But when the daemon goes down for good we
  // need to fail fast so Cowork sees a non-zero exit instead of hanging on a
  // shim that's spinning ECONNREFUSED. Treat repeated errors as terminal.
  let sseErrorCount = 0;
  const SSE_ERROR_THRESHOLD = 3;
  sse.onerror = (err) => {
    sseErrorCount += 1;
    console.error(`[shim] sse error (${sseErrorCount}/${SSE_ERROR_THRESHOLD}): ${errMessage(err)}`);
    if (sseErrorCount >= SSE_ERROR_THRESHOLD) {
      void shutdown(1, 'daemon unreachable after repeated SSE errors');
    }
  };

  // Connect to the daemon first; if that fails the client sees a missing
  // server rather than a server that silently swallows requests.
  await sse.start();
  console.error(`[shim] connected to ${opts.url}`);
  await stdio.start();
  console.error('[shim] stdio bridge ready');

  // StdioServerTransport.close() is only triggered when *we* call it; it does
  // not propagate stdin EOF on its own. Watch for 'end' here so the parent
  // closing our stdin causes a clean exit. We watch the underlying stream we
  // were handed (process.stdin by default, or the test's PassThrough).
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
