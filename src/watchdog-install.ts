/**
 * OS-scheduler integration for the Stavr watchdog (ADR-020).
 *
 * Strategy: dispatch on `process.platform`.
 *   - win32  → schtasks (one ONSTART trigger, one ONLOGON trigger).
 *   - darwin → launchctl + ~/Library/LaunchAgents/com.stavr.watchdog.plist.
 *   - linux  → systemd --user + ~/.config/systemd/user/stavr-watchdog.service.
 *
 * Every operation is idempotent — re-running install just re-applies. We do
 * not require root; on Linux this means a user-mode systemd unit (lingering
 * not enabled here; the user can `loginctl enable-linger` if they want it to
 * survive logout). Same applies to launchctl: LaunchAgent, not LaunchDaemon.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATCHDOG_LOG_PATH, WATCHDOG_PID_PATH } from './watchdog.js';
import { isProcessAlive } from './daemon.js';

const TASK_NAME_WIN = 'StavrWatchdog';
const TASK_NAME_WIN_LOGON = 'StavrWatchdogLogon';
const LAUNCHD_LABEL = 'com.stavr.watchdog';
const SYSTEMD_UNIT = 'stavr-watchdog.service';

export interface InstallResult {
  ok: boolean;
  platform: NodeJS.Platform;
  registered: string[];
  notes?: string[];
}

export interface UninstallResult {
  ok: boolean;
  platform: NodeJS.Platform;
  removed: string[];
}

export interface WatchdogStatusResult {
  platform: NodeJS.Platform;
  registered: boolean;
  running: boolean;
  pid?: number;
  started_at?: string;
  last_log_lines?: string[];
  restart_count?: number;
  registration_detail?: string;
}

function watchdogScriptPath(): string {
  // This module ships in dist/ at runtime; watchdog.js sits next to it.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'watchdog.js');
}

function execFileP(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : (stdout as Buffer | undefined)?.toString() ?? '';
      const errStr = typeof stderr === 'string' ? stderr : (stderr as Buffer | undefined)?.toString() ?? '';
      const code = (err as { code?: number | null } | null)?.code ?? (err ? 1 : 0);
      resolve({ stdout: out, stderr: errStr, code });
    });
  });
}

export async function installWatchdog(): Promise<InstallResult> {
  const platform = process.platform;
  const script = watchdogScriptPath();
  if (!existsSync(script)) {
    throw new Error(
      `watchdog script not found at ${script}; build the project first (npm run build)`,
    );
  }
  if (platform === 'win32') return installWindows(script);
  if (platform === 'darwin') return installDarwin(script);
  if (platform === 'linux') return installLinux(script);
  return {
    ok: false,
    platform,
    registered: [],
    notes: [`unsupported platform: ${platform} — register the watchdog manually with ${script}`],
  };
}

export async function uninstallWatchdog(): Promise<UninstallResult> {
  const platform = process.platform;
  if (platform === 'win32') return uninstallWindows();
  if (platform === 'darwin') return uninstallDarwin();
  if (platform === 'linux') return uninstallLinux();
  return { ok: false, platform, removed: [] };
}

export async function watchdogStatus(): Promise<WatchdogStatusResult> {
  const platform = process.platform;
  let registered = false;
  let registrationDetail: string | undefined;

  if (platform === 'win32') {
    const r = await execFileP('schtasks', ['/Query', '/TN', TASK_NAME_WIN]);
    registered = r.code === 0;
    registrationDetail = registered ? 'schtasks ONSTART task present' : undefined;
  } else if (platform === 'darwin') {
    const plist = launchAgentPath();
    registered = existsSync(plist);
    if (registered) registrationDetail = plist;
  } else if (platform === 'linux') {
    const unit = systemdUnitPath();
    registered = existsSync(unit);
    if (registered) registrationDetail = unit;
  }

  let pid: number | undefined;
  let startedAt: string | undefined;
  let running = false;
  if (existsSync(WATCHDOG_PID_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(WATCHDOG_PID_PATH, 'utf8')) as {
        pid: number;
        started_at: string;
      };
      pid = raw.pid;
      startedAt = raw.started_at;
      running = isProcessAlive(raw.pid);
    } catch {
      /* corrupt pid file — leave running=false */
    }
  }

  const lastLogLines = readLastLogLines(20);
  const restartCount = countRestartsInLog(lastLogLines);

  return {
    platform,
    registered,
    running,
    pid,
    started_at: startedAt,
    last_log_lines: lastLogLines,
    restart_count: restartCount,
    registration_detail: registrationDetail,
  };
}

