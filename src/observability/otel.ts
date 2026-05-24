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
import { getLogger } from '../log.js';
import { STAVR_VERSION } from '../version.generated.js';

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

// Bombardment Phase 0 — version is baked at build time from
// package.json#version (see scripts/generate-version.mjs). Pre-fix this
// walked up to find package.json on disk and fell back to
// STAVR_VERSION env / '0.0.0'; the walk fails in the SEA bundle and
// the env var is never populated, so OTel's `service.version`
// resource attribute reported '0.0.0' on every SEA / sidecar /
// Windows Service launch path.

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
      [ATTR_SERVICE_VERSION]: STAVR_VERSION,
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
