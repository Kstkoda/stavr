// Spec 49 Layer 1 — provider abstraction.
//
// Providers are pluggable LLM backends the agent loop calls. v1 supports:
//   - anthropic: direct https://api.anthropic.com/v1/messages
//   - claude-code: a Claude Code subprocess speaking stream-json (Max OAuth path)

export interface StewardMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StewardToolSpec {
  name: string;
  description: string;
  /** JSON-Schema for the tool's args. */
  input_schema: Record<string, unknown>;
}

export interface StewardToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StewardUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
}

export type StewardEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; call: StewardToolCall }
  | { kind: 'usage'; usage: StewardUsage }
  | { kind: 'done'; stop_reason?: string };

export interface StewardCompleteOpts {
  systemPrompt: string;
  messages: StewardMessage[];
  tools: StewardToolSpec[];
  maxTokens?: number;
  /** Per-call override for the provider's model (mostly tests). */
  model?: string;
}

export interface StewardProvider {
  readonly name: string;
  /** Defaults — the loop overrides per call when needed. */
  readonly defaultModel: string;
  complete(opts: StewardCompleteOpts): AsyncGenerator<StewardEvent>;
}