function readLastLogLines(n: number): string[] {
  try {
    const all = readFileSync(WATCHDOG_LOG_PATH, 'utf8').trimEnd().split('\n');
    return all.slice(-n);
  } catch {
    return [];
  }
}

function countRestartsInLog(lines: string[]): number {
  let n = 0;
  for (const l of lines) {
    if (l.includes('"restart_end"')) n += 1;
  }
  return n;
}

// ---------------- Windows ----------------

async function installWindows(script: string): Promise<InstallResult> {
  const node = process.execPath;
  // /SC ONSTART runs at boot under the system account by default unless /RU set.
  // We use the current interactive user so the watchdog can restart a user
  // daemon. /F overwrites if the task already exists (idempotent).
  const user = userInfo().username;
  const cmd = `"${node}" "${script}"`;
  const baseArgs = (taskName: string, schedule: '/SC ONSTART' | '/SC ONLOGON') => [
    '/Create',
    '/TN',
    taskName,
    '/TR',
    cmd,
    ...schedule.split(' '),
    '/RU',
    user,
    '/RL',
    'LIMITED',
    '/F',
  ];

  const registered: string[] = [];
  const notes: string[] = [];

  for (const [name, schedule] of [
    [TASK_NAME_WIN, '/SC ONSTART'],
    [TASK_NAME_WIN_LOGON, '/SC ONLOGON'],
  ] as Array<[string, '/SC ONSTART' | '/SC ONLOGON']>) {
    const r = await execFileP('schtasks', baseArgs(name, schedule));
    if (r.code !== 0) {
      notes.push(`failed to register ${name}: ${r.stderr.trim() || `exit ${r.code}`}`);
    } else {
      registered.push(name);
    }
  }

  // Try to also run it now so we don't wait for next logon/boot. Best-effort.
  await execFileP('schtasks', ['/Run', '/TN', TASK_NAME_WIN]).catch(() => undefined);

  return {
    ok: registered.length > 0,
    platform: 'win32',
    registered,
    notes: notes.length ? notes : undefined,
  };
}

async function uninstallWindows(): Promise<UninstallResult> {
  const removed: string[] = [];
  for (const name of [TASK_NAME_WIN, TASK_NAME_WIN_LOGON]) {
    const r = await execFileP('schtasks', ['/Delete', '/TN', name, '/F']);
    if (r.code === 0) removed.push(name);
  }
  return { ok: true, platform: 'win32', removed };
}

// ---------------- macOS ----------------

function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

async function installDarwin(script: string): Promise<InstallResult> {
  const plistPath = launchAgentPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${WATCHDOG_LOG_PATH}</string>
  <key>StandardOutPath</key>
  <string>${WATCHDOG_LOG_PATH}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);
  // Reload to pick up changes idempotently.
  await execFileP('launchctl', ['unload', plistPath]).catch(() => undefined);
  const load = await execFileP('launchctl', ['load', '-w', plistPath]);
  return {
    ok: load.code === 0,
    platform: 'darwin',
    registered: [plistPath],
    notes: load.code === 0 ? undefined : [load.stderr],
  };
}

async function uninstallDarwin(): Promise<UninstallResult> {
  const plistPath = launchAgentPath();
  const removed: string[] = [];
  if (existsSync(plistPath)) {
    await execFileP('launchctl', ['unload', plistPath]).catch(() => undefined);
    try {
      unlinkSync(plistPath);
      removed.push(plistPath);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, platform: 'darwin', removed };
}

// ---------------- Linux ----------------

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

async function installLinux(script: string): Promise<InstallResult> {
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  const unit = `[Unit]
Description=Stavr daemon watchdog
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${script}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit);
  await execFileP('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  const enable = await execFileP('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
  return {
    ok: enable.code === 0,
    platform: 'linux',
    registered: [unitPath],
    notes: enable.code === 0 ? undefined : [enable.stderr],
  };
}

async function uninstallLinux(): Promise<UninstallResult> {
  const unitPath = systemdUnitPath();
  const removed: string[] = [];
  await execFileP('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]).catch(() => undefined);
  if (existsSync(unitPath)) {
    try {
      unlinkSync(unitPath);
      removed.push(unitPath);
    } catch {
      /* ignore */
    }
  }
  await execFileP('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  return { ok: true, platform: 'linux', removed };
}
