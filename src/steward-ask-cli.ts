import { Command } from 'commander';
import { readPidFile } from './daemon.js';

/**
 * Spec 49 Layer 2 — `cowire ask "…"` CLI.
 *
 * Posts a steward_prompt event to the running daemon, then either:
 *   - default:    waits up to 5 minutes for the matching steward_response and prints it
 *   - --stream:   prints steward_thinking / steward_tool_call events live too
 *   - --json:     emits raw JSONL — one parsed SSE event per line
 *   - --no-wait:  prints the correlation_id and exits immediately
 */
export function registerAskCli(program: Command): void {
  program
    .command('ask')
    .description('Send a prompt to the daemon-hosted Steward (spec 49) and wait for the response.')
    .argument('<text>', 'Question / instruction for the Steward.')
    .option('--stream', 'Print thinking + tool_call events live before the response.')
    .option('--json', 'Output raw JSONL events.')
    .option('--no-wait', 'Fire and forget; print the correlation_id and exit.')
    .option('--timeout-ms <n>', 'Max wait for steward_response (default 300000).', (v) => Number(v), 300_000)
    .action(async (text: string, opts: { stream?: boolean; json?: boolean; wait?: boolean; timeoutMs: number }) => {
      const pid = readPidFile();
      if (!pid || !pid.port) {
        console.error('[cowire] daemon not running — start it with `cowire daemon start`.');
        process.exit(1);
      }
      const post = await fetch(`http://127.0.0.1:${pid.port}/dashboard/steward/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!post.ok) {
        console.error(`[cowire] prompt POST failed: HTTP ${post.status}`);
        process.exit(1);
      }
      const body = (await post.json()) as { ok: boolean; correlation_id?: string; error?: string };
      if (!body.ok || !body.correlation_id) {
        console.error(`[cowire] prompt rejected: ${body.error ?? 'unknown'}`);
        process.exit(1);
      }
      const cid = body.correlation_id;
      if (opts.wait === false) {
        console.log(JSON.stringify({ correlation_id: cid }));
        return;
      }
      await streamResponse({
        url: `http://127.0.0.1:${pid.port}/dashboard/steward/responses?correlation_id=${encodeURIComponent(cid)}`,
        stream: opts.stream === true,
        json: opts.json === true,
        timeoutMs: opts.timeoutMs,
      });
    });
}

interface StreamOpts {
  url: string;
  stream: boolean;
  json: boolean;
  timeoutMs: number;
}

interface SSEParsed {
  event?: string;
  data: string;
}

async function streamResponse(opts: StreamOpts): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let answeredOk = false;
  try {
    const res = await fetch(opts.url, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      console.error(`[cowire] SSE failed: HTTP ${res.status}`);
      process.exit(1);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = parseSseChunks(buf);
      buf = events.remainder;
      for (const ev of events.parsed) {
        if (ev.event === 'ping') continue;
        if (opts.json) {
          process.stdout.write(JSON.stringify(ev) + '\n');
        } else if (ev.event === 'steward_response') {
          const ev2 = safeParse(ev.data) as { payload?: { text?: string } };
          if (ev2?.payload?.text) process.stdout.write(ev2.payload.text + '\n');
          answeredOk = true;
        } else if (opts.stream) {
          if (ev.event === 'steward_thinking') {
            const ev2 = safeParse(ev.data) as { payload?: { text?: string } };
            const t = ev2?.payload?.text;
            if (t) process.stderr.write(`[thinking] ${t}\n`);
          } else if (ev.event === 'steward_tool_call') {
            const ev2 = safeParse(ev.data) as { payload?: { tool?: string } };
            if (ev2?.payload?.tool) process.stderr.write(`[tool] ${ev2.payload.tool}\n`);
          }
        }
        if (ev.event === 'steward_response') {
          clearTimeout(timer);
          controller.abort();
          return;
        }
      }
    }
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === 'AbortError' && answeredOk) return;
    if (e.name === 'AbortError') {
      console.error(`[cowire] timed out after ${opts.timeoutMs}ms`);
      process.exit(2);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseSseChunks(buf: string): { parsed: SSEParsed[]; remainder: string } {
  const parsed: SSEParsed[] = [];
  const blocks = buf.split('\n\n');
  const remainder = blocks.pop() ?? '';
  for (const block of blocks) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    parsed.push({ event, data: dataLines.join('\n') });
  }
  return { parsed, remainder };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
