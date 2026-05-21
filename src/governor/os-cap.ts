/**
 * OS-level hard cap (Phase 4 of host-resource-ceiling BOM).
 *
 * The point: even if admission control (Phase 3) has a bug, the daemon's
 * process tree physically cannot exceed the configured ceiling. Per-platform
 * primitives:
 *
 *   - Linux: cgroup v2. Detect the controllers, create a child cgroup,
 *     write memory.max / cpu.max, move self into it. Requires a delegated
 *     subtree (systemd-user-session default for user.slice). EPERM is
 *     expected on legacy distros / locked-down hosts; we swallow + log.
 *
 *   - Windows: Job Objects are the right primitive but creating one needs
 *     a native addon or PowerShell trampoline. v1 ships an opt-in helper
 *     script (bin/stavr-jobobject.ps1) that the operator can wrap their
 *     daemon-start command in. The PM2 max_memory_restart in
 *     ecosystem.config.cjs is the practical surrogate when the operator
 *     hasn't wrapped.
 *
 *   - macOS: documented launchd plist (docs/host-resource-ceiling.md).
 *     No auto-install in v1.
 *
 * The installer is fail-open. If the OS cap can't be installed, the daemon
 * still boots — Phase 3 admission control and Phase 5 load-shedding remain.
 * The host-resource-ceiling design has three independent layers on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix as posixPath } from 'node:path';
import { cpus, platform } from 'node:os';

// cgroup paths are always POSIX even when tests run on Windows.
const cgroupJoin = posixPath.join;
import type { HostCeiling } from '../types/host-ceiling.js';

export type OsCapKind = 'cgroup-v2' | 'job-object' | 'launchd' | 'none';

export interface OsCapResult {
  /** Which OS primitive (if any) installed the cap. */
  kind: OsCapKind;
  /** True when the cap is actually in force; false otherwise. */
  installed: boolean;
  /**
   * Human-readable detail. Always present on failure; optional on success
   * (filled in when there's something useful to surface, e.g. the cgroup
   * path).
   */
  reason?: string;
  /**
   * Numeric bytes value written for the memory cap, when known. Used by
   * Phase 6 (dashboard) to show "OS cap: 24 GB memory.max".
   */
  memory_max_bytes?: number;
}

export interface InstallOsCapOpts {
  ceiling: HostCeiling;
  /**
   * Total host RAM in bytes — supplied by the caller (typically
   * `os.totalmem()` at boot). Decoupled from `node:os` so tests can drive
   * the math.
   */
  hostTotalRamBytes: number;
  /** Override platform detection (tests). */
  platformOverride?: NodeJS.Platform;
  /** Override the cgroup root path (tests). */
  cgroupRootOverride?: string;
  /**
   * Override the host logical-CPU count used for the cpu.max quota (tests).
   * Defaults to `os.cpus().length`.
   */
  cpuCountOverride?: number;
  /** Filesystem seam for tests. */
  fs?: {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, enc: 'utf8') => string;
    writeFileSync: (p: string, data: string) => void;
    mkdirSync: (p: string, opts: { recursive: true }) => void;
  };
  /**
   * Process PID (defaults to `process.pid`). Tests pass a fixed value so
   * cgroup.procs assertions don't depend on the test runner's PID.
   */
  pid?: number;
}

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
const STAVR_CGROUP_NAME = 'stavr.scope';

/**
 * Attempt to install the OS-level hard cap. Returns immediately; never throws.
 * Caller emits `host_ceiling_os_cap` with the returned result.
 */
export function installOsCap(opts: InstallOsCapOpts): OsCapResult {
  const plat = opts.platformOverride ?? platform();

  if (!opts.ceiling.enabled) {
    return { kind: 'none', installed: false, reason: 'host_ceiling.enabled=false' };
  }

  if (plat === 'linux') {
    return installCgroupV2(opts);
  }
  if (plat === 'win32') {
    return {
      kind: 'none',
      installed: false,
      reason:
        'windows: Job Object cap is operator-installed via bin/stavr-jobobject.ps1 wrapper. ' +
        'PM2 max_memory_restart in ecosystem.config.cjs is the soft-cap surrogate.',
    };
  }
  if (plat === 'darwin') {
    return {
      kind: 'none',
      installed: false,
      reason: 'macos: see docs/host-resource-ceiling.md for the launchd plist recipe (not auto-installed in v1)',
    };
  }
  return { kind: 'none', installed: false, reason: `unsupported platform: ${plat}` };
}

