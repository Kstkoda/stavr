// src/observability/gpu-metrics.ts
//
// Layer 2 (GPU / DCGM) metrics — scrapes the NVIDIA DCGM exporter and
// republishes the values under their canonical `DCGM_FI_*` names on stavR's
// own /metrics. Spec: proposed/observability-metrics-spec.md — Layer 2.
// BOM: proposed/observability-instrumentation-bom.md — Wave 4.
//
// Architecture
// ------------
// We don't run DCGM ourselves — operators with NVIDIA GPUs deploy the
// `dcgm-exporter` container or systemd unit alongside their LLM runtimes.
// stavR's job (per the spec) is to make those metrics visible on the same
// /metrics endpoint that the dashboard already scrapes, so the operator
// doesn't have to wire two Prometheus targets just to see "is the GPU
// healthy?"
//
// The poller is opt-in: it only runs when STAVR_DCGM_EXPORTER_URL is set
// (e.g. http://127.0.0.1:9400). When unset the metrics are still REGISTERED
// — the Diagnostics page renders them with a "not wired yet" chip per
// spec. When set, every `pollIntervalMs` (default 15s) we GET
// `${url}/metrics`, parse the Prom text format, and update the matching
// gauges via `.set()`.
//
// CI / no-GPU environments
// ------------------------
// The BOM explicitly allows fixture-based testing — the scraper takes a
// `fetchImpl` test seam. `tests/observability/fixtures/dcgm-sample.txt`
// is a redacted dcgm-exporter response that the unit test feeds the
// parser to assert end-to-end wiring.
//
// Cardinality discipline (BOM Rule 2)
// ----------------------------------
// `gpu` is bounded by the number of physical GPUs on the host (typically
// 1–8). `link` is bounded by NVLink count per GPU. `pid` IS unbounded
// in principle (every process that uses the GPU), so we DO NOT register
// gpu_process_memory_bytes today — it stays as a documented forward
// target until we can either (a) restrict to a known set of pids
// (`ollama`, `vllm`, `text-generation-inference`) or (b) report by
// container-name rather than raw pid. Same posture as
// telemetry-pipeline's tsdb_active_series watching.

import { Gauge } from 'prom-client';
import { registry } from './metrics.js';
import { getLogger } from '../log.js';
import { recordScrapeFailure } from './telemetry-pipeline.js';

function makeGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

// ---- The DCGM catalog. One Gauge per spec row.
// We keep canonical DCGM_FI_* names — operators recognize them on sight,
// and prom-client accepts `_FI_` underscores fine.

