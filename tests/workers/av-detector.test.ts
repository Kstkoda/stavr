import { describe, expect, it } from 'vitest';
import {
  DEFENDER_BLOCK_EVENT_IDS,
  DEFENDER_CHANNEL,
  KNOWN_THIRD_PARTY_AVS,
  detectAvBlock,
  matchAvEvent,
  parseExtraChannels,
} from '../../src/workers/av-detector.js';

describe('v0.6.7 P3 — matchAvEvent parses wevtutil text format', () => {
  it('extracts event id + description when the spawned path appears', () => {
    const fixture = [
      'Event[0]:',
      '  Log Name:      Microsoft-Windows-Windows Defender/Operational',
      '  Source:        Microsoft-Windows-Windows Defender',
      '  Event ID:      1116',
      '  Level:         Warning',
      '  Description:',
      '  Real-Time Detection Action — Threat: HackTool:PowerShell/Adgholas.A',
      '  Path: C:\\Users\\op\\.stavr\\worker-scripts\\w-abc.ps1',
      '',
    ].join('\n');
    const m = matchAvEvent(fixture, 'C:\\Users\\op\\.stavr\\worker-scripts\\w-abc.ps1');
    expect(m).not.toBeNull();
    expect(m?.av_event_id).toBe(1116);
    expect(m?.av_event_message).toContain('HackTool');
    expect(m?.av_event_message).toContain('w-abc.ps1');
  });

  it('returns null when the spawned path is not in the event text', () => {
    const fixture = [
      'Event[0]:',
      '  Event ID: 1116',
      '  Description: Real-Time Detection Action — Threat: GenericWorm',
      '  Path: C:\\some\\other\\unrelated.exe',
      '',
    ].join('\n');
    expect(matchAvEvent(fixture, 'C:\\Users\\op\\.stavr\\worker-scripts\\w-abc.ps1')).toBeNull();
  });

  it('truncates the description at 240 chars with an ellipsis', () => {
    const longDesc = 'X'.repeat(500);
    const fixture = [
      'Event[0]:',
      '  Event ID: 1117',
      `  Description: ${longDesc}`,
      '  Path: /tmp/w.sh',
      '',
    ].join('\n');
    const m = matchAvEvent(fixture, '/tmp/w.sh');
    expect(m?.av_event_message?.length).toBeLessThanOrEqual(240);
    expect(m?.av_event_message?.endsWith('…')).toBe(true);
  });
});

describe('v0.6.7 P3 — detectAvBlock cross-platform safety', () => {
  it('returns null on non-Windows platforms without touching the transport', async () => {
    let transportCalled = false;
    const result = await detectAvBlock({
      spawnedPath: '/tmp/w.sh',
      transport: async () => {
        transportCalled = true;
        return '';
      },
      sleepMs: async () => {},
      platformOverride: 'linux',
    });
    expect(result).toBeNull();
    expect(transportCalled).toBe(false);
  });

  it('returns null on darwin without querying', async () => {
    let transportCalled = false;
    const result = await detectAvBlock({
      spawnedPath: '/tmp/w.sh',
      transport: async () => {
        transportCalled = true;
        return '';
      },
      sleepMs: async () => {},
      platformOverride: 'darwin',
    });
    expect(result).toBeNull();
    expect(transportCalled).toBe(false);
  });
});

