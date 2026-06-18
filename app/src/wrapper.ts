/**
 * wrapper.ts — entrypoint orchestration for the io.telepat.ideon-free app.
 *
 * The FREE node has no payment leg: no wallet, no quote, no receipt, no dedupe.
 * A caller sends ONE request frame and gets the article straight back.
 *
 * Lifecycle (cite: supervisor.go:752-808):
 *   1. Parse the six lifecycle flags (--addr --db --socket --identity
 *      --manifest --cap-state); tolerate unknown flags.
 *   2. Open the --socket unix listener (supervisor readiness signal).
 *   3. Start the dataexchange capability server on port 1001, handling the
 *      single op:"generate" -> ideonWrite -> reply with the article.
 *   4. Structured logging to stderr throughout.
 *
 * Env (inherited from the daemon):
 *   PILOT_SOCKET        daemon data-plane unix socket (default /tmp/pilot.sock)
 *   IDEON_MCP_ENDPOINT  e.g. http://ideon-mcp:3001/mcp
 *   IDEON_MCP_API_KEY   bearer key for Ideon MCP
 *   IDEON_DRY_RUN       "false" to disable dry-run (default true for the smoke)
 */

import { randomUUID } from 'node:crypto';
import type { GenerateRequest, GenerateResponse, JobStatus, LifecycleFlags, IdeonWriteResult } from './types.js';
import { serveAppSocket } from './appSock.js';
import { startCapabilityServer } from './pilotServer.js';
import { ideonWrite } from './ideonClient.js';
import { log } from './log.js';

/** The capability/overlay port (1001 == dataexchange). */
const CAPABILITY_PORT = 1001;

/** Parse the six supervisor flags; ignore anything unrecognized. */
export function parseFlags(argv: string[]): LifecycleFlags {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      map.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(a.slice(2), next);
        i++;
      } else {
        map.set(a.slice(2), ''); // boolean-style flag, tolerated
      }
    }
  }
  const req = (k: string): string => {
    const v = map.get(k);
    if (v === undefined || v === '') throw new Error(`wrapper: missing required flag --${k}`);
    return v;
  };
  return {
    addr: req('addr'),
    db: req('db'),
    socket: req('socket'),
    identity: req('identity'),
    manifest: req('manifest'),
    capState: req('cap-state'),
  };
}

interface Config {
  ideonEndpoint: string;
  ideonApiKey: string;
  dryRun: boolean;
  daemonSocketPath: string;
}

function loadConfig(): Config {
  return {
    ideonEndpoint: process.env['IDEON_MCP_ENDPOINT'] ?? 'http://ideon:3001/mcp',
    ideonApiKey: process.env['IDEON_MCP_API_KEY'] ?? '',
    dryRun: (process.env['IDEON_DRY_RUN'] ?? 'true').toLowerCase() !== 'false',
    daemonSocketPath: process.env['PILOT_SOCKET'] ?? '/tmp/pilot.sock',
  };
}

/** An in-flight or finished generation. Kept in memory: one app instance owns
 *  the overlay, and a job lives only as long as its caller polls for it. */
interface Job {
  status: JobStatus;
  result?: IdeonWriteResult;
  error?: string;
}

/**
 * Build the per-request handler. ASYNC by design (see types.ts RequestOp):
 *   op:"generate" -> register a job, kick off ideon_write in the BACKGROUND
 *                    (do NOT await — the reply must return in <1s so the
 *                    overlay conn isn't held for the full ~60-90s generation),
 *                    reply {op:"accepted", jobId}.
 *   op:"poll"     -> look up the job, reply {op:"result", status, ...}.
 * There is no payment state to capture.
 */
function makeHandler(cfg: Config): (req: GenerateRequest) => Promise<GenerateResponse> {
  const jobs = new Map<string, Job>();

  return async (req: GenerateRequest): Promise<GenerateResponse> => {
    if (req.op === 'generate') {
      if (!req.idea || req.idea.trim() === '') {
        return { op: 'error', ok: false, error: 'generate: missing idea' };
      }
      const jobId = randomUUID();
      jobs.set(jobId, { status: 'pending' });
      const idea = req.idea;
      const opts = {
        endpoint: cfg.ideonEndpoint,
        apiKey: cfg.ideonApiKey,
        idea,
        ...(req.style !== undefined ? { style: req.style } : {}),
        ...(req.intent !== undefined ? { intent: req.intent } : {}),
        ...(req.length !== undefined ? { length: req.length } : {}),
        dryRun: cfg.dryRun,
      };
      // Fire-and-track: the promise outlives this request; the caller polls.
      void ideonWrite(opts).then(
        (result) => {
          jobs.set(jobId, { status: 'done', result });
          log('info', 'generated article', { jobId, slug: result.slug, title: result.title });
        },
        (err: Error) => {
          jobs.set(jobId, { status: 'error', error: err.message });
          log('error', 'generate: ideon generation failed', { jobId, error: err.message });
        },
      );
      log('info', 'accepted generate job', { jobId, idea: idea.slice(0, 80) });
      return { op: 'accepted', jobId };
    }

    if (req.op === 'poll') {
      const jobId = req.jobId;
      if (!jobId) return { op: 'error', ok: false, error: 'poll: missing jobId' };
      const job = jobs.get(jobId);
      if (!job) return { op: 'result', jobId, status: 'error', ok: false, error: 'unknown jobId' };
      if (job.status === 'pending') return { op: 'result', jobId, status: 'pending' };
      if (job.status === 'error') return { op: 'result', jobId, status: 'error', ok: false, error: job.error ?? 'generation failed' };
      const r = job.result!;
      return { op: 'result', jobId, status: 'done', ok: true, article: r.markdown, title: r.title, slug: r.slug };
    }

    return { op: 'error', ok: false, error: `unknown op: ${String((req as { op?: unknown }).op)}` };
  };
}

/** Main lifecycle. Returns once the server is up; stays alive via the worker. */
export async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const cfg = loadConfig();
  log('info', 'starting ideon-free app', {
    addr: flags.addr,
    socket: flags.socket,
    daemonSocket: cfg.daemonSocketPath,
    ideonEndpoint: cfg.ideonEndpoint,
    dryRun: cfg.dryRun,
  });

  if (cfg.ideonApiKey === '') {
    log('warn', 'IDEON_MCP_API_KEY is empty; ideon_write calls will be unauthenticated', {});
  }

  // 2. Readiness socket FIRST so the supervisor sees us promptly.
  const appSock = await serveAppSocket(flags.socket);

  // 3. Capability server — no wallet, no payee address to resolve.
  const handler = makeHandler(cfg);
  const server = await startCapabilityServer({
    daemonSocketPath: cfg.daemonSocketPath,
    port: CAPABILITY_PORT,
    onRequest: handler,
  });

  log('info', 'ideon-free app ready', { port: CAPABILITY_PORT });

  // Graceful shutdown.
  const shutdown = (sig: string) => {
    log('info', 'shutting down', { signal: sig });
    server.close();
    appSock.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
