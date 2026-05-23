// Barrel re-export for the persistence port. Consumers import from
// `'../db/index.js'` (or matching relative path); the engine is opaque.
export { openDatabase } from './port.js';
export type { Database, OpenOptions } from './port.js';
