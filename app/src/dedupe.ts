/**
 * dedupe.ts — idempotency: a paid contract delivers exactly one article.
 *
 * Backed by an append-only JSON-lines file (no native deps, so the Node
 * Dockerfile stays slim and the manifest's fs grant points at a single file).
 * cite: app/manifest.json grants fs.write/fs.read $APP/delivered.jsonl.
 *
 * Each line: {"contract_id":"...","ts":"<RFC3339>"}. isDelivered scans the
 * file; markDelivered appends. Concurrency within one process is serialized via
 * an in-memory promise chain; cross-process is out of scope (one app instance).
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Serialize writes within this process so two near-simultaneous deliveries of
 *  the same contract can't both pass the isDelivered gate then both append. */
const writeChains = new Map<string, Promise<void>>();

/** In-memory cache of delivered ids per state file (warm read after first scan). */
const seenCache = new Map<string, Set<string>>();

async function loadSet(stateFile: string): Promise<Set<string>> {
  const cached = seenCache.get(stateFile);
  if (cached) return cached;
  const set = new Set<string>();
  try {
    const raw = await readFile(stateFile, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { contract_id?: string };
        if (rec.contract_id) set.add(rec.contract_id);
      } catch {
        // tolerate a torn final line from an unclean exit.
      }
    }
  } catch (err) {
    // ENOENT -> empty set (nothing delivered yet).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  seenCache.set(stateFile, set);
  return set;
}

/** True if this contract id was already delivered. */
export async function isDelivered(stateFile: string, contractId: string): Promise<boolean> {
  const set = await loadSet(stateFile);
  return set.has(contractId);
}

/**
 * Atomically reserve a contract id. Returns `true` if THIS call performed the
 * reservation, `false` if the id was already reserved by an earlier (or
 * concurrent) call. The per-file promise chain serializes the check-and-append,
 * so for a given contract id exactly one caller ever gets `true` — callers use
 * that as the authoritative "this is the one delivery" signal (no separate
 * isDelivered() pre-check needed, which would reopen a TOCTOU window).
 * Persists one JSONL line on the winning call.
 */
export async function markDelivered(stateFile: string, contractId: string): Promise<boolean> {
  const prev = writeChains.get(stateFile) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async (): Promise<boolean> => {
      const set = await loadSet(stateFile);
      if (set.has(contractId)) return false; // already reserved by an earlier delivery.
      await mkdir(dirname(stateFile), { recursive: true });
      const line = JSON.stringify({ contract_id: contractId, ts: new Date().toISOString() }) + '\n';
      await appendFile(stateFile, line, 'utf-8');
      set.add(contractId);
      return true; // THIS call won the reservation.
    });
  // Keep the per-file chain alive and uniform (void) regardless of this outcome.
  writeChains.set(stateFile, next.then(() => undefined, () => undefined));
  return next;
}