export const DCGM_FI_DEV_GPU_UTIL = makeGauge(
  'DCGM_FI_DEV_GPU_UTIL',
  'GPU SM utilization 0..100 (DCGM canonical). Info; low on a paid GPU = waste.',
  ['gpu', 'host'],
);
export const DCGM_FI_PROF_SM_ACTIVE = makeGauge(
  'DCGM_FI_PROF_SM_ACTIVE',
  'SM active ratio 0..1 (DCGM canonical). Low = pipeline stall.',
  ['gpu'],
);
export const DCGM_FI_PROF_PIPE_TENSOR_ACTIVE = makeGauge(
  'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE',
  'Tensor-pipe active ratio (DCGM canonical). Productive ML work indicator.',
  ['gpu'],
);
export const DCGM_FI_DEV_MEM_COPY_UTIL = makeGauge(
  'DCGM_FI_DEV_MEM_COPY_UTIL',
  'Memory copy utilization 0..100 (DCGM canonical). Info.',
  ['gpu'],
);
export const DCGM_FI_PROF_DRAM_ACTIVE = makeGauge(
  'DCGM_FI_PROF_DRAM_ACTIVE',
  'DRAM active ratio (DCGM canonical). High = memory-bandwidth bound.',
  ['gpu'],
);
export const DCGM_FI_DEV_FB_USED = makeGauge(
  'DCGM_FI_DEV_FB_USED',
  'Frame-buffer (VRAM) used in MiB (DCGM canonical).',
  ['gpu'],
);
export const DCGM_FI_DEV_FB_FREE = makeGauge(
  'DCGM_FI_DEV_FB_FREE',
  'Frame-buffer (VRAM) free in MiB (DCGM canonical). Page <5% of total.',
  ['gpu'],
);
export const DCGM_FI_DEV_GPU_TEMP = makeGauge(
  'DCGM_FI_DEV_GPU_TEMP',
  'GPU temperature celsius (DCGM canonical). Warn >85°C.',
  ['gpu'],
);
export const DCGM_FI_DEV_MEMORY_TEMP = makeGauge(
  'DCGM_FI_DEV_MEMORY_TEMP',
  'GPU memory temperature celsius (DCGM canonical). Warn >95°C (HBM).',
  ['gpu'],
);
export const DCGM_FI_DEV_POWER_USAGE = makeGauge(
  'DCGM_FI_DEV_POWER_USAGE',
  'GPU power draw in watts (DCGM canonical). Warn sustained near cap.',
  ['gpu'],
);
export const DCGM_FI_DEV_CLOCK_THROTTLE_REASONS = makeGauge(
  'DCGM_FI_DEV_CLOCK_THROTTLE_REASONS',
  'GPU clock-throttle reason bitmask (DCGM canonical). Warn on thermal/power throttle bits.',
  ['gpu'],
);
export const DCGM_FI_DEV_SM_CLOCK = makeGauge(
  'DCGM_FI_DEV_SM_CLOCK',
  'SM clock in MHz (DCGM canonical). Warn drop below base clock.',
  ['gpu'],
);
export const DCGM_FI_DEV_XID_ERRORS = makeGauge(
  'DCGM_FI_DEV_XID_ERRORS',
  'XID error code (DCGM canonical). Page on any.',
  ['gpu'],
);
export const DCGM_FI_DEV_ECC_SBE_VOL_TOTAL = makeGauge(
  'DCGM_FI_DEV_ECC_SBE_VOL_TOTAL',
  'Single-bit ECC errors total (DCGM canonical). Warn on rising trend.',
  ['gpu'],
);
export const DCGM_FI_DEV_ECC_DBE_VOL_TOTAL = makeGauge(
  'DCGM_FI_DEV_ECC_DBE_VOL_TOTAL',
  'Double-bit ECC errors total (DCGM canonical). Page on any increase.',
  ['gpu'],
);
export const DCGM_FI_DEV_ROW_REMAP_PENDING = makeGauge(
  'DCGM_FI_DEV_ROW_REMAP_PENDING',
  'Row remap pending count (DCGM canonical). Warn >0.',
  ['gpu'],
);
export const DCGM_FI_DEV_ROW_REMAP_FAILURE = makeGauge(
  'DCGM_FI_DEV_ROW_REMAP_FAILURE',
  'Row remap failure count (DCGM canonical). Page >0 (RMA the GPU).',
  ['gpu'],
);
export const DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS = makeGauge(
  'DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS',
  'Uncorrectable remapped rows count (DCGM canonical). Page on any increase.',
  ['gpu'],
);
export const DCGM_FI_DEV_PCIE_REPLAY_COUNTER = makeGauge(
  'DCGM_FI_DEV_PCIE_REPLAY_COUNTER',
  'PCIe replay counter (DCGM canonical). Warn on increase.',
  ['gpu'],
);
export const DCGM_FI_PROF_NVLINK_TX_BYTES = makeGauge(
  'DCGM_FI_PROF_NVLINK_TX_BYTES',
  'NVLink TX bytes (DCGM canonical). Capacity tracking.',
  ['gpu', 'link'],
);
export const DCGM_FI_PROF_NVLINK_RX_BYTES = makeGauge(
  'DCGM_FI_PROF_NVLINK_RX_BYTES',
  'NVLink RX bytes (DCGM canonical). Capacity tracking.',
  ['gpu', 'link'],
);
export const DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT = makeGauge(
  'DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT',
  'NVLink CRC flit error count (DCGM canonical). Warn on increase.',
  ['gpu', 'link'],
);
export const DCGM_FI_PROF_PCIE_TX_BYTES = makeGauge(
  'DCGM_FI_PROF_PCIE_TX_BYTES',
  'PCIe TX bytes (DCGM canonical). Capacity tracking.',
  ['gpu'],
);
export const DCGM_FI_PROF_PCIE_RX_BYTES = makeGauge(
  'DCGM_FI_PROF_PCIE_RX_BYTES',
  'PCIe RX bytes (DCGM canonical). Capacity tracking.',
  ['gpu'],
);
export const DCGM_FI_DEV_THERMAL_VIOLATION = makeGauge(
  'DCGM_FI_DEV_THERMAL_VIOLATION',
  'Thermal violation count (DCGM canonical). Warn on increase.',
  ['gpu'],
);
export const DCGM_FI_DEV_POWER_VIOLATION = makeGauge(
  'DCGM_FI_DEV_POWER_VIOLATION',
  'Power violation count (DCGM canonical). Warn on increase.',
  ['gpu'],
);

