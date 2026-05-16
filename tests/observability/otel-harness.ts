// Shared OTel test harness — registers exactly one NodeSDK / InMemorySpanExporter
// for the lifetime of the test process. OTel's `trace.setGlobalTracerProvider`
// only honours the first registration, so per-test SDK boots cause silent
// no-ops in the tracer. This singleton avoids that.
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { startOtel, type StartedOtel } from '../../src/observability/otel.js';

export interface SharedOtelHarness {
  exporter: InMemorySpanExporter;
  processor: SimpleSpanProcessor;
  otel: StartedOtel;
  /** Await pending span exports — SimpleSpanProcessor.onEnd defers _doExport
   *  through one async hop, so a synchronous getFinishedSpans() right after
   *  span.end() may race. Call this before asserting on the exporter. */
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

let shared: SharedOtelHarness | undefined;
let shutdownPromise: Promise<void> | undefined;

export function getSharedOtelHarness(): SharedOtelHarness {
  if (shared) return shared;
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const otel = startOtel({ spanProcessor: processor });
  if (!otel) throw new Error('startOtel returned null with explicit processor');
  shared = {
    exporter,
    processor,
    otel,
    flush: () => processor.forceFlush(),
    shutdown: async () => {
      shutdownPromise ??= otel.shutdown();
      await shutdownPromise;
    },
  };
  return shared;
}
