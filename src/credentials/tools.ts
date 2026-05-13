import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Broker } from '../broker.js';
import { toolError, toolJson } from '../server.js';
import {
  CredentialNotFoundError,
  CredentialNotGrantedError,
  CredentialRevokedError,
} from './types.js';
import type { CredentialStore } from './store.js';

const execFileP = promisify(execFile);

/**
 * Request descriptor — what the Steward wants to do with a credential. The
 * daemon attaches the secret behind the scenes; the Steward never sees the
 * underlying token.
 *
 * `request_signature` is a free-text label (logged in the event stream) that
 * answers "what call is this?" — e.g. "github_api:GET /repos/Kstkoda/cowire".
 * It also doubles as the spec's "verify the request matches the credential's
 * intended service shape" check: a github credential rejects a non-github
 * request_signature unless the User explicitly opted in via metadata.
 */
const RequestSignatureZ = z.string().min(1);

const HttpRequestZ = z.object({
  mode: z.literal('http'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
  /** Header name where the credential value is inserted. Default 'Authorization'. */
  auth_header: z.string().min(1).optional(),
  /** Prefix added in front of the secret value (default: "Bearer "). */
  auth_prefix: z.string().optional(),
});

const GhRequestZ = z.object({
  mode: z.literal('gh'),
  args: z.array(z.string()).min(1),
  stdin: z.string().optional(),
});

const RequestZ = z.discriminatedUnion('mode', [HttpRequestZ, GhRequestZ]);

export interface CredentialToolExecOpts {
  /** Injectable fetch implementation for tests. */
  fetch?: typeof fetch;
  /** Injectable exec implementation for tests. */
  exec?: (file: string, args: string[], opts: { input?: string; timeout: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
}

const GH_TIMEOUT_MS = 30_000;

function defaultExec(
  file: string,
  args: string[],
  opts: { input?: string; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: opts.timeout, env: opts.env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : (stdout as Buffer | undefined)?.toString() ?? '';
        const errStr = typeof stderr === 'string' ? stderr : (stderr as Buffer | undefined)?.toString() ?? '';
        if (err) {
          const e = err as Error & { stderr?: string };
          e.stderr = errStr;
          reject(e);
        } else resolve({ stdout: out, stderr: errStr });
      },
    );
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input);
  });
}

export function registerCredentialTools(
  server: McpServer,
  broker: Broker,
  store: CredentialStore,
  toolOpts: CredentialToolExecOpts = {},
): void {
  const httpFetch = toolOpts.fetch ?? fetch;
  const exec = toolOpts.exec ?? defaultExec;

  server.registerTool(
    'credential_use',
    {
      description:
        'Execute an upstream call using a stored credential. The daemon attaches the secret; the Steward never sees the underlying token. Captures request_signature + status in the event log.',
      inputSchema: {
        credential_id: z.string().min(1),
        request_signature: RequestSignatureZ,
        steward_session_id: z.string().optional(),
        request: RequestZ,
      },
    },
    async (args) => {
      const start = Date.now();
      try {
        const resolved = store.resolveForUse({
          credential_id: args.credential_id,
          steward_session_id: args.steward_session_id,
        });
        const expected = resolved.credential.service;
        if (!signatureMatchesService(args.request_signature, expected)) {
          return toolError(
            `request_signature "${args.request_signature}" does not match credential service "${expected}"`,
          );
        }

        let result: { ok: boolean; status?: number; body: unknown; stderr?: string };
        if (args.request.mode === 'http') {
          const headers: Record<string, string> = { ...(args.request.headers ?? {}) };
          const authHeader = args.request.auth_header ?? 'Authorization';
          const authPrefix = args.request.auth_prefix ?? 'Bearer ';
          headers[authHeader] = `${authPrefix}${resolved.plaintext}`;
          const init: RequestInit = {
            method: args.request.method,
            headers,
          };
          if (args.request.body !== undefined) {
            init.body =
              typeof args.request.body === 'string'
                ? args.request.body
                : JSON.stringify(args.request.body);
            if (typeof args.request.body !== 'string' && !headers['Content-Type']) {
              headers['Content-Type'] = 'application/json';
            }
          }
          const res = await httpFetch(args.request.url, init);
          const text = await res.text();
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* leave as text */
          }
          result = { ok: res.ok, status: res.status, body };
        } else {
          // mode: gh
          const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: resolved.plaintext };
          try {
            const { stdout, stderr } = await exec('gh', args.request.args, {
              input: args.request.stdin,
              timeout: GH_TIMEOUT_MS,
              env,
            });
            result = { ok: true, body: stdout, stderr };
          } catch (err) {
            const e = err as Error & { stderr?: string };
            result = { ok: false, body: e.message, stderr: e.stderr };
          }
        }

        store.recordUse(args.credential_id);
        if (resolved.grant.uses_remaining !== undefined) {
          store.consumeGrantUse(resolved.grant.id);
        }
        await broker.publish({
          kind: 'credential_used',
          at: new Date().toISOString(),
          source_agent: args.steward_session_id ?? 'unknown',
          payload: {
            credential_id: args.credential_id,
            service: resolved.credential.service,
            request_signature: args.request_signature,
            status: result.ok ? 'success' : 'error',
            steward_session_id: args.steward_session_id,
            duration_ms: Date.now() - start,
            error_message: result.ok ? undefined : String(result.body).slice(0, 500),
          },
        });
        return toolJson({
          ok: result.ok,
          status: result.status,
          body: result.body,
          stderr: result.stderr,
        });
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          return toolError(`CredentialNotFoundError: ${err.message}`);
        }
        if (err instanceof CredentialRevokedError) {
          return toolError(`CredentialRevokedError: ${err.message}`);
        }
        if (err instanceof CredentialNotGrantedError) {
          return toolError(`CredentialNotGrantedError: ${err.message}`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'credential_list',
    {
      description: 'List stored credentials (no secrets). Tier: auto.',
      inputSchema: {
        service: z.string().optional(),
        include_revoked: z.boolean().optional(),
      },
    },
    async (args) => {
      const list = store.list({ service: args.service, includeRevoked: args.include_revoked });
      return toolJson({ credentials: list });
    },
  );

  server.registerTool(
    'credential_revoke',
    {
      description: 'Revoke a credential immediately. Emits credential_revoked.',
      inputSchema: {
        credential_id: z.string().min(1),
        revoked_by: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const rec = store.revoke(args.credential_id, args.revoked_by);
        await broker.publish({
          kind: 'credential_revoked',
          at: new Date().toISOString(),
          source_agent: args.revoked_by,
          payload: {
            credential_id: rec.id,
            service: rec.service,
            revoked_by: args.revoked_by,
          },
        });
        return toolJson({ ok: true, credential_id: rec.id, revoked_at: rec.revoked_at });
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          return toolError(`CredentialNotFoundError: ${err.message}`);
        }
        throw err;
      }
    },
  );
}

/**
 * Loose service-shape check: the request_signature must mention the service
 * (case-insensitive) somewhere, OR be of the form "<service>:..." or
 * "<service>_..." or "<service>.<verb>". Catches obvious mismatches like
 * "anthropic_api" using a github credential.
 */
function signatureMatchesService(signature: string, service: string): boolean {
  const lower = signature.toLowerCase();
  const svc = service.toLowerCase();
  return lower.startsWith(svc + ':') || lower.startsWith(svc + '_') ||
    lower.startsWith(svc + '.') || lower.startsWith(svc + ' ') ||
    lower.includes(`/${svc}/`) || lower.includes(`.${svc}.`) ||
    lower === svc;
}

export { signatureMatchesService };