// ---- Map from DCGM metric name → gauge instance. Lookup table for the
// parser. Adding a row above means adding it here.

const GAUGE_BY_NAME: Record<string, Gauge<string>> = {
  DCGM_FI_DEV_GPU_UTIL,
  DCGM_FI_PROF_SM_ACTIVE,
  DCGM_FI_PROF_PIPE_TENSOR_ACTIVE,
  DCGM_FI_DEV_MEM_COPY_UTIL,
  DCGM_FI_PROF_DRAM_ACTIVE,
  DCGM_FI_DEV_FB_USED,
  DCGM_FI_DEV_FB_FREE,
  DCGM_FI_DEV_GPU_TEMP,
  DCGM_FI_DEV_MEMORY_TEMP,
  DCGM_FI_DEV_POWER_USAGE,
  DCGM_FI_DEV_CLOCK_THROTTLE_REASONS,
  DCGM_FI_DEV_SM_CLOCK,
  DCGM_FI_DEV_XID_ERRORS,
  DCGM_FI_DEV_ECC_SBE_VOL_TOTAL,
  DCGM_FI_DEV_ECC_DBE_VOL_TOTAL,
  DCGM_FI_DEV_ROW_REMAP_PENDING,
  DCGM_FI_DEV_ROW_REMAP_FAILURE,
  DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS,
  DCGM_FI_DEV_PCIE_REPLAY_COUNTER,
  DCGM_FI_PROF_NVLINK_TX_BYTES,
  DCGM_FI_PROF_NVLINK_RX_BYTES,
  DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT,
  DCGM_FI_PROF_PCIE_TX_BYTES,
  DCGM_FI_PROF_PCIE_RX_BYTES,
  DCGM_FI_DEV_THERMAL_VIOLATION,
  DCGM_FI_DEV_POWER_VIOLATION,
};

// ---- Parser.

/**
 * Parse Prometheus text-format output and return one row per sample line.
 * We skip `# HELP` / `# TYPE` comments and blank lines. The shape DCGM
 * emits is `METRIC_NAME{labelKey="labelVal",...} value [timestamp]`.
 */
export interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parsePromText(text: string): ParsedSample[] {
  const out: ParsedSample[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Match: name{labels} value [timestamp]
    // or:    name value [timestamp]
    const braceIdx = line.indexOf('{');
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (braceIdx === -1) {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    } else {
      name = line.slice(0, braceIdx);
      const closeIdx = line.indexOf('}', braceIdx);
      if (closeIdx === -1) continue;
      const labelSection = line.slice(braceIdx + 1, closeIdx);
      labels = parsePromLabels(labelSection);
      rest = line.slice(closeIdx + 1).trim();
    }
    // rest = "value [timestamp]". Take the first whitespace-delimited token.
    const valTok = rest.split(/\s+/, 1)[0];
    const num = Number(valTok);
    if (!Number.isFinite(num)) continue;
    out.push({ name, labels, value: num });
  }
  return out;
}

