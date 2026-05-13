import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type {
  StewardCompleteOpts,
  StewardEvent,
  StewardProvider,
  StewardToolCall,
} from './types.js';

/**
 * Spec 49 Layer 1 — claude-code provider.
 *
 * Spawns a `claude` subprocess in headless `--print --output-format stream-json`
 * mode (same flags the cc worker spawner uses) and proxies the stream-json
 * events back as StewardEvents. Lets the Steward route through Claude Max
 * OAuth instead of per-token API billing.
 *
 * Note: this provider does NOT pass tools to claude (the `claude` CLI doesn't
 * accept a tool list on argv). Tool invocations the Steward wants to make
 * must be returned as text the loop interprets, OR the loop must call the
 * tools itself based on assistant directives. For v1 the provider yields
 * 'text' events and the agent loop treats text-only responses as user-facing.
 */

export interface ClaudeCodeProviderOpts {
  /** Override the path to the `claude` binary (default: PATH lookup). */
  binary?: string;
  /** Test seam — replaces nodeSpawn for unit tests. */
  spawn?: typeof nodeSpawn;
  /** Working directory for the subprocess (defaults to process.cwd()). */
  cwd?: string;
  model?: string;
}

interface StreamJsonEvent {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }> };
  cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string;
}

export function makeClaudeCodeProvider(opts: ClaudeCodeProviderOpts = {}): StewardProvider {
  const spawnFn = opts.spawn ?? nodeSpawn;
  const binary = opts.binary ?? 'claude';
  const defaultModel = opts.model ?? 'claude-opus-4-7';

  return {
    name: 'claude-code',
    defaultModel,
    complete(call: StewardCompleteOpts): AsyncGenerator<StewardEvent> {
      return runClaudeSubprocess({
        spawnFn,
        binary,
        cwd: opts.cwd,
        model: call.model ?? defaultModel,
        maxTokens: call.maxTokens,
        systemPrompt: call.systemPrompt,
        messages: call.messages,
      });
    },
  };
}

interface RunOpts {
  spawnFn: typeof nodeSpawn;
  binary: string;
  cwd?: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

async function* runClaudeSubprocess(opts: RunOpts): AsyncGenerator<StewardEvent> {
  const args = ['--print', '--output-format', 'stream-json', '--model', opts.model];
  const isWin = process.platform === 'win32';
  let child: ChildProcess;
  if (isWin) {
    child = opts.spawnFn('cmd.exe', ['/d', '/s', '/c', opts.binary, ...args], {
      cwd: opts.cwd,
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    child = opts.spawnFn(opts.binary, args, { cwd: opts.cwd, stdio: 'pipe' });
  }

  // Compose stream-json input on stdin: system + alternating user/assistant.
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'system', system: opts.systemPrompt }));
  for (const m of opts.messages.filter((x) => x.role !== 'system')) {
    lines.push(
      JSON.stringify({ type: m.role === 'assistant' ? 'assistant' : 'user', message: { role: m.role, content: m.content } }),
    );
  }
  if (child.stdin) {
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  }

  type Q = StewardEvent;
  const queue: Q[] = [];
  let done = false;
  let resolveWaiter: ((v: void) => void) | undefined;
  const wake = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = undefined;
      r();
    }
  };
  let stdoutBuf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as StreamJsonEvent;
        for (const out of mapEvent(ev)) queue.push(out);
        wake();
      } catch {
        // non-json line — treat as raw text passthrough
        queue.push({ kind: 'text', text: line });
        wake();
      }
    }
  });
  child.on('exit', () => {
    done = true;
    wake();
  });
  child.on('error', () => {
    done = true;
    wake();
  });

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const next = queue.shift()!;
      yield next;
    }
    if (done) break;
    await new Promise<void>((r) => (resolveWaiter = r));
  }
  yield { kind: 'done' };
}

function mapEvent(ev: StreamJsonEvent): StewardEvent[] {
  if (ev.type === 'assistant') {
    const out: StewardEvent[] = [];
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ kind: 'text', text: block.text });
      if (block.type === 'tool_use' && block.name) {
        const call: StewardToolCall = {
          id: block.id ?? '',
          name: block.name,
          args: block.input ?? {},
        };
        out.push({ kind: 'tool_call', call });
      }
    }
    return out;
  }
  if (ev.type === 'result' && (ev.usage || ev.cost_usd !== undefined)) {
    return [
      {
        kind: 'usage',
        usage: {
          input_tokens: ev.usage?.input_tokens ?? 0,
          output_tokens: ev.usage?.output_tokens ?? 0,
          cache_read_tokens: ev.usage?.cache_read_input_tokens,
          cache_creation_tokens: ev.usage?.cache_creation_input_tokens,
          cost_usd: ev.cost_usd,
        },
      },
    ];
  }
  return [];
}
