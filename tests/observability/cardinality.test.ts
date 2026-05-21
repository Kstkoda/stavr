// tests/observability/cardinality.test.ts
//
// BOM observability-instrumentation Wave 0 — Rule 2 (cardinality discipline).
//
// This test is intentionally simple and harsh: it walks every metric registered
// on the process-wide prom-client Registry and fails if any of them declared
// an unbounded-cardinality label name. Adding a forbidden label here breaks
// the build, which is the point — Prometheus TSDBs fall over when a label
// value is per-request, per-user, or per-session.
//
// Forbidden list comes from the spec
// (proposed/observability-metrics-spec.md "Two rules that override individual
// thresholds" §2). If the project ever adds a label that's actually bounded
// but happens to share a forbidden name (e.g. an enum literally called
// `session_id` with 4 values), the right move is to rename the label, not to
// special-case this test.

import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
// Side-effect imports — force every metric-emitting module to register its
// metrics on the shared registry so the walk below covers them.
import '../../src/observability/event-loop.js';
import '../../src/observability/slo.js';
import '../../src/observability/telemetry-pipeline.js';
import '../../src/observability/mcp-metrics.js';
import '../../src/observability/host-metrics.js';

const FORBIDDEN_LABEL_NAMES = new Set([
  'request_id',
  'user_id',
  'session_id',
  'trace_id',
  'span_id',
  'correlation_id',
]);

describe('metric label cardinality', () => {
  it('no registered metric declares an unbounded-cardinality label', async () => {
    const all = await registry.getMetricsAsJSON();
    expect(all.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const m of all) {
      // prom-client typings on `getMetricsAsJSON()` declare `values` but the
      // label-name list lives on the registered metric. The JSON form
      // exposes label names via the value rows themselves; we also pull
      // from the metric object via `registry.getSingleMetric()` to catch
      // labels that have not had any rows recorded yet.
      const single = registry.getSingleMetric(m.name);
      const labelNames = new Set<string>();
      // Walk all sampled rows.
      for (const v of (m as { values?: Array<{ labels?: Record<string, unknown> }> }).values ?? []) {
        for (const k of Object.keys(v.labels ?? {})) labelNames.add(k);
      }
      // Walk declared labelNames from the metric object (catches yet-unsampled labels).
      const declared = (single as unknown as { labelNames?: string[] })?.labelNames;
      if (Array.isArray(declared)) for (const n of declared) labelNames.add(n);
      for (const name of labelNames) {
        if (FORBIDDEN_LABEL_NAMES.has(name)) {
          violations.push(`${m.name} declares forbidden label "${name}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
