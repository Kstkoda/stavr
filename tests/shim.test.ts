import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { EventStore } from '../src/persistence.js';
import { Broker } from '../src/broker.js';
import { mountTransports, type MountedTransports } from '../src/transports.js';
import { runShim, type ShimHandle } from '../src/shim.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Reads newline-delimited JSON-RPC messages from a Readable stream and waits
 * for a response matching `id`. Times out after `timeoutMs`.
 */
function readResponse(
  stream: PassThrough,
  id: number,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id === id) {
            cleanup();
            resolve(msg);
            return;
          }
        } catch {
          // Skip non-JSON / partial lines silently — shim should never emit them
          // but defensive parsing keeps the test from blowing up on a stray.
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for response id=${id}; buffer="${buf}"`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

describe('Spec 40 Phase 1b — stdio↔SSE shim', () => {
  let store: EventStore;
  let broker: Broker;
  let transports: MountedTransports;
  let daemonUrl: string;
  let shim: ShimHandle | undefined;
  let clientToShim: PassThrough;
  let shimToClient: PassThrough;

  beforeAll(async () => {
    store = new EventStore();
    store.init(':memory:');
    broker = new Broker(store);
    transports = await mountTransports(broker, { mode: 'daemon', port: 0, silent: true });
    const addr = transports.httpServer!.address() as AddressInfo;
    daemonUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    if (shim) await shim.shutdown(0, 'test teardown');
    await transports.shutdown();
  });

  it('proxies an initialize request through stdio → SSE → daemon → back', async () => {
    clientToShim = new PassThrough();
    shimToClient = new PassThrough();
    shim = await runShim({ url: daemonUrl, stdin: clientToShim, stdout: shimToClient });

    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'shim-test', version: '0.0.1' },
      },
    };
    const pending = readResponse(shimToClient, 1);
    clientToShim.write(JSON.stringify(initReq) + '\n');

    const res = await pending;
    expect(res.error, `unexpected error: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(res.result).toBeDefined();
    expect(res.result.serverInfo?.name).toBe('stavr');
    expect(res.result.protocolVersion).toBeTruthy();
  }, 15_000);

  it('proxies a tools/list request and returns the Switch tool catalogue', async () => {
    expect(shim, 'shim must be running from the previous test').toBeDefined();
    const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const pending = readResponse(shimToClient, 2);
    clientToShim.write(JSON.stringify(listReq) + '\n');

    const res = await pending;
    expect(res.error, `unexpected error: ${JSON.stringify(res.error)}`).toBeUndefined();
    const tools = res.result?.tools as Array<{ name: string }> | undefined;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools!.length).toBeGreaterThan(0);
    const names = tools!.map((t) => t.name);
    expect(names).toContain('emit_event');
    expect(names).toContain('subscribe_to_events');
  }, 15_000);
});
