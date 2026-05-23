/**
 * Phase 1 of os-native-governor — Linux systemd template + install
 * script verification.
 *
 * The install script (bin/install-systemd.sh) substitutes five
 * placeholders into bin/stavr.service.template via `sed`. We
 * re-implement the same substitution in node and assert the output is
 * what the BOM commits to: a valid systemd unit with the crash-loop
 * guard, the foreground exec line, the resolved env vars, the
 * journald log sink, and no unsubstituted placeholders.
 *
 * Why a unit-style test rather than spawning bash:
 *   - Vitest on Windows can't invoke `bash` deterministically (worktree
 *     mount + Git Bash + WSL all behave differently); the existing
 *     CLI-subprocess tests (15 pre-existing failures on baseline)
 *     proved that out.
 *   - The substitution itself is the load-bearing logic. Renders
 *     identically in node and in sed for `|`-delimited operations on
 *     known-shape placeholders.
 *   - Per-platform reboot smoke (the actual `systemctl enable` →
 *     reboot → check) is Phase 5's `targeted` verification, run by the
 *     operator on a real Linux host.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TEMPLATE_PATH = resolve(PROJECT_ROOT, 'bin', 'stavr.service.template');

interface SubstitutionVars {
  NODE_BIN: string;
  INSTALL_DIR: string;
  STAVR_HOME: string;
  HOME_DIR: string;
  PATH_VALUE: string;
}

/**
 * Mirrors the `sed -e "s|@KEY@|VALUE|g"` chain in install-systemd.sh.
 * Same `|` delimiter convention so the test catches any drift between
 * the script's expectations and the template's placeholders.
 */
function renderTemplate(template: string, vars: SubstitutionVars): string {
  let out = template;
  for (const [key, value] of Object.entries(vars) as Array<[keyof SubstitutionVars, string]>) {
    out = out.split(`@${key}@`).join(value);
  }
  return out;
}

const FIXTURE_VARS: SubstitutionVars = {
  NODE_BIN: '/usr/local/bin/node',
  INSTALL_DIR: '/home/kenneth/cowire',
  STAVR_HOME: '/home/kenneth/.stavr',
  HOME_DIR: '/home/kenneth',
  PATH_VALUE: '/usr/local/bin:/usr/bin:/bin:/home/kenneth/.npm/bin',
};

describe('systemd unit template (Phase 1)', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const rendered = renderTemplate(template, FIXTURE_VARS);

  it('declares the three systemd sections', () => {
    expect(rendered).toMatch(/^\[Unit\]/m);
    expect(rendered).toMatch(/^\[Service\]/m);
    expect(rendered).toMatch(/^\[Install\]/m);
  });

  it('includes the crash-loop guard (StartLimitBurst + StartLimitIntervalSec)', () => {
    // The BOM's mandatory requirement — without these, a fast-crash
    // daemon would have systemd respawn forever.
    expect(rendered).toMatch(/^StartLimitIntervalSec=300$/m);
    expect(rendered).toMatch(/^StartLimitBurst=5$/m);
  });

  it('Type=simple (the daemon runs in foreground)', () => {
    expect(rendered).toMatch(/^Type=simple$/m);
  });

  it('ExecStart runs the foreground daemon with the recon-pinned node args', () => {
    // Pull the ExecStart line specifically — the template comment block
    // mentions "NO --detach" which would false-match a whole-file check.
    const execStartLine = rendered
      .split('\n')
      .find((l) => l.startsWith('ExecStart='));
    expect(execStartLine, 'no ExecStart= line found').toBeDefined();
    // Foreground: must NOT include --detach (the BOM's recon §1 finding).
    expect(execStartLine).not.toMatch(/--detach/);
    // The 4 node args carried over from PM2's ecosystem.config.cjs.
    expect(execStartLine).toContain('--max-old-space-size=8192');
    expect(execStartLine).toContain('--heapsnapshot-near-heap-limit=2');
    expect(execStartLine).toContain('--report-on-fatalerror');
    expect(execStartLine).toContain('--report-directory=/home/kenneth/cowire/tmp/diag-reports');
    // The canonical CLI entry: dist/cli.js daemon start.
    expect(execStartLine).toContain('/home/kenneth/cowire/dist/cli.js daemon start');
    // Structured logging (the recon §1 recommendation for service mode).
    expect(execStartLine).toContain('--log-format json');
    // Default port + DB path the daemon and the install script agree on.
    expect(execStartLine).toContain('--port 7777');
    expect(execStartLine).toContain('--db /home/kenneth/.stavr/runestone.db');
  });

  it('Environment directives are substituted (HOME / STAVR_HOME / PATH / debug)', () => {
    // systemd doesn't inherit HOME / PATH for User= services; the recon §3
    // table requires explicit values.
    expect(rendered).toMatch(/^Environment=HOME=\/home\/kenneth$/m);
    expect(rendered).toMatch(/^Environment=STAVR_HOME=\/home\/kenneth\/\.stavr$/m);
    expect(rendered).toMatch(/^Environment=STAVR_DEBUG_ENABLED=1$/m);
    expect(rendered).toMatch(/^Environment=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/home\/kenneth\/\.npm\/bin$/m);
  });

  it('Restart=on-failure + RestartSec=30 (matches PM2 restart_delay)', () => {
    expect(rendered).toMatch(/^Restart=on-failure$/m);
    expect(rendered).toMatch(/^RestartSec=30$/m);
  });

  it('MemoryHigh=7G (matches PM2 max_memory_restart=7000M, with cgroup-v2 soft ceiling)', () => {
    expect(rendered).toMatch(/^MemoryHigh=7G$/m);
    // MemoryMax (hard cap) is intentionally NOT here — that requires
    // cgroup-v2 delegation and belongs to the host-resource-ceiling work.
    expect(rendered).not.toMatch(/^MemoryMax=/m);
  });

  it('TimeoutStopSec=10 (matches PM2 kill_timeout=10000ms)', () => {
    expect(rendered).toMatch(/^TimeoutStopSec=10$/m);
  });

  it('routes stdout + stderr into journald', () => {
    expect(rendered).toMatch(/^StandardOutput=journal$/m);
    expect(rendered).toMatch(/^StandardError=journal$/m);
  });

  it('WantedBy=default.target (user-systemd boot-start)', () => {
    // user-systemd has no multi-user.target — default.target is the
    // equivalent. The recon §7 locked this choice.
    expect(rendered).toMatch(/^WantedBy=default\.target$/m);
  });

  it('WorkingDirectory is the install root', () => {
    expect(rendered).toMatch(/^WorkingDirectory=\/home\/kenneth\/cowire$/m);
  });

  it('contains no unsubstituted @PLACEHOLDER@ tokens', () => {
    // The install script refuses to confirm install if any @KEY@ survives
    // sed substitution. Same guarantee at the template level: every
    // placeholder must have a corresponding entry in SubstitutionVars.
    const survivors = rendered.match(/@[A-Z_]+@/g);
    expect(survivors, `unsubstituted placeholders: ${(survivors ?? []).join(', ')}`).toBeNull();
  });

  it('the template itself declares exactly the five placeholders the install script substitutes', () => {
    // If the template gains a new @KEY@, the install script's sed chain
    // and this test's SubstitutionVars both need to be extended — this
    // test catches the drift up front.
    const placeholdersInTemplate = new Set(
      Array.from(template.matchAll(/@([A-Z_]+)@/g)).map((m) => m[1]),
    );
    const placeholdersInTest = new Set(Object.keys(FIXTURE_VARS));
    expect(placeholdersInTemplate).toEqual(placeholdersInTest);
  });
});

