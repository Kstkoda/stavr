/**
 * Phase 4 tests for src/governor/os-cap.ts.
 *
 * Tests platform branches via platformOverride and the filesystem via the
 * `fs` test seam — no real cgroup writes happen.
 */
import { describe, expect, it } from 'vitest';
import { installOsCap } from '../../src/governor/os-cap.js';
import { DEFAULT_HOST_CEILING } from '../../src/types/host-ceiling.js';

interface FsCall {
  op: 'mkdir' | 'write' | 'read' | 'exists';
  path: string;
  data?: string;
}

function makeFakeFs(opts: {
  existing: Set<string>;
  controllers?: string;
  failWrite?: string; // path that should throw on write
}) {
  const calls: FsCall[] = [];
  return {
    calls,
    fs: {
      existsSync: (p: string) => {
        calls.push({ op: 'exists', path: p });
        return opts.existing.has(p);
      },
      readFileSync: (p: string, _enc: 'utf8') => {
        calls.push({ op: 'read', path: p });
        if (p.endsWith('cgroup.controllers')) return opts.controllers ?? '';
        return '';
      },
      writeFileSync: (p: string, data: string) => {
        calls.push({ op: 'write', path: p, data });
        if (opts.failWrite && p === opts.failWrite) {
          throw new Error('EACCES');
        }
      },
      mkdirSync: (p: string, _o: { recursive: true }) => {
        calls.push({ op: 'mkdir', path: p });
        opts.existing.add(p);
      },
    },
  };
}

describe('installOsCap', () => {
  it('returns kind=none when ceiling is disabled', () => {
    const r = installOsCap({
      ceiling: { ...DEFAULT_HOST_CEILING, enabled: false },
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'linux',
    });
    expect(r).toEqual({ kind: 'none', installed: false, reason: 'host_ceiling.enabled=false' });
  });

  it('returns kind=none with a clear reason on Windows', () => {
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'win32',
    });
    expect(r.kind).toBe('none');
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/Job Object/);
    expect(r.reason).toMatch(/stavr-jobobject\.ps1/);
  });

  it('returns kind=none on macOS pointing at the launchd recipe', () => {
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'darwin',
    });
    expect(r.kind).toBe('none');
    expect(r.reason).toMatch(/launchd/);
  });

  it('linux: refuses gracefully when cgroup.controllers is missing', () => {
    const { fs } = makeFakeFs({ existing: new Set() });
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'linux',
      cgroupRootOverride: '/sys/fs/cgroup',
      fs,
    });
    expect(r).toEqual({
      kind: 'none',
      installed: false,
      reason: expect.stringMatching(/cgroup-v2 not detected/),
    });
  });

  it('linux: refuses gracefully when neither memory nor cpu controller is delegated', () => {
    const { fs } = makeFakeFs({
      existing: new Set(['/sys/fs/cgroup/cgroup.controllers']),
      controllers: 'pids io',
    });
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'linux',
      cgroupRootOverride: '/sys/fs/cgroup',
      fs,
    });
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/delegated subtree/);
  });

  it('linux: installs cap, writes memory.max + cpu.max + cgroup.procs', () => {
    const { fs, calls } = makeFakeFs({
      existing: new Set(['/sys/fs/cgroup/cgroup.controllers']),
      controllers: 'cpu io memory pids',
    });
    const total = 16 * 1024 ** 3;
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: total,
      platformOverride: 'linux',
      cgroupRootOverride: '/sys/fs/cgroup',
      fs,
      pid: 4242,
      cpuCountOverride: 8,
    });
    expect(r.kind).toBe('cgroup-v2');
    expect(r.installed).toBe(true);
    // memory cap should be min(75% of total, total - 2GB)
    const ramPct = Math.floor(total * 0.75);
    const ramFloor = total - 2 * 1024 ** 3;
    expect(r.memory_max_bytes).toBe(Math.min(ramPct, ramFloor));

    const writes = calls.filter((c) => c.op === 'write');
    const writePaths = writes.map((c) => c.path);
    expect(writePaths).toContain('/sys/fs/cgroup/stavr.scope/memory.max');
    expect(writePaths).toContain('/sys/fs/cgroup/stavr.scope/cpu.max');
    expect(writePaths).toContain('/sys/fs/cgroup/stavr.scope/cgroup.procs');
    const procsWrite = writes.find((c) => c.path.endsWith('cgroup.procs'));
    expect(procsWrite!.data).toBe('4242');
    const cpuWrite = writes.find((c) => c.path.endsWith('cpu.max'));
    expect(cpuWrite!.data).toBe('680000 100000'); // 0.85 * 100000 * 8 cores
  });

  it('linux: returns installed=false with a reason when memory.max write fails (EPERM)', () => {
    const { fs } = makeFakeFs({
      existing: new Set(['/sys/fs/cgroup/cgroup.controllers']),
      controllers: 'cpu memory',
      failWrite: '/sys/fs/cgroup/stavr.scope/memory.max',
    });
    const r = installOsCap({
      ceiling: DEFAULT_HOST_CEILING,
      hostTotalRamBytes: 16 * 1024 ** 3,
      platformOverride: 'linux',
      cgroupRootOverride: '/sys/fs/cgroup',
      fs,
    });
    expect(r.kind).toBe('cgroup-v2');
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/memory\.max/);
  });

  it('cpu.max quota scales with max_sustained_cpu_pct and host core count', () => {
    // 4 cores at 50% → 0.5 * 100000 * 4 = 200000
    {
      const { fs, calls } = makeFakeFs({
        existing: new Set(['/sys/fs/cgroup/cgroup.controllers']),
        controllers: 'cpu memory',
      });
      installOsCap({
        ceiling: { ...DEFAULT_HOST_CEILING, max_sustained_cpu_pct: 0.5 },
        hostTotalRamBytes: 16 * 1024 ** 3,
        platformOverride: 'linux',
        cgroupRootOverride: '/sys/fs/cgroup',
        fs,
        cpuCountOverride: 4,
      });
      const cpuWrite = calls.find((c) => c.op === 'write' && c.path.endsWith('cpu.max'));
      expect(cpuWrite!.data).toBe('200000 100000');
    }
    // 32 cores at 85% → 0.85 * 100000 * 32 = 2720000 — must NOT be the
    // single-core 85000 (the pre-fix bug throttled the whole tree to <1 core).
    {
      const { fs, calls } = makeFakeFs({
        existing: new Set(['/sys/fs/cgroup/cgroup.controllers']),
        controllers: 'cpu memory',
      });
      installOsCap({
        ceiling: DEFAULT_HOST_CEILING,
        hostTotalRamBytes: 16 * 1024 ** 3,
        platformOverride: 'linux',
        cgroupRootOverride: '/sys/fs/cgroup',
        fs,
        cpuCountOverride: 32,
      });
      const cpuWrite = calls.find((c) => c.op === 'write' && c.path.endsWith('cpu.max'));
      expect(cpuWrite!.data).toBe('2720000 100000');
    }
  });
});
