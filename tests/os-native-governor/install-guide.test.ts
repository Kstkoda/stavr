/**
 * Phase 5 of os-native-governor — operator install guide existence +
 * DoD coverage check.
 *
 * The BOM's Definition of Done item #5: "The accepted gap (no overload
 * prevention) is documented in the install guide, not silently dropped."
 * Items #2 + #4 require operator install + reboot smoke documented per
 * platform.
 *
 * This file verifies the guide exists at the canonical location and
 * surfaces the required content sections; the actual reboot smoke is
 * operator-run on a real host (the BOM's `targeted` verification window).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const GUIDE_PATH = resolve(PROJECT_ROOT, 'docs', 'os-native-governor-install.md');

describe('Phase 5 — operator install guide', () => {
  it('exists at docs/os-native-governor-install.md', () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);
  });

  const guide = existsSync(GUIDE_PATH) ? readFileSync(GUIDE_PATH, 'utf8') : '';

  it('covers all three platforms (Linux systemd, macOS launchd, Windows WinSW)', () => {
    expect(guide).toMatch(/##\s*Linux \(systemd/);
    expect(guide).toMatch(/##\s*macOS \(launchd/);
    expect(guide).toMatch(/##\s*Windows \(Windows Service via WinSW\)/);
  });

  it('per-platform install section invokes the corresponding install script', () => {
    expect(guide).toContain('bin/install-systemd.sh');
    expect(guide).toContain('bin/install-launchd.sh');
    expect(guide).toContain('bin\\install-windows-service.ps1');
  });

  it('documents the operator-run service-control commands per platform', () => {
    // Linux
    expect(guide).toContain('systemctl --user daemon-reload');
    expect(guide).toContain('systemctl --user enable --now stavr.service');
    // macOS
    expect(guide).toContain('launchctl bootstrap gui/$(id -u)');
    expect(guide).toContain('launchctl enable    gui/$(id -u)/com.stavr.daemon');
    expect(guide).toContain('launchctl kickstart gui/$(id -u)/com.stavr.daemon');
    // Windows
    expect(guide).toContain('StavrDaemon.exe install');
    expect(guide).toContain('StavrDaemon.exe start');
  });

  it('includes a per-platform reboot smoke procedure (DoD #4)', () => {
    expect(guide).toMatch(/Reboot smoke/i);
    expect(guide).toMatch(/sudo reboot/);
    expect(guide).toMatch(/shutdown -r now/);
    expect(guide).toMatch(/Restart-Computer/);
  });

  it('per-platform verify section calls /healthz to confirm the daemon is up', () => {
    expect(guide).toContain('http://127.0.0.1:7777/healthz');
  });

  it('documents the accepted gap (no overload prevention) per DoD #5', () => {
    // The BOM is explicit: "The accepted gap (no overload prevention)
    // is documented in the install guide, not silently dropped."
    expect(guide).toMatch(/[Aa]ccepted gap/);
    // Should reference the 2026-05-20 crash that motivated the BOM.
    expect(guide).toMatch(/2026-05-20/);
    // Should point at host-resource-ceiling (the BOM that DOES cover overload).
    expect(guide).toContain('host-resource-ceiling');
    // Must say the install does NOT prevent overload.
    expect(guide.toLowerCase()).toMatch(/not\s+(prevent|save you)/);
  });

  it('includes the migration-from-PM2 sequence', () => {
    expect(guide).toMatch(/Migration from PM2/i);
    expect(guide).toContain('pm2 stop stavr');
    expect(guide).toContain('pm2 delete stavr');
  });

  it('crash-loop guard semantics are documented per platform', () => {
    expect(guide).toContain('StartLimitBurst');
    expect(guide).toContain('ThrottleInterval');
    expect(guide).toContain('onfailure');
  });

  it('documents the Linux headless-host requirement (loginctl enable-linger)', () => {
    expect(guide).toContain('enable-linger');
  });

  it('documents the macOS crash-loop limitation (no burst cap)', () => {
    expect(guide).toMatch(/launchd has no.*burst[- ]cap/);
  });

  it('lists what is NOT in scope (deferred follow-ups) clearly', () => {
    expect(guide).toMatch(/NOT in scope/i);
    // The four explicit gaps: Steward agent, Tauri Governor rebuild,
    // ADR-020 watchdog, host-resource-ceiling.
    expect(guide.toLowerCase()).toContain('steward');
    expect(guide.toLowerCase()).toContain('tauri');
    expect(guide.toLowerCase()).toContain('adr-020');
  });

  it('links the related design docs (BOM + recon + ADR-020 + ADR-033)', () => {
    expect(guide).toContain('os-native-governor-bom.md');
    expect(guide).toContain('os-native-governor-recon.md');
    expect(guide).toContain('adr/020-daemon-watchdog.md');
    expect(guide).toContain('adr/033-stavr-tray-companion.md');
  });
});
