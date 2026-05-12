import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultDbPath(): string {
  return join(homedir(), '.cowire', 'cowire.db');
}
