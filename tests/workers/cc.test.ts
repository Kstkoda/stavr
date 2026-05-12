import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCcSpawner } from '../../src/workers/cc.js';
import type { WorkerExitInfo, WorkerMetadataInfo } from '../../src/workers/types.js';

class FakeChild extends EventEmitter {
  pid = 9999;
  exitCode: number | null = null;
  kill(_sig?: string | number): boolean {
    return true;
  }
}

class FakeWatcher extends EventEmitter {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

const ctx = {
  workerId: 'cc-wid',
  workerName: 'cc-w',
  broker: {} as never,
  store: {} as never,
  emit: async () => {},
};

describe('cc spawner', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cowire-cc-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs git, writes mcp config, and launches claude in a cmd window', async () => {
    const gitCalls: string[][] = [];
    const git = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        // origin/<base> rev-parse exists; everything else passes
        return { stdout: 'abc', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const child = new FakeChild();
    let spawnArgs: { file: string; args: string[] } | undefined;
    const spawnFn = ((file: string, args: string[]) => {
      spawnArgs = { file, args };
      return child;
    }) as never;

    const watcher = new FakeWatcher();
    const watchFn = () => watcher as never;

    const spawner = createCcSpawner({ git, spawn: spawnFn, watch: watchFn });

    const inst = await spawner.spawn(
      {
        repo_path: tmp,
        branch: 'feat/test',
        base: 'main',
        prompt: 'hello',
        approval_mode: 'normal',
        cleanup_on_terminate: false,
      },
      ctx,
    );

    // Worktree path created under tmp/.cowire-worktrees/cc-w
    const expectedWorktree = join(tmp, '.cowire-worktrees', 'cc-w');
    expect(inst.metadata.worktree_path).toBe(expectedWorktree);

    // git commands invoked in order: rev-parse --git-dir, fetch, rev-parse --verify origin/main, worktree add
    const verbs = gitCalls.map((c) => c.slice(0, 2).join(' '));
    expect(verbs).toContain('rev-parse --git-dir');
    expect(verbs).toContain('fetch origin');
    expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true);

    // mcp config written (spawner creates the dir defensively when git is mocked)
    const mcp = join(expectedWorktree, '.cowire-mcp.json');
    expect(existsSync(mcp)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcp, 'utf8'));
    expect(parsed.mcpServers.cowire.type).toBe('sse');

    expect(spawnArgs?.file).toBe('cmd.exe');
    expect(spawnArgs?.args[0]).toBe('/c');
    expect(spawnArgs?.args[1]).toBe('start');
    expect(spawnArgs?.args.join(' ')).toContain('cc:cc-w');
    expect(spawnArgs?.args.join(' ')).toContain('claude');
  });

  it('chokidar change events emit metadata within 100ms', async () => {
    const git = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === 'status') {
        return {
          stdout:
            '# branch.head feat/test\n# branch.oid abc123\n# branch.ab +1 -0\n1 M. N... 100644 100644 100644 aaa bbb file.txt\n',
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    };
    const child = new FakeChild();
    const watcher = new FakeWatcher();
    const spawner = createCcSpawner({
      git,
      spawn: (() => child) as never,
      watch: (() => watcher as never),
    });
    const inst = await spawner.spawn(
      { repo_path: tmp, branch: 'feat/test', base: 'main', prompt: 'hi', cleanup_on_terminate: false, approval_mode: 'normal' },
      ctx,
    );

    const metadataEvents: WorkerMetadataInfo[] = [];
    inst.events.on('metadata', (m) => metadataEvents.push(m));

    const start = Date.now();
    watcher.emit('all', 'change', join(tmp, '.cowire-worktrees', 'cc-w', '.git', 'HEAD'));
    // Wait up to 200ms for the async readGitState to finish.
    while (metadataEvents.length === 0 && Date.now() - start < 200) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsed = Date.now() - start;

    expect(metadataEvents).toHaveLength(1);
    expect(elapsed).toBeLessThan(100);
    const patch = metadataEvents[0].patch as { git?: { branch?: string; ahead?: number } };
    expect(patch.git?.branch).toBe('feat/test');
    expect(patch.git?.ahead).toBe(1);
  });

  it('child exit(0) emits exit reason completed and closes watcher', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const child = new FakeChild();
    const watcher = new FakeWatcher();
    const spawner = createCcSpawner({ git, spawn: (() => child) as never, watch: (() => watcher as never) });
    const inst = await spawner.spawn(
      { repo_path: tmp, branch: 'feat/test', base: 'main', prompt: 'hi', cleanup_on_terminate: false, approval_mode: 'normal' },
      ctx,
    );
    const exits: WorkerExitInfo[] = [];
    inst.events.on('exit', (e) => exits.push(e));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('completed');
    expect(watcher.closed).toBe(true);
  });
});