describe('install-systemd.sh script content (Phase 1)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'install-systemd.sh');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('refuses to run on non-Linux platforms', () => {
    expect(script).toContain('uname -s');
    expect(script).toContain('Linux');
  });

  it('checks for systemctl on PATH (fails fast with a clear message)', () => {
    expect(script).toMatch(/command -v systemctl/);
  });

  it('checks for node on PATH', () => {
    expect(script).toMatch(/command -v node/);
  });

  it('refuses to install if dist/cli.js is missing', () => {
    expect(script).toContain('dist/cli.js');
    expect(script).toContain("npm run build");
  });

  it('does NOT call systemctl itself (operator-run per the BOM)', () => {
    // Command-position bash invocation is line-leading at column 0 (no
    // leading whitespace). Heredoc body lines in the install script are
    // indented — they are TEXT the operator reads, not commands the
    // script runs. The discriminator is column 0.
    const lines = script.split('\n');
    for (const line of lines) {
      // Skip comments — they may legitimately discuss systemctl.
      if (line.startsWith('#')) continue;
      // Direct invocation at column 0 would be a violation; heredoc-body
      // mentions (indented) are fine.
      expect(line.startsWith('systemctl ')).toBe(false);
    }
  });

  it('does NOT call enable / start / daemon-reload from the script (those lines belong to operator instructions only)', () => {
    // Every `systemctl --user *` mention in the script must be in the
    // heredoc body (indented) — not at command position.
    const lines = script.split('\n');
    for (const line of lines) {
      if (!line.includes('systemctl --user')) continue;
      // Column-0 'systemctl --user' would be direct execution; we
      // accept any leading whitespace (heredoc body indentation).
      expect(line.startsWith('systemctl ')).toBe(false);
    }
  });

  it('creates STAVR_HOME and the diag-reports dir before writing the unit', () => {
    expect(script).toMatch(/mkdir -p .*\$STAVR_HOME/);
    expect(script).toMatch(/mkdir -p .*\$INSTALL_DIR\/tmp\/diag-reports/);
  });

  it('fails if any placeholder survives sed substitution', () => {
    // The install script's post-render guard — same invariant the
    // template test enforces, on the actual rendered file at install
    // time.
    expect(script).toMatch(/grep -q '@\[A-Z_\]\*@' "\$UNIT_FILE"/);
  });
});

describe('uninstall-systemd.sh script content (Phase 1)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'uninstall-systemd.sh');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('is idempotent — no unit file = no-op', () => {
    expect(script).toContain('nothing to do');
  });

  it('without --force, only prints the steps (BOM: operator runs systemctl)', () => {
    expect(script).toContain('--force');
    expect(script).toContain('systemctl --user stop stavr.service');
    expect(script).toContain('systemctl --user disable stavr.service');
  });

  it('with --force, removes the unit file but tells the operator to daemon-reload', () => {
    expect(script).toMatch(/rm "\$UNIT_FILE"/);
    expect(script).toContain('daemon-reload');
  });

  it('does NOT call systemctl itself', () => {
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      // Same column-0 discriminator as the install-script test.
      expect(line.startsWith('systemctl ')).toBe(false);
    }
  });
});