function installCgroupV2(opts: InstallOsCapOpts): OsCapResult {
  const fs = opts.fs ?? {
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc),
    writeFileSync: (p, data) => writeFileSync(p, data),
    mkdirSync: (p, o) => { mkdirSync(p, o); },
  };
  const cgroupRoot = opts.cgroupRootOverride ?? DEFAULT_CGROUP_ROOT;
  const pid = opts.pid ?? process.pid;

  // Detection: cgroup v2 always has a `cgroup.controllers` file at the
  // root; v1 has per-controller dirs (`cpu/`, `memory/`) instead.
  const controllersPath = cgroupJoin(cgroupRoot, 'cgroup.controllers');
  if (!fs.existsSync(controllersPath)) {
    return {
      kind: 'none',
      installed: false,
      reason: `cgroup-v2 not detected at ${cgroupRoot} (missing cgroup.controllers)`,
    };
  }

  let controllers: string;
  try {
    controllers = fs.readFileSync(controllersPath, 'utf8');
  } catch (err) {
    return {
      kind: 'none',
      installed: false,
      reason: `cgroup-v2 detected but cgroup.controllers unreadable: ${(err as Error).message}`,
    };
  }

  const hasMemory = controllers.includes('memory');
  const hasCpu = controllers.includes('cpu');
  if (!hasMemory && !hasCpu) {
    return {
      kind: 'none',
      installed: false,
      reason: 'cgroup-v2 root has neither memory nor cpu controller — delegated subtree missing?',
    };
  }

  const scopePath = cgroupJoin(cgroupRoot, STAVR_CGROUP_NAME);
  try {
    fs.mkdirSync(scopePath, { recursive: true });
  } catch (err) {
    return {
      kind: 'cgroup-v2',
      installed: false,
      reason: `mkdir ${scopePath} failed: ${(err as Error).message}`,
    };
  }

  // memory.max in bytes — choose the more restrictive of pct and floor.
  const ramPctCap = Math.floor(opts.hostTotalRamBytes * opts.ceiling.max_host_ram_pct);
  const ramFloorCap = opts.hostTotalRamBytes - Math.floor(opts.ceiling.min_free_ram_gb * 1024 ** 3);
  const memoryMax = Math.max(0, Math.min(ramPctCap, ramFloorCap));

  let memWritten = false;
  if (hasMemory) {
    try {
      fs.writeFileSync(cgroupJoin(scopePath, 'memory.max'), String(memoryMax));
      memWritten = true;
    } catch (err) {
      return {
        kind: 'cgroup-v2',
        installed: false,
        reason: `write memory.max failed: ${(err as Error).message}`,
        memory_max_bytes: memoryMax,
      };
    }
  }

  // cpu.max format: "<quota> <period>" in microseconds. cgroup v2 quota is
  // per-period CPU time and is NOT summed across cores by the kernel — to
  // allow N cores' worth of CPU you must write quota = N * period. So an
  // 85% cap on an 8-core host is 0.85 * 8 * 100000. Without the core-count
  // factor the cap throttles stavR's whole process tree to under one core.
  if (hasCpu) {
    const period = 100_000;
    const cpuCount = Math.max(1, opts.cpuCountOverride ?? cpus().length);
    const quota = Math.max(
      1_000,
      Math.floor(opts.ceiling.max_sustained_cpu_pct * period * cpuCount),
    );
    try {
      fs.writeFileSync(cgroupJoin(scopePath, 'cpu.max'), `${quota} ${period}`);
    } catch (err) {
      return {
        kind: 'cgroup-v2',
        installed: memWritten,
        reason: `write cpu.max failed: ${(err as Error).message}`,
        memory_max_bytes: memoryMax,
      };
    }
  }

  // Move ourselves into the scope. After this, all child processes inherit.
  try {
    fs.writeFileSync(cgroupJoin(scopePath, 'cgroup.procs'), String(pid));
  } catch (err) {
    return {
      kind: 'cgroup-v2',
      installed: false,
      reason: `write cgroup.procs failed: ${(err as Error).message}`,
      memory_max_bytes: memoryMax,
    };
  }

  return {
    kind: 'cgroup-v2',
    installed: true,
    reason: `installed at ${scopePath}`,
    memory_max_bytes: memoryMax,
  };
}
