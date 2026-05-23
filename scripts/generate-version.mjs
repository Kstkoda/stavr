#!/usr/bin/env node
// Bombardment Phase 0 — build-time version bake.
//
// Reads package.json#version and writes src/version.generated.ts so the
// daemon's /status endpoint reports the right version on every launch
// path (npm start, node dist/cli.js, the SEA bundle, the Governor
// sidecar, the Windows Service). A runtime package.json read would not
// work in the SEA — there is no package.json on disk.
//
// Hooked into prebuild / prestart / predev / pretest / pretypecheck so
// any npm-run path regenerates the file before it is needed. The file
// is also committed so a fresh checkout builds without running the
// generator first.
//
// Drift is harmless: if the committed file diverges from package.json,
// the next `npm run *` regenerates it. CI's `tsc` step picks up
// whichever is fresher.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const pkgPath = resolve(repoRoot, 'package.json');
const outPath = resolve(repoRoot, 'src', 'version.generated.ts');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  throw new Error(`generate-version: package.json#version is missing or not a string (got ${JSON.stringify(version)})`);
}

const content =
  `// AUTO-GENERATED at build time by scripts/generate-version.mjs from\n` +
  `// package.json#version. Do not edit by hand; regenerated on prebuild,\n` +
  `// prestart, predev, pretest, and pretypecheck. Committed so a fresh\n` +
  `// checkout compiles without running the generator first.\n` +
  `//\n` +
  `// Bombardment Phase 0 — see proposed/bombardment-rig-bom.md. The bake\n` +
  `// is build-time (not runtime package.json read) so /status reports the\n` +
  `// right version in the SEA bundle, the Governor sidecar, and the\n` +
  `// Windows Service paths where package.json is not on disk.\n` +
  `export const STAVR_VERSION = ${JSON.stringify(version)};\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, 'utf8');
process.stdout.write(`generate-version: wrote ${outPath} (STAVR_VERSION = ${version})\n`);
