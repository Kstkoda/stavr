// src/bricks/registry.ts
//
// Re-export the installer + manifest as a single import surface.

export { createBrickInstaller, defaultBricksRoot, type BrickInstaller, type InstalledBrickRecord, type BrickFactory, type InstallerOpts } from './installer.js';
export { BrickManifestSchema, parseBrickManifest, type BrickManifest } from './manifest.js';
