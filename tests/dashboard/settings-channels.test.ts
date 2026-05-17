import { describe, expect, it } from 'vitest';
import { renderSettingsPage, type SettingsData } from '../../src/dashboard/pages/settings.js';
import type { ChannelStatusView } from '../../src/dashboard/data/channels.js';

function baseData(): SettingsData {
  return {
    activeMode: 'balanced',
    scopes: [],
    noGo: [],
    bricks: [],
  };
}

describe('v0.6 settings page — notification channels panel', () => {
  it('renders the channels section when channels are present', () => {
    const channels: ChannelStatusView[] = [
      {
        id: 'ntfy',
        configured: true,
        enabled: true,
        lastSuccessAt: Date.now() - 60_000,
        label: 'ntfy.sh',
        docAnchor: '#ntfy',
        effectiveStatus: 'configured',
      },
    ];
    const html = renderSettingsPage({ ...baseData(), channels });
    expect(html).toContain('Notification channels');
    expect(html).toContain('ntfy.sh');
    expect(html).toContain('CONFIGURED');
    expect(html).toContain('data-role="channel-test"');
  });

  it("renders [Help] not [Test] when channel is 'not_set'", () => {
    const channels: ChannelStatusView[] = [
      {
        id: 'telegram',
        configured: false,
        enabled: false,
        label: 'Telegram',
        docAnchor: '#telegram',
        effectiveStatus: 'not_set',
      },
    ];
    const html = renderSettingsPage({ ...baseData(), channels });
    expect(html).toContain('NOT SET');
    expect(html).toContain('data-role="channel-help"');
    expect(html).not.toContain('data-role="channel-test" data-id="telegram"');
  });

  it("shows CONFIGURED · STALE when last_success is older than 24h", () => {
    const channels: ChannelStatusView[] = [
      {
        id: 'email',
        configured: true,
        enabled: true,
        lastSuccessAt: Date.now() - 30 * 60 * 60 * 1000,
        label: 'Email (SMTP)',
        docAnchor: '#email',
        effectiveStatus: 'configured_stale',
      },
    ];
    const html = renderSettingsPage({ ...baseData(), channels });
    expect(html).toContain('CONFIGURED · STALE');
  });

  it('explicit disabled-fabric message when channels === undefined', () => {
    const html = renderSettingsPage(baseData());
    expect(html).toContain('Notification fabric disabled');
    expect(html).toContain('STAVR_NOTIFY_SECRET');
  });

  it('never renders any secret/token fragment in the page', () => {
    const channels: ChannelStatusView[] = [
      {
        id: 'telegram',
        configured: true,
        enabled: true,
        lastSuccessAt: Date.now(),
        label: 'Telegram',
        docAnchor: '#telegram',
        effectiveStatus: 'configured',
      },
    ];
    const html = renderSettingsPage({ ...baseData(), channels });
    // Sanity: no obvious token-shaped strings (bot:XXX or long alphanum).
    // Real protection is "we don't pass secrets into channels view" but a
    // regression check guards against future leakage.
    expect(html).not.toMatch(/bot[0-9a-zA-Z:_-]{15,}/);
    expect(html).not.toContain('STAVR_NOTIFY_TELEGRAM_BOT_TOKEN');
  });

  it('renders error text inline when channel.lastError is set', () => {
    const channels: ChannelStatusView[] = [
      {
        id: 'email',
        configured: true,
        enabled: true,
        lastError: 'SMTP 535 Authentication failed',
        lastErrorAt: Date.now(),
        label: 'Email (SMTP)',
        docAnchor: '#email',
        effectiveStatus: 'configured_stale',
      },
    ];
    const html = renderSettingsPage({ ...baseData(), channels });
    expect(html).toContain('SMTP 535 Authentication failed');
    expect(html).toContain('channel-error');
  });
});
