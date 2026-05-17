import { describe, expect, it } from 'vitest';
import { loadChannelStatuses } from '../../../src/dashboard/data/channels.js';
import type { ChannelStatus } from '../../../src/notify/types.js';

function makeNotifier(statuses: ChannelStatus[]): { getChannelStatus(): ChannelStatus[] } {
  return { getChannelStatus: () => statuses };
}

describe('v0.6 loadChannelStatuses', () => {
  it('returns [] when notifier is undefined', () => {
    expect(loadChannelStatuses(undefined)).toEqual([]);
  });

  it("maps configured + recent success to 'configured'", () => {
    const now = 100_000_000;
    const v = loadChannelStatuses(
      makeNotifier([
        { id: 'ntfy', configured: true, enabled: true, lastSuccessAt: now - 60_000 },
      ]),
      () => now,
    );
    expect(v).toHaveLength(1);
    expect(v[0].effectiveStatus).toBe('configured');
    expect(v[0].label).toBe('ntfy.sh');
    expect(v[0].docAnchor).toBe('#ntfy');
  });

  it("maps configured + stale last_success (>24h) to 'configured_stale'", () => {
    const now = 100_000_000_000;
    const v = loadChannelStatuses(
      makeNotifier([
        { id: 'email', configured: true, enabled: true, lastSuccessAt: now - 30 * 60 * 60 * 1000 },
      ]),
      () => now,
    );
    expect(v[0].effectiveStatus).toBe('configured_stale');
    expect(v[0].label).toBe('Email (SMTP)');
  });

  it("maps configured + never-succeeded to 'configured_stale'", () => {
    const v = loadChannelStatuses(
      makeNotifier([{ id: 'telegram', configured: true, enabled: true }]),
      () => 1_000,
    );
    expect(v[0].effectiveStatus).toBe('configured_stale');
  });

  it("maps not-configured to 'not_set' even with stale last_success", () => {
    const v = loadChannelStatuses(
      makeNotifier([{ id: 'ntfy', configured: false, enabled: false }]),
      () => 1_000,
    );
    expect(v[0].effectiveStatus).toBe('not_set');
  });

  it('falls back to unknown channel id with id as label', () => {
    const v = loadChannelStatuses(
      makeNotifier([{ id: 'pushover', configured: true, enabled: true, lastSuccessAt: 1 }]),
      () => 2,
    );
    expect(v[0].label).toBe('pushover');
    expect(v[0].docAnchor).toBe('#pushover');
  });
});
