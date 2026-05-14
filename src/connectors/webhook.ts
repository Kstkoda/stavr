// src/connectors/webhook.ts
//
// First concrete Connector implementation. Wraps an arbitrary HTTP endpoint
// as a single-capability brick. Configurable URL, method, headers, auth
// method (none | bearer | basic | header), timeout, and retry policy.
//
// The capability id is `webhook_fire`. Args:
//   { body?: unknown, query?: Record<string, string>, headers?: Record<string, string> }
// Returns { status, headers, body, durationMs }.

import type {
  ConfigFieldSchema,
  Connector,
  ConnectorCapability,
  ConnectorStatus,
  ExecContext,
  ExecResult,
} from './index.js';

export type WebhookAuthMethod = 'none' | 'bearer' | 'basic' | 'header';

export interface WebhookConfig {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth_method?: WebhookAuthMethod;
  /**
   * Auth token / credential. For 'bearer' it's the raw token; for 'basic'
   * it's `user:password`; for 'header' it's the value of the header named
   * by `auth_header_name`. Stored encrypted via the credentials vault.
   */
  auth_value?: string;
  auth_header_name?: string;
  /** Extra static headers. */
  headers?: Record<string, string>;
  /** Per-call timeout in ms (default 30s). */
  timeout_ms?: number;
  /** Retry attempts on 5xx or network error (default 0). */
  retries?: number;
  /** Whether this brick requires individual approval per call. */
  requires_approval?: boolean;
}

export interface WebhookConnectorOpts {
  id?: string;
  displayName?: string;
  config?: WebhookConfig;
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  { key: 'url', label: 'Target URL', kind: 'url', required: true, hint: 'Full HTTPS(or HTTP) endpoint.' },
  {
    key: 'method',
    label: 'Method',
    kind: 'select',
    default: 'POST',
    options: [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' },
      { value: 'PUT', label: 'PUT' },
      { value: 'PATCH', label: 'PATCH' },
      { value: 'DELETE', label: 'DELETE' },
    ],
  },
  {
    key: 'auth_method',
    label: 'Authentication',
    kind: 'select',
    default: 'none',
    options: [
      { value: 'none', label: 'None' },
      { value: 'bearer', label: 'Bearer token' },
      { value: 'basic', label: 'HTTP Basic (user:pass)' },
      { value: 'header', label: 'Custom header' },
    ],
  },
  { key: 'auth_value', label: 'Auth value', kind: 'password', secret: true },
  { key: 'auth_header_name', label: 'Header name (for "Custom header")', kind: 'text' },
  { key: 'headers', label: 'Static headers', kind: 'headers' },
  { key: 'timeout_ms', label: 'Timeout (ms)', kind: 'number', default: 30000 },
  { key: 'retries', label: 'Retries on 5xx / network error', kind: 'number', default: 0 },
  { key: 'requires_approval', label: 'Require approval per call', kind: 'toggle', default: false },
];

const FIRE_CAPABILITY: ConnectorCapability = {
  id: 'webhook_fire',
  description: 'Send an HTTP request to the configured URL with optional body, query, and headers.',
  capabilityTag: 'no-model',
  riskClass: 'external-comm',
  argsSchema: [
    { key: 'body', label: 'Body', kind: 'json' },
    { key: 'query', label: 'Query parameters', kind: 'json' },
    { key: 'headers', label: 'Per-call headers', kind: 'json' },
  ],
  enabled: true,
};

export class WebhookConnector implements Connector {
  id: string;
  kind = 'webhook';
  displayName: string;
  position: 'above' | 'below' = 'above';
  logoPath: string | null = null;

