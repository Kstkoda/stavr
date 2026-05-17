import { describe, expect, it } from 'vitest';
import { renderHelmPage, type HelmData, type HelmDigestState } from '../../src/dashboard/pages/helm.js';

function baseData(digest?: HelmDigestState): HelmData {
  return {
    intent: { summary: 'Steward is idle.', sub: 'No active BOMs.' },
    health: {
      ok: true,
      version: '0.6.0',
      port: 7777,
      started_at: new Date().toISOString(),
      uptime_sec: 120,
      profile_mode: 'balanced',
      event_count: 0,
      active_scopes: 0,
    },
    boms: { recent: [], total: 0, open: 0 },
    decisions: { recent: [], open: 0 },
    workers: [],
    systems: [],
    digest,
  };
}

describe('v0.6 helm — digest row', () => {
  it('omits the digest row when fabric is disabled (digest undefined)', () => {
    const html = renderHelmPage(baseData(undefined));
    expect(html).not.toContain('data-role="helm-digest"');
    // Note: the JS handler block references 'digest-edit' even when the row
    // isn't rendered — only assert the row's data-role marker is absent.
  });

  it('renders the digest row with Edit + Disable when enabled', () => {
    const html = renderHelmPage(baseData({ enabled: true, hour: 9, minute: 0 }));
    expect(html).toContain('data-role="helm-digest"');
    expect(html).toContain('Last fired never');
    expect(html).toContain('next 09:00');
    expect(html).toContain('data-role="digest-edit"');
    expect(html).toContain('data-role="digest-toggle"');
    expect(html).toContain('>Disable<');
  });

  it('renders Enable button when digest is paused', () => {
    const html = renderHelmPage(baseData({ enabled: false, hour: 9, minute: 0 }));
    expect(html).toContain('data-role="helm-digest"');
    expect(html).toContain('paused');
    expect(html).toContain('>Enable<');
  });

  it('shows lastFiredAt time when set', () => {
    const fixed = new Date('2026-05-17T09:00:00Z').getTime();
    const html = renderHelmPage(baseData({ enabled: true, hour: 9, minute: 0, lastFiredAt: fixed }));
    expect(html).toContain('Last fired 09:00');
  });
});
