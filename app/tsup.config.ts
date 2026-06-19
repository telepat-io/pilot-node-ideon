/**
 * tsup build config for the io.telepat.ideon-free app.
 *
 * Single entrypoint bundled to one self-contained, self-executing file:
 *   - bin/main.mjs  process entry (package.json bin)
 *
 * No external SDK: everything is bundled (only node builtins stay external, as
 * they auto-resolve at runtime), so the catalogue install needs just this file.
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'bin',
  clean: true,
  // The app-store supervisor execs the binary DIRECTLY (no `node` prefix),
  // so bin/main.mjs must be self-executing.
  banner: { js: '#!/usr/bin/env node' },
  outExtension() {
    return { js: '.mjs' };
  },
  splitting: false,
  sourcemap: false,
  // tsc-style type checking is run separately via `npm run typecheck`.
  dts: false,
});
