import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCcSpawner } from '../../src/workers/cc.js';
import type { WorkerExitInfo, WorkerMetadataInfo, WorkerProgressInfo } from '../../src/workers/types.js';

/**
 * Minimal stand-in for a piped child process. The post-spec-47 cc spawner
 * pipes stdin/stdout/stderr — we need fake streams that emit data when the
 * test pushes lines onto them, plus a stdin sink we can inspect.
 */
class FakeStream extends EventEmitter {
  setEncoding(_enc: string): void {
    /* no-op */
  }
  push(chunk: string): void {
    this.emit('data', chunk);
  }
  endStream(): void {
    this.emit('end');
  }
}

class FakeStdin {
  written: string[] = [];
  ended = false;
  write(s: string): void {
    this.written.push(s);
  }
  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  pid = 9999;
  exitCode: number | null = null;
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();
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

  it('runs git, writes mcp config, and spawns claude directly with stream-json', async () => {
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

    // Post-spec-47: direct spawn of `claude`, no cmd.exe wrapper. Args
    // include the headless stream-json flags so the daemon receives
    // structured events on stdout. Prompt is fed via stdin, not argv.
    expect(spawnArgs?.file).toBe('claude');
    expect(spawnArgs?.args).toContain('--print');
    expect(spawnArgs?.args).toContain('--output-format');
    expect(spawnArgs?.args).toContain('stream-json');
    expect(spawnArgs?.args).toContain('--mcp-config');
    expect(spawnArgs?.args).toContain('.cowire-mcp.json');
    expect(spawnArgs?.args.join(' ')).not.toContain('cmd.exe');

    // The prompt is delivered as a stream-json user message on stdin, then
    // stdin is closed so claude knows input is finished.
    const stdinWrites = (child.stdin as FakeStdin).written.join('');
    expect(stdinWrites).toContain('"role":"user"');
    expect(stdinWrites).toContain('"content":"hello"');
    expect((child.stdin as FakeStdin).ended).toBe(true);
  });

  it('parses stream-json stdout lines into structured progress events', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const child = new FakeChild();
    const watcher = new FakeWatcher();
    const spawner = createCcSpawner({ git, spawn: (() => child) as never, watch: (() => watcher as never) });
    const inst = await spawner.spawn(
      { repo_path: tmp, branch: 'feat/test', base: 'main', prompt: 'hi', cleanup_on_terminate: false, approval_mode: 'normal' },
      ctx,
    );
    const progress: WorkerProgressInfo[] = [];
    inst.events.on('progress', (p) => progress.push(p));

    // Single complete JSONL line — should round-trip as a structured event.
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n');
    await Promise.resolve();
    expect(progress).toHaveLength(1);
    expect(progress[0].message).toBe('claude:assistant');
    expect((progress[0].payload as { format: string }).format).toBe('stream-json');
    expect(((progress[0].payload as { event: { type: string } }).event).type).toBe('assistant');

    // Two lines arriving in three chunks with a partial split — buffering
    // should reassemble both cleanly.
    progress.length = 0;
    child.stdout.push('{"type":"tool_use","na');
    child.stdout.push('me":"Read"}\n{"type":"resu');
    child.stdout.push('lt","cost_usd":0.01}\n');
    await Promise.resolve();
    expect(progress).toHaveLength(2);
    expect(progress[0].message).toBe('claude:tool_use');
    expect(progress[1].message).toBe('claude:result');

    // Non-JSON garbage falls through as a raw progress line so we never
    // silently lose output.
    progress.length = 0;
    child.stdout.push('not valid json\n');
    await Promise.resolve();
    expect(progress).toHaveLength(1);
    expect(progress[0].message).toBe('not valid json');
    expect((progress[0].payload as { format: string }).format).toBe('raw');
  });

  it('forwards stderr lines as stream=stderr progress events', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const child = new FakeChild();
    const watcher = new FakeWatcher();
    const spawner = createCcSpawner({ git, spawn: (() => child) as never, watch: (() => watcher as never) });
    const inst = await spawner.spawn(
      { repo_path: tmp, branch: 'feat/test', base: 'main', prompt: 'hi', cleanup_on_terminate: false, approval_mode: 'normal' },
      ctx,
    );
    const progress: WorkerProgressInfo[] = [];
    inst.events.on('progress', (p) => progress.push(p));

    child.stderr.push('warning: deprecated flag\n');
    child.stderr.push('error: thing went wrong\n');
    await Promise.resolve();
    expect(progress).toHaveLength(2);
    expect(progress[0].message).toBe('warning: deprecated flag');
    expect((progress[0].payload as { stream: string }).stream).toBe('stderr');
    expect(progress[1].message).toBe('error: thing went wrong');
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
