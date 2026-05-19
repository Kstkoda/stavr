/**
 * tests/dashboard/family-mode.test.ts
 *
 * Render coverage for the /dashboard/family-mode page (v0.7 Phase 5).
 * Asserts on data-role attributes + structural pieces, not on specific
 * HTML strings — per CLAUDE.md §1, page-layout tests focus on shape.
 */
import { describe, expect, it } from 'vitest';
import { renderFamilyModePage } from '../../src/dashboard/pages/family-mode.js';
import type { FamilyModeData } from '../../src/dashboard/pages/family-mode.js';

function makeData(overrides: Partial<FamilyModeData> = {}): FamilyModeData {
  return {
    self_id: 'kenneth-desktop',
    self_display_name: 'Kenneth Desktop',
    peers_yaml_path: '/home/kenneth/.stavr/peers.yaml',
    peers: [],
    ...overrides,
  };
}

describe('renderFamilyModePage', () => {
  it('renders the no-data placeholder when no input is passed', () => {
    const html = renderFamilyModePage();
    expect(html).toContain('Family mode');
    expect(html).toContain('No peers yet');
  });

  it('renders the empty-state callout when peers array is empty', () => {
    const html = renderFamilyModePage(makeData());
    expect(html).toContain('No peers yet');
    expect(html).toContain('Auto-discover');
    expect(html).toContain('/home/kenneth/.stavr/peers.yaml');
  });

  it('renders a peer row with display_name + trust + state pills', () => {
    const html = renderFamilyModePage(
      makeData({
        peers: [
          {
            id: 'son1-rig',
            display_name: 'Son 1 Rig',
            hostname: 'son1.local',
            port: 7777,
            addresses: ['192.168.1.10'],
            trust: 'verified',
            state: 'online',
            configured: true,
            discovered: true,
            last_seen_at: Date.now(),
          },
        ],
      }),
    );
    expect(html).toContain('Son 1 Rig');
    expect(html).toContain('son1-rig');
    expect(html).toContain('192.168.1.10');
    expect(html).toContain(':7777');
    expect(html).toContain('Verified');
    expect(html).toContain('Online');
    expect(html).toContain('data-peer-id="son1-rig"');
  });

  it('renders the configured + discovered tags when both flags are set', () => {
    const html = renderFamilyModePage(
      makeData({
        peers: [
          {
            id: 'p',
            display_name: 'P',
            hostname: 'p.local',
            port: 7777,
            addresses: ['10.0.0.1'],
            trust: 'verified',
            state: 'online',
            configured: true,
            discovered: true,
            last_seen_at: Date.now(),
          },
        ],
      }),
    );
    expect(html).toContain('tag-configured');
    expect(html).toContain('tag-discovered');
  });

  it('renders an offline peer with state pill = offline', () => {
    const html = renderFamilyModePage(
      makeData({
        peers: [
          {
            id: 'son2-rig',
            display_name: 'Son 2 Rig',
            hostname: 'son2.local',
            port: 7777,
            addresses: [],
            trust: 'verified',
            state: 'offline',
            configured: true,
            discovered: false,
            last_seen_at: 0,
          },
        ],
      }),
    );
    expect(html).toContain('Son 2 Rig');
    expect(html).toContain('Offline');
    expect(html).toContain('never'); // last_seen_at: 0 → "never"
  });

  it('escapes HTML in peer display name', () => {
    const html = renderFamilyModePage(
      makeData({
        peers: [
          {
            id: 'p1',
            display_name: '<script>alert(1)</script>',
            hostname: 'p.local',
            port: 7777,
            addresses: ['10.0.0.1'],
            trust: 'verified',
            state: 'online',
            configured: true,
            discovered: false,
            last_seen_at: Date.now(),
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders peer counts in the header', () => {
    const html = renderFamilyModePage(
      makeData({
        peers: [
          {
            id: 'a',
            display_name: 'A',
            hostname: 'a.local',
            port: 7777,
            addresses: ['10.0.0.1'],
            trust: 'verified',
            state: 'online',
            configured: true,
            discovered: false,
            last_seen_at: Date.now(),
          },
          {
            id: 'b',
            display_name: 'B',
            hostname: 'b.local',
            port: 7777,
            addresses: [],
            trust: 'untrusted',
            state: 'offline',
            configured: false,
            discovered: true,
            last_seen_at: 0,
          },
        ],
      }),
    );
    expect(html).toContain('data-role="peer-count">2');
    expect(html).toContain('data-role="peer-online">1');
    expect(html).toContain('data-role="peer-configured">1');
    expect(html).toContain('data-role="peer-trusted">1');
  });
});
