/**
 * tsup build config for the io.telepat.ideon-article app.
 *
 * Two entrypoints are emitted as SEPARATE files (no bundling between them) so
 * the runtime worker loader can resolve `./pilotServerWorker.js` next to
 * `main.js`:
 *   - bin/main.js               process entry (package.json bin)
 *   - bin/pilotServerWorker.js  Worker thread that owns the blocking sdk-node FFI
 *
 * `pilotprotocol` is kept EXTERNAL: it loads a native FFI library at runtime and
 * must not be bundled. Node built-ins are external by default.
 */

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/pilotServerWorker.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'bin',
  clean: true,
  // The app-store supervisor execs the binary DIRECTLY (no `node` prefix),
  // so bin/main.js must be self-executing. Node strips the shebang when a file
  // is imported (e.g. the worker), so this is harmless on pilotServerWorker.js.
  banner: { js: '#!/usr/bin/env node' },
  // Do not bundle these into the output; resolve them from node_modules at runtime.
  external: ['pilotprotocol'],
  // Keep each entry as its own file; do not split into shared chunks so the
  // worker file is self-contained and loadable by URL.
  splitting: false,
  sourcemap: true,
  // tsc-style type checking is run separately via `npm run typecheck`.
  dts: false,
});
