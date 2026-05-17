// Internal helper: drain a StewardProvider.complete() async generator to
// concatenated text + usage. Runtimes use this to convert the streaming-
// generator surface into a single-shot "give me the model output" call shape
// that the retry wrapper expects.

import type {
  StewardCompleteOpts,
  StewardEvent,
  StewardProvider,
  StewardUsage,
} from '../../steward/providers/types.js';

export interface DrainedResult {
  text: string;
  usage: StewardUsage;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export async function drainTextAndUsage(
  provider: StewardProvider,
  opts: StewardCompleteOpts,
): Promise<DrainedResult> {
  const chunks: string[] = [];
  const toolCalls: DrainedResult['toolCalls'] = [];
  let usage: StewardUsage = { input_tokens: 0, output_tokens: 0 };
  for await (const ev of provider.complete(opts) as AsyncGenerator<StewardEvent>) {
    if (ev.kind === 'text') chunks.push(ev.text);
    else if (ev.kind === 'tool_call') toolCalls.push(ev.call);
    else if (ev.kind === 'usage') usage = ev.usage;
  }
  return { text: chunks.join(''), usage, toolCalls };
}
