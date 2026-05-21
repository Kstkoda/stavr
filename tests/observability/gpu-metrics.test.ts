import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registry } from '../../src/observability/metrics.js';
import {
  parsePromText,
  applyDcgmSample,
  scrapeDcgmOnce,
  DCGM_FI_DEV_GPU_UTIL,
  DCGM_FI_PROF_SM_ACTIVE,
  DCGM_FI_DEV_FB_USED,
  DCGM_FI_DEV_FB_FREE,
  DCGM_FI_DEV_GPU_TEMP,
  DCGM_FI_DEV_POWER_USAGE,
  DCGM_FI_PROF_NVLINK_TX_BYTES,
} from '../../src/observability/gpu-metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(resolve(here, 'fixtures', 'dcgm-sample.txt'), 'utf8');

describe('GPU metrics — Wave 4 catalog + parser', () => {
  it('exposes the canonical DCGM_FI_* gauge names on /metrics', async () => {
    const text = await registry.metrics();
    expect(text).toContain('DCGM_FI_DEV_GPU_UTIL');
    expect(text).toContain('DCGM_FI_PROF_SM_ACTIVE');
    expect(text).toContain('DCGM_FI_PROF_PIPE_TENSOR_ACTIVE');
    expect(text).toContain('DCGM_FI_DEV_MEM_COPY_UTIL');
    expect(text).toContain('DCGM_FI_PROF_DRAM_ACTIVE');
    expect(text).toContain('DCGM_FI_DEV_FB_USED');
    expect(text).toContain('DCGM_FI_DEV_FB_FREE');
    expect(text).toContain('DCGM_FI_DEV_GPU_TEMP');
    expect(text).toContain('DCGM_FI_DEV_MEMORY_TEMP');
    expect(text).toContain('DCGM_FI_DEV_POWER_USAGE');
    expect(text).toContain('DCGM_FI_DEV_CLOCK_THROTTLE_REASONS');
    expect(text).toContain('DCGM_FI_DEV_SM_CLOCK');
    expect(text).toContain('DCGM_FI_DEV_XID_ERRORS');
    expect(text).toContain('DCGM_FI_DEV_ECC_SBE_VOL_TOTAL');
    expect(text).toContain('DCGM_FI_DEV_ECC_DBE_VOL_TOTAL');
    expect(text).toContain('DCGM_FI_DEV_ROW_REMAP_PENDING');
    expect(text).toContain('DCGM_FI_DEV_ROW_REMAP_FAILURE');
    expect(text).toContain('DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS');
    expect(text).toContain('DCGM_FI_DEV_PCIE_REPLAY_COUNTER');
    expect(text).toContain('DCGM_FI_PROF_NVLINK_TX_BYTES');
    expect(text).toContain('DCGM_FI_PROF_NVLINK_RX_BYTES');
    expect(text).toContain('DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT');
    expect(text).toContain('DCGM_FI_PROF_PCIE_TX_BYTES');
    expect(text).toContain('DCGM_FI_PROF_PCIE_RX_BYTES');
    expect(text).toContain('DCGM_FI_DEV_THERMAL_VIOLATION');
    expect(text).toContain('DCGM_FI_DEV_POWER_VIOLATION');
  });
});

describe('parsePromText', () => {
  it('parses DCGM-shaped lines with labels + skips comments', () => {
    const samples = parsePromText(fixture);
    expect(samples.length).toBeGreaterThan(0);
    const gpuUtil0 = samples.find((s) => s.name === 'DCGM_FI_DEV_GPU_UTIL' && s.labels.gpu === '0' && !s.labels.pid);
    expect(gpuUtil0?.value).toBe(73);
    expect(gpuUtil0?.labels.host).toBe('vault');
  });

  it('captures the pid-labelled line so the apply step can decide to drop it', () => {
    const samples = parsePromText(fixture);
    const pidLine = samples.find((s) => s.name === 'DCGM_FI_DEV_GPU_UTIL' && s.labels.pid === '12345');
    expect(pidLine).toBeDefined();
  });
});

describe('applyDcgmSample', () => {
  it('feeds known DCGM metrics, drops unknown + pid-labelled lines', async () => {
    const samples = parsePromText(fixture);
    for (const s of samples) applyDcgmSample(s);

    const gpu0 = (await DCGM_FI_DEV_GPU_UTIL.get()).values.find(
      (v) => v.labels.gpu === '0' && v.labels.host === 'vault' && !v.labels.pid,
    );
    // Last applied value for gpu=0,host=vault is 73 — the pid="12345"
    // line (value 99) must NOT overwrite it.
    expect(gpu0?.value).toBe(73);

    const gpu1 = (await DCGM_FI_DEV_GPU_UTIL.get()).values.find(
      (v) => v.labels.gpu === '1' && v.labels.host === 'vault',
    );
    expect(gpu1?.value).toBe(12);

    expect((await DCGM_FI_PROF_SM_ACTIVE.get()).values.find((v) => v.labels.gpu === '0')?.value).toBe(0.81);
    expect((await DCGM_FI_DEV_FB_USED.get()).values.find((v) => v.labels.gpu === '0')?.value).toBe(14336);
    expect((await DCGM_FI_DEV_FB_FREE.get()).values.find((v) => v.labels.gpu === '0')?.value).toBe(9000);
    expect((await DCGM_FI_DEV_GPU_TEMP.get()).values.find((v) => v.labels.gpu === '0')?.value).toBe(71);
    expect((await DCGM_FI_DEV_POWER_USAGE.get()).values.find((v) => v.labels.gpu === '0')?.value).toBeCloseTo(312.5);
    expect((await DCGM_FI_PROF_NVLINK_TX_BYTES.get()).values.find(
      (v) => v.labels.gpu === '0' && v.labels.link === '0',
    )?.value).toBe(9876543210);
  });

  it('no pid-labelled DCGM_FI_DEV_GPU_UTIL row leaks into the gauge', async () => {
    const samples = parsePromText(fixture);
    for (const s of samples) applyDcgmSample(s);
    const leak = (await DCGM_FI_DEV_GPU_UTIL.get()).values.find((v) => 'pid' in v.labels);
    expect(leak).toBeUndefined();
  });
});

describe('scrapeDcgmOnce', () => {
  it('parses + applies a successful fixture response', async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(fixture, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    const out = await scrapeDcgmOnce('http://dcgm-fake:9400', fakeFetch, 1000);
    expect(out.ok).toBe(true);
    expect(out.sampleCount).toBeGreaterThan(0);
  });

  it('returns ok=false on http error and records a scrape failure', async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response('boom', { status: 503 })) as typeof fetch;
    const out = await scrapeDcgmOnce('http://dcgm-fake:9400', fakeFetch, 1000);
    expect(out.ok).toBe(false);
  });
});
