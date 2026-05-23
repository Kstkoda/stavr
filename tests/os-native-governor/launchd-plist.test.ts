/**
 * Phase 2 of os-native-governor — macOS launchd plist + install
 * script verification.
 *
 * Same shape as the Phase 1 systemd test: re-implement the install
 * script's sed substitution in node, assert the rendered plist has
 * the BOM-committed properties. The actual `launchctl bootstrap` is
 * Phase 5's `targeted` smoke on a real macOS host.
 *
 * Plist XML is rigid and well-known — string assertions are
 * appropriate. Where shape matters (ProgramArguments array order),
 * we extract the relevant block and check it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TEMPLATE_PATH = resolve(PROJECT_ROOT, 'bin', 'com.stavr.daemon.plist.template');

interface SubstitutionVars {
  NODE_BIN: string;
  INSTALL_DIR: string;
  STAVR_HOME: string;
  HOME_DIR: string;
  PATH_VALUE: string;
}

function renderTemplate(template: string, vars: SubstitutionVars): string {
  let out = template;
  for (const [key, value] of Object.entries(vars) as Array<[keyof SubstitutionVars, string]>) {
    out = out.split(`@${key}@`).join(value);
  }
  return out;
}

const FIXTURE_VARS: SubstitutionVars = {
  NODE_BIN: '/usr/local/bin/node',
  INSTALL_DIR: '/Users/kenneth/cowire',
  STAVR_HOME: '/Users/kenneth/.stavr',
  HOME_DIR: '/Users/kenneth',
  PATH_VALUE: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
};

describe('launchd plist template (Phase 2)', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const rendered = renderTemplate(template, FIXTURE_VARS);

  it('is a well-formed plist with the correct DOCTYPE', () => {
    expect(rendered).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(rendered).toContain('<!DOCTYPE plist PUBLIC');
    expect(rendered).toContain('<plist version="1.0">');
    expect(rendered).toContain('</plist>');
  });

  it('declares Label=com.stavr.daemon (the launchctl service name)', () => {
    expect(rendered).toMatch(/<key>Label<\/key>\s*<string>com\.stavr\.daemon<\/string>/);
  });

  it('ProgramArguments is an argv array with the foreground daemon invocation (no --detach)', () => {
    // Extract the ProgramArguments block — locate the opening <array>
    // after the ProgramArguments key, find its matching </array>.
    const startIdx = rendered.indexOf('<key>ProgramArguments</key>');
    expect(startIdx).toBeGreaterThan(0);
    const arrayStart = rendered.indexOf('<array>', startIdx);
    const arrayEnd = rendered.indexOf('</array>', arrayStart);
    const block = rendered.slice(arrayStart, arrayEnd);

    // No --detach in the argv (recon §1 finding).
    expect(block).not.toMatch(/--detach/);

    // Argv order matters — must start with the node binary, then the
    // four node args from the recon, then the CLI script path, then
    // the `daemon start` subcommand + flags.
    const argvLines = block.match(/<string>[^<]*<\/string>/g) ?? [];
    expect(argvLines.length).toBeGreaterThanOrEqual(14);

    // Spot-check key argv positions.
    expect(argvLines[0]).toBe('<string>/usr/local/bin/node</string>');
    expect(argvLines[1]).toBe('<string>--max-old-space-size=8192</string>');
    expect(argvLines[2]).toBe('<string>--heapsnapshot-near-heap-limit=2</string>');
    expect(argvLines[3]).toBe('<string>--report-on-fatalerror</string>');
    expect(argvLines[4]).toBe('<string>--report-directory=/Users/kenneth/cowire/tmp/diag-reports</string>');
    expect(argvLines[5]).toBe('<string>/Users/kenneth/cowire/dist/cli.js</string>');
    expect(argvLines[6]).toBe('<string>daemon</string>');
    expect(argvLines[7]).toBe('<string>start</string>');

    // The rest must contain --port 7777, --db, --log-format json.
    expect(block).toContain('<string>--port</string>');
    expect(block).toContain('<string>7777</string>');
    expect(block).toContain('<string>--db</string>');
    expect(block).toContain('<string>/Users/kenneth/.stavr/runestone.db</string>');
    expect(block).toContain('<string>--log-format</string>');
    expect(block).toContain('<string>json</string>');
  });

  it('WorkingDirectory is the install root', () => {
    expect(rendered).toMatch(
      /<key>WorkingDirectory<\/key>\s*<string>\/Users\/kenneth\/cowire<\/string>/,
    );
  });

  it('EnvironmentVariables dict carries HOME / STAVR_HOME / STAVR_DEBUG_ENABLED / PATH', () => {
    // launchd inherits very little env — the recon §3 table requires
    // these to be explicit in the plist.
    expect(rendered).toMatch(/<key>HOME<\/key>\s*<string>\/Users\/kenneth<\/string>/);
    expect(rendered).toMatch(
      /<key>STAVR_HOME<\/key>\s*<string>\/Users\/kenneth\/\.stavr<\/string>/,
    );
    expect(rendered).toMatch(/<key>STAVR_DEBUG_ENABLED<\/key>\s*<string>1<\/string>/);
    expect(rendered).toMatch(
      /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin:\/bin:\/opt\/homebrew\/bin<\/string>/,
    );
  });

  it('RunAtLoad=true (boot-start at user login)', () => {
    expect(rendered).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('ThrottleInterval=30 (crash-loop guard; matches systemd RestartSec)', () => {
    expect(rendered).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  it('KeepAlive with SuccessfulExit=false (restart only on non-zero exit)', () => {
    // The KeepAlive dict means launchd respawns the agent on crash;
    // SuccessfulExit=false carves out the clean-exit case so an
    // operator-driven SIGTERM (e.g. via launchctl bootout) stays
    // stopped rather than triggering a restart.
    expect(rendered).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
  });

  it('routes stdout + stderr to ~/Library/Logs/stavr/', () => {
    expect(rendered).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/Users\/kenneth\/Library\/Logs\/stavr\/stdout\.log<\/string>/,
    );
    expect(rendered).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>\/Users\/kenneth\/Library\/Logs\/stavr\/stderr\.log<\/string>/,
    );
  });

  it('ExitTimeOut=10 (SIGTERM→SIGKILL grace matches systemd TimeoutStopSec)', () => {
    expect(rendered).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>10<\/integer>/);
  });

  it('ProcessType=Interactive (operator-facing background agent)', () => {
    expect(rendered).toMatch(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  });

  it('contains no unsubstituted @PLACEHOLDER@ tokens', () => {
    const survivors = rendered.match(/@[A-Z_]+@/g);
    expect(survivors, `unsubstituted placeholders: ${(survivors ?? []).join(', ')}`).toBeNull();
  });

  it('the template declares exactly the five placeholders the install script substitutes', () => {
    const placeholdersInTemplate = new Set(
      Array.from(template.matchAll(/@([A-Z_]+)@/g)).map((m) => m[1]),
    );
    const placeholdersInTest = new Set(Object.keys(FIXTURE_VARS));
    expect(placeholdersInTemplate).toEqual(placeholdersInTest);
  });

  it('uses the same placeholder set as the systemd template (cross-platform consistency)', () => {
    const systemdTemplate = readFileSync(
      resolve(PROJECT_ROOT, 'bin', 'stavr.service.template'),
      'utf8',
    );
    const systemdPlaceholders = new Set(
      Array.from(systemdTemplate.matchAll(/@([A-Z_]+)@/g)).map((m) => m[1]),
    );
    const launchdPlaceholders = new Set(
      Array.from(template.matchAll(/@([A-Z_]+)@/g)).map((m) => m[1]),
    );
    expect(launchdPlaceholders).toEqual(systemdPlaceholders);
  });
});

describe('install-launchd.sh script content (Phase 2)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'install-launchd.sh');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('refuses to run on non-Darwin platforms', () => {
    expect(script).toContain('uname -s');
    expect(script).toContain('Darwin');
  });

  it('checks for launchctl on PATH', () => {
    expect(script).toMatch(/command -v launchctl/);
  });

  it('checks for node + dist/cli.js (the daemon entry must exist)', () => {
    expect(script).toMatch(/command -v node/);
    expect(script).toContain('dist/cli.js');
    expect(script).toContain('npm run build');
  });

  it('creates the LaunchAgents dir + Logs dir + STAVR_HOME', () => {
    expect(script).toMatch(/mkdir -p "\$PLIST_DIR"/);
    expect(script).toMatch(/mkdir -p "\$LOG_DIR"/);
    expect(script).toMatch(/mkdir -p "\$STAVR_HOME"/);
  });

  it('runs plutil -lint on the rendered plist when available', () => {
    expect(script).toContain('plutil -lint');
  });

  it('rejects unsubstituted @PLACEHOLDER@ after sed', () => {
    expect(script).toMatch(/grep -q '@\[A-Z_\]\*@' "\$PLIST_FILE"/);
  });

  it('does NOT call launchctl itself (operator-run per the BOM)', () => {
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      // Column-0 invocation is direct execution. Heredoc-body
      // mentions (indented) are text the operator reads.
      expect(line.startsWith('launchctl ')).toBe(false);
    }
  });

  it('does NOT call bootstrap / kickstart / bootout from command position', () => {
    const lines = script.split('\n');
    for (const line of lines) {
      if (!line.includes('launchctl ')) continue;
      expect(line.startsWith('launchctl ')).toBe(false);
    }
  });
});

describe('uninstall-launchd.sh script content (Phase 2)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'uninstall-launchd.sh');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('is idempotent — no plist = no-op', () => {
    expect(script).toContain('nothing to do');
  });

  it('without --force, prints the launchctl bootout command the operator must run', () => {
    expect(script).toContain('--force');
    expect(script).toContain('launchctl bootout');
  });

  it('with --force, removes the plist file', () => {
    expect(script).toMatch(/rm "\$PLIST_FILE"/);
  });

  it('does NOT call launchctl itself', () => {
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      expect(line.startsWith('launchctl ')).toBe(false);
    }
  });
});
