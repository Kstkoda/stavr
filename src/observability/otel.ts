// src/observability/otel.ts
//
// OpenTelemetry SDK bootstrap. Spec: bom-diagnostics-2026.md C2.2.
//
// Disabled by default. Enabled when `STAVR_OTEL_EXPORTER_OTLP_ENDPOINT`
// is set, at which point the daemon starts a NodeSDK with the OTLP/HTTP
// trace exporter pointed at that endpoint. Operator brings their own
// collector (Jaeger, Tempo, or anything that speaks OTLP/HTTP).
//
// Custom spans created elsewhere (BomExecutor invoke_agent, per-step
// execute_tool, worker subprocess, MCP request attributes, broker event
// addEvent) follow the OTel GenAI/MCP semantic conventions
// (`gen_ai.*`, `gen_ai.mcp.*`). Set
// `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` to ensure
// any downstream OTel libs that emit GenAI attributes use the latest
// names; stavr's own helpers use the latest names regardless.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { BatchSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLogger } from '../log.js';

export const STAVR_SERVICE_NAME = 'stavr';

export interface StartOtelOpts {
  /** Override `process.env` lookup. Test seam. */
  env?: NodeJS.ProcessEnv;
  /** Inject an in-memory span exporter (tests). When set, this exporter is
   *  used unconditionally, ignoring the OTLP endpoint env var. */
  exporter?: SpanExporter;
  /** Inject an in-memory span processor (tests). When set, this processor is
   *  used unconditionally — exporter and OTLP env vars are ignored. */
  spanProcessor?: SpanProcessor;
}

export interface StartedOtel {
  sdk: NodeSDK;
  shutdown: () => Promise<void>;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../../../package.json']) {
      try {
        const raw = readFileSync(resolve(here, rel), 'utf8');
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }
  return process.env.STAVR_VERSION ?? '0.0.0';
}

export function startOtel(opts: StartOtelOpts = {}): StartedOtel | null {
  const env = opts.env ?? process.env;
  const endpoint = env.STAVR_OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const haveExplicitExporter = !!(opts.exporter || opts.spanProcessor);

  if (!endpoint && !haveExplicitExporter) {
    getLogger().info('OTel exporter endpoint not set — traces disabled', {
      hint: 'set STAVR_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 to enable',
    });
    return null;
  }

  const processor: SpanProcessor =
    opts.spanProcessor ??
    new BatchSpanProcessor(
      opts.exporter ??
        new OTLPTraceExporter({
          url: `${endpoint!.replace(/\/$/, '')}/v1/traces`,
        }),
    );

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: STAVR_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: readPackageVersion(),
    }),
    spanProcessors: [processor],
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();

  getLogger().info('OTel SDK started', {
    endpoint: endpoint ?? '(injected exporter)',
    service: STAVR_SERVICE_NAME,
  });

  return {
    sdk,
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch (err) {
        getLogger().warn('OTel SDK shutdown raised', { error: (err as Error).message });
      }
    },
  };
}