function parsePromLabels(section: string): Record<string, string> {
  const labels: Record<string, string> = {};
  // Naive but robust enough for DCGM output: split on `,` but only outside
  // of quoted values. DCGM doesn't put commas in label values today.
  let i = 0;
  while (i < section.length) {
    const eq = section.indexOf('=', i);
    if (eq === -1) break;
    const key = section.slice(i, eq).trim();
    if (section[eq + 1] !== '"') break;
    let end = eq + 2;
    while (end < section.length) {
      if (section[end] === '\\' && end + 1 < section.length) {
        end += 2;
        continue;
      }
      if (section[end] === '"') break;
      end++;
    }
    const value = section.slice(eq + 2, end).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    labels[key] = value;
    // Advance past closing quote + optional comma
    i = end + 1;
    if (section[i] === ',') i++;
    while (i < section.length && section[i] === ' ') i++;
  }
  return labels;
}

/**
 * Apply a parsed sample to our registry. Looks up the gauge by name; if
 * found and the sample's labels include the gauge's required labelNames,
 * sets the value. Unknown DCGM metrics are silently dropped — adding a
 * new DCGM_FI_* row above is the way to surface them.
 */
export function applyDcgmSample(s: ParsedSample): void {
  const g = GAUGE_BY_NAME[s.name];
  if (!g) return;
  // We don't know which labelNames the gauge declares without inspecting
  // it, so just pass through whatever DCGM gave us — prom-client will
  // ignore extras and complain about missing required labels by setting
  // them to "". Construct a label-tuple in the gauge's declared order.
  const labelNames = (g as unknown as { labelNames: string[] }).labelNames;
  const values: string[] = labelNames.map((n) => s.labels[n] ?? '');
  // Cardinality guard: never let a DCGM line with a pid or container label
  // leak into our labelled gauge — the spec explicitly leaves
  // gpu_process_memory_bytes unwired for this reason. If a future DCGM
  // version starts attaching pid to its core gauges, bail early.
  if ('pid' in s.labels || 'process' in s.labels) return;
  try { g.labels(...values).set(s.value); } catch { /* metrics never throw */ }
}

// ---- Poller.

export interface DcgmPollerOpts {
  /** Endpoint base, e.g. `http://127.0.0.1:9400`. When undefined, the
   *  STAVR_DCGM_EXPORTER_URL env var is read. */
  endpoint?: string;
  /** Poll interval in ms. Default 15s. */
  pollIntervalMs?: number;
  /** Per-request timeout in ms. Default 5s. */
  fetchTimeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export type DcgmPollerStop = () => void;

export async function scrapeDcgmOnce(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 5_000,
): Promise<{ ok: boolean; sampleCount: number; error?: string }> {
  const url = `${endpoint.replace(/\/+$/, '')}/metrics`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) {
      recordScrapeFailure('dcgm');
      return { ok: false, sampleCount: 0, error: `http ${res.status}` };
    }
    const text = await res.text();
    const samples = parsePromText(text);
    let applied = 0;
    for (const s of samples) {
      if (GAUGE_BY_NAME[s.name]) {
        applyDcgmSample(s);
        applied++;
      }
    }
    return { ok: true, sampleCount: applied };
  } catch (err) {
    recordScrapeFailure('dcgm');
    return { ok: false, sampleCount: 0, error: (err as Error).message };
  } finally {
    clearTimeout(to);
  }
}

export function startDcgmPoller(opts: DcgmPollerOpts = {}): DcgmPollerStop | null {
  const endpoint = opts.endpoint ?? process.env.STAVR_DCGM_EXPORTER_URL;
  if (!endpoint) {
    getLogger().info('DCGM exporter URL not set — GPU metrics unwired', {
      hint: 'set STAVR_DCGM_EXPORTER_URL=http://127.0.0.1:9400 to enable',
    });
    return null;
  }
  const intervalMs = opts.pollIntervalMs ?? 15_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 5_000;

  // First scrape is fire-and-forget — don't block start.
  void scrapeDcgmOnce(endpoint, fetchImpl, fetchTimeoutMs);

  const handle: ReturnType<typeof setInterval> = setInterval(() => {
    void scrapeDcgmOnce(endpoint, fetchImpl, fetchTimeoutMs);
  }, intervalMs);
  handle.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { clearInterval(handle); } catch { /* best effort */ }
  };
}
