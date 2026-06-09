/**
 * main.ts — process entrypoint (package.json bin/build target: bin/main.js).
 *
 * Thin shim: parse argv and hand off to wrapper.run(). All orchestration lives
 * in wrapper.ts so it stays unit-testable without spawning a process.
 */

import { run } from './wrapper.js';
import { log } from './log.js';

run(process.argv.slice(2)).catch((err: Error) => {
  log('error', 'fatal: app failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});
