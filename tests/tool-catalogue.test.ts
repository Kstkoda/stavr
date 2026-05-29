import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/tools/catalogue-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CATALOGUE_PATH = join(ROOT, 'docs', 'tool-catalogue.json');
const CARDS_DIR = join(ROOT, 'docs', 'tool-cards');

interface CatalogueEntry {
  name: string;
  tier: string;
  category: string;
  since: string;
  stability: string;
  description: string;
  input_schema: unknown;
  output_schema: unknown;
  side_effects: string[];
  error_modes: string[];
  see_also: string[];
  card_path: string;
}

interface Catalogue {
  schema_version: number;
  generated_at: string;
  tools: CatalogueEntry[];
}

/**
 * Collect every tool name registered with `server.registerTool(<lit>, ...)`.
 * Reading the source as text lets us assert the catalogue matches the actual
 * MCP surface without instantiating the full server (which has SQLite + gh
 * subprocess dependencies that aren't worth setting up here).
 */
function extractRegisteredToolNames(): string[] {
  // worker-dispatch Phase 3c.2 — src/workers/tools.ts deleted with the
  // bespoke worker subsystem; src/jobs/tools.ts is the job_* surface.
  const sources = [
    'src/server.ts',
    'src/tools/decisions.ts',
    'src/adapters/github.ts',
    'src/adapters/github-writes.ts',
    'src/jobs/tools.ts',
    'src/trust/tools.ts',
  ];
  const names = new Set<string>();
  const re = /server\.registerTool\(\s*['"`]([^'"`]+)['"`]/g;
  for (const rel of sources) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      names.add(m[1]);
    }
    re.lastIndex = 0;
  }
  return [...names].sort();
}

describe('tool catalogue', () => {
  it('docs/tool-catalogue.json exists and parses', () => {
    expect(existsSync(CATALOGUE_PATH)).toBe(true);
    const raw = readFileSync(CATALOGUE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Catalogue;
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(parsed.tools.length).toBeGreaterThan(0);
  });

  it('catalogue references every registered MCP tool', () => {
    const registered = extractRegisteredToolNames();
    const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Catalogue;
    const catalogueNames = new Set(catalogue.tools.map((t) => t.name));
    const missing = registered.filter((n) => !catalogueNames.has(n));
    expect(missing, `tools registered but missing from catalogue: ${missing.join(', ')}`).toEqual([]);
  });

  it('catalogue does not include tools that no longer exist in source', () => {
    const registered = new Set(extractRegisteredToolNames());
    const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Catalogue;
    const orphan = catalogue.tools.map((t) => t.name).filter((n) => !registered.has(n));
    expect(orphan, `catalogue tools not actually registered: ${orphan.join(', ')}`).toEqual([]);
  });

  it('every catalogue entry has a card file on disk', () => {
    const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Catalogue;
    for (const entry of catalogue.tools) {
      const cardPath = join(ROOT, entry.card_path);
      expect(existsSync(cardPath), `missing card: ${entry.card_path}`).toBe(true);
      // Normalize CRLF → LF so Windows checkouts (autocrlf=true) match.
      const body = readFileSync(cardPath, 'utf8').replace(/\r\n/g, '\n');
      // Frontmatter sanity.
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toContain(`name: ${entry.name}`);
      expect(body).toContain(`tier: ${entry.tier}`);
      expect(body).toContain('## Input schema');
      expect(body).toContain('## Output schema');
    }
  });

  it('TOOL_DEFINITIONS and catalogue agree on tool set + tier', () => {
    const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Catalogue;
    const defByName = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));
    for (const entry of catalogue.tools) {
      const def = defByName.get(entry.name);
      expect(def, `catalogue has ${entry.name} but TOOL_DEFINITIONS does not`).toBeDefined();
      expect(entry.tier).toBe(def!.tier);
      expect(entry.category).toBe(def!.category);
      expect(entry.since).toBe(def!.since);
      expect(entry.stability).toBe(def!.stability);
    }
  });

  it('every card filename follows the dot→underscore convention', () => {
    const cards = readdirSync(CARDS_DIR).filter((f) => f.endsWith('.md'));
    expect(cards.length).toBeGreaterThan(0);
    for (const f of cards) {
      // Filenames must be lowercase a-z, 0-9, underscores, ending in .md.
      expect(f).toMatch(/^[a-z0-9_]+\.md$/);
    }
  });

  it('schemas in catalogue are JSON-Schema-shaped (object or union)', () => {
    const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Catalogue;
    for (const entry of catalogue.tools) {
      const schema = entry.input_schema as Record<string, unknown> | undefined;
      expect(schema).toBeTruthy();
      // Input schemas must be objects at the top level (MCP tools take a record).
      expect(schema!.type, `${entry.name} input is not an object schema`).toBe('object');
    }
  });
});