  private cfg: WebhookConfig;
  private cachedStatus: ConnectorStatus;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WebhookConnectorOpts = {}) {
    this.id = opts.id ?? 'webhook';
    this.displayName = opts.displayName ?? 'Webhook';
    this.cfg = opts.config ?? { url: '' };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cachedStatus = this.cfg.url
      ? { kind: 'ok', detail: `configured for ${this.cfg.url}`, lastChecked: new Date().toISOString() }
      : { kind: 'needs_setup', detail: 'no URL configured', lastChecked: new Date().toISOString() };
  }

  configSchema(): ConfigFieldSchema[] {
    return CONFIG_SCHEMA;
  }

  async applyConfig(rawConfig: Record<string, unknown>): Promise<ConnectorStatus> {
    const url = String(rawConfig.url ?? '');
    if (!url) throw new Error('url is required');
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new Error(`invalid url: ${url}`);
    }
    this.cfg = {
      url,
      method: (rawConfig.method as WebhookConfig['method']) ?? 'POST',
      auth_method: (rawConfig.auth_method as WebhookAuthMethod) ?? 'none',
      auth_value: typeof rawConfig.auth_value === 'string' ? rawConfig.auth_value : undefined,
      auth_header_name: typeof rawConfig.auth_header_name === 'string' ? rawConfig.auth_header_name : undefined,
      headers: (rawConfig.headers as Record<string, string> | undefined) ?? {},
      timeout_ms: typeof rawConfig.timeout_ms === 'number' ? rawConfig.timeout_ms : DEFAULT_TIMEOUT_MS,
      retries: typeof rawConfig.retries === 'number' ? rawConfig.retries : 0,
      requires_approval: !!rawConfig.requires_approval,
    };
    this.cachedStatus = {
      kind: 'ok',
      detail: `configured for ${this.cfg.url}`,
      lastChecked: new Date().toISOString(),
    };
    return this.cachedStatus;
  }

  async testConnection(): Promise<ConnectorStatus> {
    if (!this.cfg.url) {
      const s: ConnectorStatus = {
        kind: 'needs_setup',
        detail: 'no URL configured',
        lastChecked: new Date().toISOString(),
      };
      this.cachedStatus = s;
      return s;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: 'OPTIONS',
        signal: ctrl.signal,
        headers: this.buildHeaders({}),
      });
      const ok = res.status >= 200 && res.status < 500;
      const s: ConnectorStatus = {
        kind: ok ? 'ok' : 'error',
        detail: ok ? `OPTIONS responded ${res.status}` : `OPTIONS failed with ${res.status}`,
        lastChecked: new Date().toISOString(),
      };
      this.cachedStatus = s;
      return s;
    } catch (err) {
      const s: ConnectorStatus = {
        kind: 'error',
        detail: (err as Error).message,
        lastChecked: new Date().toISOString(),
      };
      this.cachedStatus = s;
      return s;
    } finally {
      clearTimeout(timer);
    }
  }

  status(): ConnectorStatus {
    return this.cachedStatus;
  }

  capabilities(): ConnectorCapability[] {
    return [FIRE_CAPABILITY];
  }

  async exec(
    capabilityId: string,
    args: Record<string, unknown>,
    _ctx: ExecContext,
  ): Promise<ExecResult> {
    if (capabilityId !== 'webhook_fire') {
      return {
        ok: false,
        durationMs: 0,
        error: `unknown capability: ${capabilityId}`,
      };
    }
    if (!this.cfg.url) {
      return {
        ok: false,
        durationMs: 0,
        error: 'webhook connector not configured (missing url)',
      };
    }

    const timeoutMs = this.cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = (this.cfg.retries ?? 0) + 1;
    const url = appendQuery(this.cfg.url, args.query as Record<string, string> | undefined);
    const method = this.cfg.method ?? 'POST';
    const baseHeaders = this.buildHeaders(args.headers as Record<string, string> | undefined);

    let body: BodyInit | undefined;
    if (args.body !== undefined && method !== 'GET' && method !== 'DELETE') {
      body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      if (!baseHeaders['content-type']) baseHeaders['content-type'] = 'application/json';
    }

    let lastError: string | undefined;
    let lastStatus: number | undefined;
    const t0 = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: baseHeaders,
          body,
          signal: ctrl.signal,
        });
        const responseText = await res.text();
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const durationMs = Date.now() - t0;
        const ok = res.status >= 200 && res.status < 300;
        if (!ok && res.status >= 500 && attempt < maxAttempts) {
          lastStatus = res.status;
          lastError = `5xx response: ${res.status}`;
          continue;
        }
        return {
          ok,
          durationMs,
          data: { status: res.status, headers: responseHeaders, body: responseText },
          error: ok ? undefined : `HTTP ${res.status}: ${responseText.slice(0, 200)}`,
        };
      } catch (err) {
        lastError = (err as Error).name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : (err as Error).message;
        if (attempt >= maxAttempts) break;
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      durationMs: Date.now() - t0,
      error: lastError ?? `request failed${lastStatus !== undefined ? ` (last status ${lastStatus})` : ''}`,
    };
  }

  private buildHeaders(perCall?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {};
    // Lowercase keys for predictable merging.
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    for (const [k, v] of Object.entries(perCall ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const auth = this.cfg.auth_method ?? 'none';
    if (auth === 'bearer' && this.cfg.auth_value) {
      headers['authorization'] = `Bearer ${this.cfg.auth_value}`;
    } else if (auth === 'basic' && this.cfg.auth_value) {
      // auth_value expected as 'user:pass'
      headers['authorization'] = `Basic ${Buffer.from(this.cfg.auth_value).toString('base64')}`;
    } else if (auth === 'header' && this.cfg.auth_value && this.cfg.auth_header_name) {
      headers[this.cfg.auth_header_name.toLowerCase()] = this.cfg.auth_value;
    }
    return headers;
  }
}

// ============================================================
// HELPERS
// ============================================================

function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Convenience factory matching the BrickFactory signature so the sample
 * webhook brick can `export default makeWebhookConnector` and be installed
 * via the installer.
 */
export function makeWebhookConnector(opts: WebhookConnectorOpts = {}): WebhookConnector {
  return new WebhookConnector(opts);
}