describe('v0.6.7 P3 — detectAvBlock channel iteration on win32', () => {
  it('matches Defender first when its channel returns a hit', async () => {
    const defenderFixture = [
      'Event[0]:',
      '  Log Name: Microsoft-Windows-Windows Defender/Operational',
      '  Event ID: 1116',
      '  Description: Real-time block — Threat: Stress/Test',
      '  Path: C:\\stavr\\worker-scripts\\w-d.ps1',
      '',
    ].join('\n');
    const result = await detectAvBlock({
      spawnedPath: 'C:\\stavr\\worker-scripts\\w-d.ps1',
      platformOverride: 'win32',
      sleepMs: async () => {},
      transport: async (channel) => {
        if (channel === DEFENDER_CHANNEL) return defenderFixture;
        throw new Error(`channel ${channel} not found on this machine`);
      },
    });
    expect(result?.av_product_name).toBe('Windows Defender');
    expect(result?.av_event_id).toBe(1116);
    expect(result?.av_event_message).toContain('Stress/Test');
  });

  it('falls through to a third-party AV when Defender is silent', async () => {
    const sentinelFixture = [
      'Event[0]:',
      '  Log Name: SentinelOne/Operational',
      '  Event ID: 42',
      '  Description: SentinelOne killed a process — Threat: Mock/Sample',
      '  Path: /tmp/mock.sh',
      '',
    ].join('\n');
    const result = await detectAvBlock({
      spawnedPath: '/tmp/mock.sh',
      platformOverride: 'win32',
      sleepMs: async () => {},
      transport: async (channel) => {
        if (channel.includes('Defender')) return ''; // Defender silent
        if (channel === 'SentinelOne/Operational') return sentinelFixture;
        throw new Error(`channel ${channel} not found`);
      },
    });
    expect(result?.av_product_name).toBe('SentinelOne');
    expect(result?.av_event_id).toBe(42);
  });

  it('returns null when no channel contains the spawned path', async () => {
    const result = await detectAvBlock({
      spawnedPath: '/tmp/w.sh',
      platformOverride: 'win32',
      sleepMs: async () => {},
      transport: async () => {
        // All channels exist but none reference our path.
        return [
          'Event[0]:',
          '  Event ID: 99',
          '  Description: unrelated worm activity',
          '  Path: /var/lib/something-else',
          '',
        ].join('\n');
      },
    });
    expect(result).toBeNull();
  });

  it('survives channels that throw (third-party AV not installed)', async () => {
    const defenderFixture = [
      'Event[0]:',
      '  Event ID: 1117',
      '  Description: Detected & quarantined.',
      '  Path: /tmp/w.sh',
      '',
    ].join('\n');
    const seenChannels: string[] = [];
    const result = await detectAvBlock({
      spawnedPath: '/tmp/w.sh',
      platformOverride: 'win32',
      sleepMs: async () => {},
      transport: async (channel) => {
        seenChannels.push(channel);
        if (channel === DEFENDER_CHANNEL) return defenderFixture;
        // Simulate non-installed channels.
        throw new Error('not found');
      },
    });
    expect(result?.av_product_name).toBe('Windows Defender');
    expect(seenChannels[0]).toBe(DEFENDER_CHANNEL);
  });

  it('queries the BOM-specified Defender block event ids', () => {
    // Just pin the list against the BOM so a future refactor can't drop
    // a critical id silently.
    expect(DEFENDER_BLOCK_EVENT_IDS).toContain(1116);
    expect(DEFENDER_BLOCK_EVENT_IDS).toContain(1117);
    expect(DEFENDER_BLOCK_EVENT_IDS).toContain(5007);
  });

  it('ships the BOM-specified third-party AV channel list', () => {
    const names = KNOWN_THIRD_PARTY_AVS.map((a) => a.name);
    expect(names).toContain('CrowdStrike Falcon');
    expect(names).toContain('SentinelOne');
    expect(names).toContain('Symantec');
    expect(names).toContain('Sophos');
  });
});

describe('v0.6.7 P3 — parseExtraChannels env override', () => {
  it('parses semicolon-separated Vendor|Channel pairs', () => {
    const parsed = parseExtraChannels('Acme|Acme/Op;Beta|Beta-Sensor/Events');
    expect(parsed).toEqual([
      { name: 'Acme', channel: 'Acme/Op' },
      { name: 'Beta', channel: 'Beta-Sensor/Events' },
    ]);
  });

  it('silently drops malformed entries (no |, empty name, empty channel)', () => {
    expect(parseExtraChannels('Acme|Acme/Op;malformed;|EmptyName;Beta|')).toEqual([
      { name: 'Acme', channel: 'Acme/Op' },
    ]);
  });

  it('returns [] for empty / undefined env', () => {
    expect(parseExtraChannels(undefined)).toEqual([]);
    expect(parseExtraChannels('')).toEqual([]);
    expect(parseExtraChannels(';;')).toEqual([]);
  });
});
