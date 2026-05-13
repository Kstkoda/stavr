import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Spec 51 resilience principles — atomic write-rename.
 *
 * Replaces direct writeFileSync(path, content) calls with a tmp-file-write
 * followed by an OS-level rename. Readers either see the prior contents or
 * the new contents — never a partially-written file. Avoids the failure mode
 * where a daemon crash mid-write leaves a corrupt PID file, MCP config, or
 * credential blob behind.
 */
export function safeWrite(
  path: string,
  content: string | Buffer,
  opts: { mode?: number; encoding?: BufferEncoding } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    if (typeof content === 'string') {
      writeFileSync(tmp, content, { encoding: opts.encoding ?? 'utf8', mode: opts.mode });
    } else {
      writeFileSync(tmp, content, { mode: opts.mode });
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}
