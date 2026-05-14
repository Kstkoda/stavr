/**
 * Tiny structured logger. Two modes:
 *  - 'text': legacy `[stavr] <msg>` to stderr (backward-compatible default).
 *  - 'json': newline-delimited JSON `{ts, level, msg, ...metadata}` to stderr.
 *
 * Process-wide singleton, configurable once at startup via `configureLogger`.
 * `getLogger` returns the active instance for any module that needs it.
 */

export type LogFormat = 'text' | 'json';

export interface Logger {
  info(msg: string, metadata?: Record<string, unknown>): void;
  warn(msg: string, metadata?: Record<string, unknown>): void;
  error(msg: string, metadata?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  format: LogFormat;
  /** Defaults to 'stavr'. Used as the `[prefix]` in text mode and the `component` field in JSON. */
  component?: string;
  /** Defaults to process.stderr.write. Test seam. */
  sink?: (line: string) => void;
}

function defaultSink(line: string): void {
  process.stderr.write(line + '\n');
}

function format(opts: Required<Pick<LoggerOptions, 'format' | 'component'>>, level: 'info' | 'warn' | 'error', msg: string, metadata?: Record<string, unknown>): string {
  if (opts.format === 'json') {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: opts.component,
      msg,
    };
    if (metadata && Object.keys(metadata).length > 0) record.metadata = metadata;
    return JSON.stringify(record);
  }
  // text mode: preserve legacy `[stavr] ...` shape; warn/error get a hint.
  const tag = level === 'info' ? '' : level.toUpperCase() + ': ';
  const meta = metadata && Object.keys(metadata).length > 0 ? ` ${safeJson(metadata)}` : '';
  return `[${opts.component}] ${tag}${msg}${meta}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

export function makeLogger(opts: LoggerOptions): Logger {
  const cfg = { format: opts.format, component: opts.component ?? 'stavr' };
  const sink = opts.sink ?? defaultSink;
  return {
    info: (msg, metadata) => sink(format(cfg, 'info', msg, metadata)),
    warn: (msg, metadata) => sink(format(cfg, 'warn', msg, metadata)),
    error: (msg, metadata) => sink(format(cfg, 'error', msg, metadata)),
  };
}

let active: Logger = makeLogger({ format: 'text' });

export function configureLogger(opts: LoggerOptions): Logger {
  active = makeLogger(opts);
  return active;
}

export function getLogger(): Logger {
  return active;
}

export function parseLogFormat(raw: string | undefined): LogFormat {
  if (raw === 'json') return 'json';
  return 'text';
}
