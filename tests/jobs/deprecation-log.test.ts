/**
 * tests/jobs/deprecation-log.test.ts — Phase 3b deprecation-log helper.
 *
 * Each call to a legacy worker_* MCP tool emits one console.warn line
 * naming the canonical job_* replacement and citing the shared
 * DEPRECATION_WINDOW_RELEASES constant. Tests pin the message format
 * (the daemon log scraper greps for `[deprecated]`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logToolDeprecation } from '../../src/jobs/deprecation-log.js';
import { DEPRECATION_WINDOW_RELEASES } from '../../src/event-types.js';

describe('logToolDeprecation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one [deprecated] line naming the canonical replacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logToolDeprecation('worker_spawn');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0].join(' ');
    expect(msg).toContain('[deprecated]');
    expect(msg).toContain("'worker_spawn'");
    expect(msg).toContain("'job_dispatch'");
    expect(msg).toContain(`${DEPRECATION_WINDOW_RELEASES} release`);
  });

  it.each([
    ['worker_list_types', 'job_list_bindings'],
    ['worker_list', 'job_list'],
    ['worker_status', 'job_status'],
    ['worker_spawn', 'job_dispatch'],
    ['worker_dispatch', 'job_inject'],
    ['worker_terminate', 'job_terminate'],
  ])('routes %s → %s in the deprecation log', (legacy, canonical) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logToolDeprecation(legacy);
    const msg = warn.mock.calls[0].join(' ');
    expect(msg).toContain(`'${legacy}'`);
    expect(msg).toContain(`'${canonical}'`);
  });

  it('is a no-op for tools outside the alias table', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logToolDeprecation('host_exec');
    logToolDeprecation('emit_event');
    logToolDeprecation('something_unrelated');
    expect(warn).not.toHaveBeenCalled();
  });
});
