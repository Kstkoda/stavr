/**
 * Phase 3 of os-native-governor — Windows Service via WinSW config +
 * install/uninstall PowerShell scripts.
 *
 * Same shape as Phase 1 (systemd) and Phase 2 (launchd): re-implement
 * the install script's placeholder substitution in node, assert the
 * rendered WinSW XML has the BOM-committed properties. The actual
 * `StavrDaemon.exe install` is Phase 5's `targeted` smoke on a real
 * Windows host.
 *
 * Phase 3 also drops the broken `pm2-windows-startup` approach (the
 * BOM's words) — there is no PM2 dependency in the rendered XML. The
 * test confirms that.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TEMPLATE_PATH = resolve(PROJECT_ROOT, 'bin', 'StavrDaemon.xml.template');

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

// Windows-style fixture paths so the rendered XML reflects what the
// install script would produce on an actual Windows host.
const FIXTURE_VARS: SubstitutionVars = {
  NODE_BIN: 'C:\\Program Files\\nodejs\\node.exe',
  INSTALL_DIR: 'C:\\dev\\cowire',
  STAVR_HOME: 'C:\\Users\\kenneth\\.stavr',
  HOME_DIR: 'C:\\Users\\kenneth',
  PATH_VALUE: 'C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Users\\kenneth\\AppData\\Roaming\\npm',
};

describe('WinSW XML template (Phase 3)', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const rendered = renderTemplate(template, FIXTURE_VARS);

  it('is a well-formed WinSW service config', () => {
    expect(rendered).toContain('<?xml version="1.0"');
    expect(rendered).toMatch(/<service>[\s\S]*<\/service>/);
  });

  it('declares id=StavrDaemon (Windows Service Manager name)', () => {
    expect(rendered).toMatch(/<id>StavrDaemon<\/id>/);
  });

  it('executable points at the operator-resolved node binary', () => {
    expect(rendered).toContain('<executable>C:\\Program Files\\nodejs\\node.exe</executable>');
  });

  it('arguments contain the foreground daemon invocation (no --detach)', () => {
    // Pull the <arguments>...</arguments> block specifically — the
    // template comment uses the literal "--detach" word too.
    const m = rendered.match(/<arguments>([\s\S]*?)<\/arguments>/);
    expect(m).not.toBeNull();
    const args = m![1];

    expect(args).not.toMatch(/--detach/);
    expect(args).toContain('--max-old-space-size=8192');
    expect(args).toContain('--heapsnapshot-near-heap-limit=2');
    expect(args).toContain('--report-on-fatalerror');
    expect(args).toContain('--report-directory=C:\\dev\\cowire\\tmp\\diag-reports');
    expect(args).toContain('C:\\dev\\cowire\\dist\\cli.js');
    expect(args).toContain('daemon start');
    expect(args).toContain('--port 7777');
    expect(args).toContain('--db "C:\\Users\\kenneth\\.stavr\\runestone.db"');
    expect(args).toContain('--log-format json');
  });

  it('workingdirectory is the install root', () => {
    expect(rendered).toContain('<workingdirectory>C:\\dev\\cowire</workingdirectory>');
  });

  it('env directives expose USERPROFILE + HOME + STAVR_HOME + STAVR_DEBUG_ENABLED + PATH', () => {
    // Windows Node reads USERPROFILE for os.homedir(); HOME is set too
    // for portability with cross-platform code that checks HOME first.
    expect(rendered).toMatch(
      /<env name="USERPROFILE" value="C:\\Users\\kenneth"\s*\/>/,
    );
    expect(rendered).toMatch(/<env name="HOME" value="C:\\Users\\kenneth"\s*\/>/);
    expect(rendered).toMatch(
      /<env name="STAVR_HOME" value="C:\\Users\\kenneth\\\.stavr"\s*\/>/,
    );
    expect(rendered).toMatch(/<env name="STAVR_DEBUG_ENABLED" value="1"\s*\/>/);
    expect(rendered).toMatch(/<env name="PATH" value="[^"]+"\s*\/>/);
    // The PATH value must include the operator's npm prefix and node dir.
    const pathMatch = rendered.match(/<env name="PATH" value="([^"]+)"\s*\/>/);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]).toContain('nodejs');
    expect(pathMatch![1]).toContain('System32');
  });

  it('startmode=Automatic + delayedAutoStart=true (boot-start)', () => {
    expect(rendered).toMatch(/<startmode>Automatic<\/startmode>/);
    expect(rendered).toMatch(/<delayedAutoStart>true<\/delayedAutoStart>/);
  });

  it('crash-loop guard: 3 escalating restart entries + final halt + 1h reset', () => {
    // The BOM-mandated guard. Three restarts with escalating delays,
    // then `<onfailure action="none"/>` halts the service. resetfailure
    // counts uptime: after an hour of healthy uptime the failure
    // counter resets so the next crash starts the escalation over.
    const onfailures = rendered.match(/<onfailure action="[^"]+"[^/]*\/>/g) ?? [];
    expect(onfailures).toHaveLength(4);
    expect(onfailures[0]).toContain('action="restart"');
    expect(onfailures[0]).toContain('delay="30 sec"');
    expect(onfailures[1]).toContain('action="restart"');
    expect(onfailures[1]).toContain('delay="1 min"');
    expect(onfailures[2]).toContain('action="restart"');
    expect(onfailures[2]).toContain('delay="5 min"');
    expect(onfailures[3]).toContain('action="none"');
    expect(rendered).toMatch(/<resetfailure>1 hour<\/resetfailure>/);
  });

  it('stoptimeout=10 sec (matches systemd TimeoutStopSec + PM2 kill_timeout)', () => {
    expect(rendered).toMatch(/<stoptimeout>10 sec<\/stoptimeout>/);
    expect(rendered).toMatch(/<stopparentprocessfirst>false<\/stopparentprocessfirst>/);
  });

  it('log rotation: roll-by-size, 10MB threshold, keep 5 files', () => {
    expect(rendered).toMatch(/<log mode="roll-by-size">/);
    expect(rendered).toMatch(/<sizeThreshold>10240<\/sizeThreshold>/);
    expect(rendered).toMatch(/<keepFiles>5<\/keepFiles>/);
    expect(rendered).toMatch(/<logpath>C:\\dev\\cowire\\logs<\/logpath>/);
  });

  it('drops the broken pm2-windows-startup approach', () => {
    // The BOM's explicit retirement: WinSW replaces pm2-windows-startup.
    // The rendered XML must contain zero structural references to that
    // dependency. Documentation comments may compare-and-contrast with
    // PM2 ("same idea as PM2's min_uptime"); what's prohibited is using
    // pm2-windows-startup itself for service registration.
    expect(rendered.toLowerCase()).not.toContain('pm2-windows-startup');
    // No <ecosystem> or PM2-specific XML elements either.
    expect(rendered).not.toMatch(/<ecosystem/i);
    expect(rendered).not.toMatch(/<pm2/i);
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

  it('uses the same placeholder set as the systemd + launchd templates', () => {
    const systemdTemplate = readFileSync(
      resolve(PROJECT_ROOT, 'bin', 'stavr.service.template'),
      'utf8',
    );
    const launchdTemplate = readFileSync(
      resolve(PROJECT_ROOT, 'bin', 'com.stavr.daemon.plist.template'),
      'utf8',
    );
    const set = (s: string) =>
      new Set(Array.from(s.matchAll(/@([A-Z_]+)@/g)).map((m) => m[1]));
    expect(set(template)).toEqual(set(systemdTemplate));
    expect(set(template)).toEqual(set(launchdTemplate));
  });
});

describe('install-windows-service.ps1 script content (Phase 3)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'install-windows-service.ps1');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('refuses to run on non-Windows', () => {
    expect(script).toContain('IsWindows');
    expect(script).toContain('Windows_NT');
  });

  it('checks for node + dist/cli.js', () => {
    expect(script).toMatch(/Get-Command node/);
    expect(script).toContain('dist\\cli.js');
    expect(script).toContain('npm run build');
  });

  it('refuses to install when the operator has not placed StavrDaemon.exe', () => {
    expect(script).toContain('StavrDaemon.exe');
    expect(script).toContain('WinSW (Windows Service Wrapper)');
    expect(script).toContain('SHA256');
  });

  it('creates STAVR_HOME + logs + diag-reports + winsw dir', () => {
    expect(script).toMatch(/New-Item -ItemType Directory -Force/);
  });

  it('does string-replacement (not regex) for placeholders', () => {
    // PowerShell -replace is regex-based; path values can contain
    // regex specials like \. The install script uses .Replace()
    // (literal string) instead.
    expect(script).toMatch(/\$xml\.Replace\('@NODE_BIN@'/);
    expect(script).toMatch(/\$xml\.Replace\('@INSTALL_DIR@'/);
    expect(script).toMatch(/\$xml\.Replace\('@STAVR_HOME@'/);
    expect(script).toMatch(/\$xml\.Replace\('@HOME_DIR@'/);
    expect(script).toMatch(/\$xml\.Replace\('@PATH_VALUE@'/);
  });

  it('rejects unsubstituted @PLACEHOLDER@ after rendering', () => {
    expect(script).toMatch(/\$xml -match '@\[A-Z_\]\+@'/);
  });

  it('does NOT call StavrDaemon.exe install/start/sc.exe/Set-Service at command position', () => {
    // The script PRINTS those commands inside a Write-Host here-string
    // for the operator. They must not be invocations.
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      // PowerShell invocation at line-leading position would be:
      //   `& "path\StavrDaemon.exe" install` (call operator + path)
      //   `sc.exe …`
      //   `Set-Service …`
      expect(line.startsWith('& ')).toBe(false);
      expect(line.startsWith('sc.exe ')).toBe(false);
      expect(line.startsWith('Set-Service ')).toBe(false);
      expect(line.startsWith('Start-Service ')).toBe(false);
      expect(line.startsWith('Stop-Service ')).toBe(false);
    }
  });
});

describe('uninstall-windows-service.ps1 script content (Phase 3)', () => {
  const SCRIPT_PATH = resolve(PROJECT_ROOT, 'bin', 'uninstall-windows-service.ps1');
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('is idempotent — no XML = no-op', () => {
    expect(script).toContain('nothing to do');
  });

  it('without -Force, prints the stop+uninstall commands the operator must run', () => {
    // The script uses $WinSwExe (PowerShell variable) in its here-string,
    // which at print-time expands to the path to StavrDaemon.exe. We
    // assert on the variable form + the verbs.
    expect(script).toContain('-Force');
    expect(script).toMatch(/\$WinSwExe\s+stop/);
    expect(script).toMatch(/\$WinSwExe\s+uninstall/);
  });

  it('with -Force, removes the XML file', () => {
    expect(script).toMatch(/Remove-Item -LiteralPath \$WinSwXml/);
  });

  it('does NOT call StavrDaemon.exe / sc.exe / Set-Service at command position', () => {
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      expect(line.startsWith('& ')).toBe(false);
      expect(line.startsWith('sc.exe ')).toBe(false);
      expect(line.startsWith('Set-Service ')).toBe(false);
      expect(line.startsWith('Stop-Service ')).toBe(false);
    }
  });
});

describe('bin/winsw/README.md (operator placement guidance)', () => {
  const README_PATH = resolve(PROJECT_ROOT, 'bin', 'winsw', 'README.md');
  const readme = readFileSync(README_PATH, 'utf8');

  it('documents the pinned WinSW version + SHA256 hash', () => {
    expect(readme).toContain('WinSW version');
    expect(readme).toMatch(/SHA256/);
    // The hash should be 64 hex chars somewhere in the doc.
    expect(readme).toMatch(/[a-f0-9]{64}/);
  });

  it('provides the verify-SHA256 PowerShell snippet', () => {
    expect(readme).toContain('Get-FileHash');
    expect(readme).toContain('SHA256');
  });

  it('explains the no-bundle decision (supply-chain integrity)', () => {
    expect(readme.toLowerCase()).toContain('supply-chain');
  });
});
