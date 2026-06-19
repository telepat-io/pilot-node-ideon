/**
 * wrapper.ts — entrypoint orchestration for the io.telepat.ideon-free app.
 *
 * The FREE node has no payment leg: no wallet, no quote, no receipt, no dedupe.
 * A caller invokes generate, then polls for the finished article.
 *
 * Lifecycle (cite: supervisor.go:752-808):
 *   1. Parse the six lifecycle flags (--addr --db --socket --identity
 *      --manifest --cap-state); tolerate unknown flags.
 *   2. Open the --socket unix listener (readiness signal + app-store IPC).
 *   3. Serve the named IPC methods (generate/poll/help) on that socket, each
 *      delegating to the shared op-handler.
 *   4. Structured logging to stderr throughout.
 *
 * Env (inherited from the daemon):
 *   IDEON_MCP_ENDPOINT  e.g. http://ideon-mcp:3001/mcp
 *   IDEON_MCP_API_KEY   bearer key for Ideon MCP
 *   IDEON_DRY_RUN       "false" to disable dry-run (default true for the smoke)
 */

import { randomUUID } from 'node:crypto';
import type { Dispatcher, GenerateRequest, GenerateResponse, JobStatus, LifecycleFlags, IdeonWriteResult } from './types.js';
import { serveAppSocket } from './appSock.js';
import { ideonWrite } from './ideonClient.js';
import { log } from './log.js';

const APP_ID = 'io.telepat.ideon-free';
/** Method namespace = the id's final DNS segment. */
const NS = 'ideon-free';

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
}

function loadConfig(): Config {
  return {
    ideonEndpoint: process.env['IDEON_MCP_ENDPOINT'] ?? 'https://ideon-mcp.telepat.io/mcp',
    ideonApiKey: process.env['IDEON_MCP_API_KEY'] ?? '',
    dryRun: (process.env['IDEON_DRY_RUN'] ?? 'true').toLowerCase() !== 'false',
  };
}

/** An in-flight or finished generation. Kept in memory in the shared jobs map;
 *  a job lives only as long as its caller polls for it. */
interface Job {
  status: JobStatus;
  result?: IdeonWriteResult;
  error?: string;
}

/**
 * Build the per-request handler. ASYNC by design (see types.ts RequestOp):
 *   op:"generate" -> register a job, kick off ideon_write in the BACKGROUND
 *                    (do NOT await — the IPC reply must return in <1s, not be
 *                    held for the full ~60-90s generation),
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

/** Local catalogue returned by <ns>.help. No backend round-trip. */
function helpCatalogue(): unknown {
  return {
    app: APP_ID,
    methods: [
      {
        name: `${NS}.generate`,
        summary: 'Generate an article from an idea; returns a jobId to poll.',
        kind: 'utility',
        latency: 'med',
        params: { idea: 'string (required)', style: 'string', intent: 'string', length: 'string|number' },
      },
      {
        name: `${NS}.poll`,
        summary: 'Poll a generate jobId for status and the finished article.',
        kind: 'utility',
        latency: 'fast',
        params: { jobId: 'string (required)' },
      },
      {
        name: `${NS}.help`,
        summary: "List this app's callable methods.",
        kind: 'meta',
        latency: 'fast',
        params: {},
      },
    ],
  };
}

/**
 * Build the IPC dispatcher. ONE shared handler instance backs every method, so
 * the in-memory jobs map is shared across all IPC connections (a `poll` on one
 * connection finds a `generate`'s job from another). Each method maps its
 * payload to an op request and the op response to a clean result payload (the
 * internal `op` field omitted; the method name already disambiguates).
 */
function buildDispatcher(cfg: Config): Dispatcher {
  const handler = makeHandler(cfg);
  const dispatch: Dispatcher = new Map();

  dispatch.set(`${NS}.generate`, async (payload) => {
    const p = (payload ?? {}) as Partial<GenerateRequest>;
    const res = await handler({
      op: 'generate',
      ...(p.idea !== undefined ? { idea: p.idea } : {}),
      ...(p.style !== undefined ? { style: p.style } : {}),
      ...(p.intent !== undefined ? { intent: p.intent } : {}),
      ...(p.length !== undefined ? { length: p.length } : {}),
    });
    if (res.op !== 'accepted' || res.jobId === undefined) {
      throw new Error(res.error ?? 'generate failed');
    }
    return { jobId: res.jobId };
  });

  dispatch.set(`${NS}.poll`, async (payload) => {
    const p = (payload ?? {}) as { jobId?: string };
    const res = await handler({ op: 'poll', ...(p.jobId !== undefined ? { jobId: p.jobId } : {}) });
    if (res.op === 'error') throw new Error(res.error ?? 'poll failed');
    const out: Record<string, unknown> = { status: res.status };
    if (res.ok !== undefined) out['ok'] = res.ok;
    if (res.article !== undefined) out['article'] = res.article;
    if (res.title !== undefined) out['title'] = res.title;
    if (res.slug !== undefined) out['slug'] = res.slug;
    if (res.error !== undefined) out['error'] = res.error;
    return out;
  });

  dispatch.set(`${NS}.help`, async () => helpCatalogue());

  return dispatch;
}

/** Main lifecycle. Returns once the socket is serving; stays alive on it. */
export async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const cfg = loadConfig();
  log('info', 'starting ideon-free app', {
    addr: flags.addr,
    socket: flags.socket,
    ideonEndpoint: cfg.ideonEndpoint,
    dryRun: cfg.dryRun,
  });

  if (cfg.ideonApiKey === '') {
    log('warn', 'IDEON_MCP_API_KEY is empty; ideon_write calls will be unauthenticated', {});
  }

  const dispatch = buildDispatcher(cfg);
  const appSock = await serveAppSocket(flags.socket, dispatch);

  log('info', 'ideon-free app ready', { socket: flags.socket, methods: [...dispatch.keys()] });

  // Graceful shutdown.
  const shutdown = (sig: string) => {
    log('info', 'shutting down', { signal: sig });
    appSock.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
