/**
 * wrapper.ts — entrypoint orchestration for the io.telepat.ideon-article app.
 *
 * Lifecycle (cite: INTERFACES.md §2; supervisor.go:752-808):
 *   1. Parse the six lifecycle flags (--addr --db --socket --identity
 *      --manifest --cap-state); tolerate unknown flags.
 *   2. Open the --socket unix listener (supervisor readiness signal).
 *   3. Connect to the sibling wallet app.sock; learn our RecipientAddr.
 *   4. Start the dataexchange capability server on port 1001, handling:
 *        op:"quote"   -> buildContract + reply
 *        op:"deliver" -> walletVerify(receipt); reject => "payment required"
 *                        (do NOT call Ideon); dedupe replay; ideonWrite; deliver.
 *   5. Structured logging to stderr throughout.
 *
 * Env (inherited from the daemon, cite: INTERFACES.md §2):
 *   PILOT_SOCKET        daemon data-plane unix socket (default /tmp/pilot.sock)
 *   IDEON_MCP_ENDPOINT  e.g. http://ideon:3001/mcp
 *   IDEON_MCP_API_KEY   bearer key for Ideon MCP
 *   IDEON_DRY_RUN       "false" to disable dry-run (default true for smoke test)
 *   ARTICLE_TTL_SECONDS contract TTL (default 900 = 15m)
 *   PAYMENT_METHODS     comma list of accepted_methods (default mock method)
 */

import * as path from 'node:path';
import { MOCK_METHOD_ID } from './types.js';
import type { ArticleRequest, ArticleResponse, LifecycleFlags, PaymentContract } from './types.js';
import { serveAppSocket } from './appSock.js';
import { connectWallet, walletAddress, walletVerify } from './walletIpc.js';
import type { WalletConn } from './types.js';
import { startCapabilityServer } from './pilotServer.js';
import { ideonWrite } from './ideonClient.js';
import { buildContract, priceForLength, ideonLengthFor } from './quote.js';
import { markDelivered } from './dedupe.js';
import { frameArticle } from './deliver.js';
import { log } from './log.js';

/** The capability/overlay port (1001 == dataexchange). cite: INTERFACES.md §1. */
const CAPABILITY_PORT = 1001;
/** Wallet app id. cite: org/wallet manifest.json id; INTERFACES.md §2(b). */
const WALLET_APP_ID = 'io.pilot.wallet';

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

/**
 * Resolve the sibling wallet app.sock from our own --socket flag.
 * <InstallRoot>/<our_id>/app.sock -> <InstallRoot>/io.pilot.wallet/app.sock.
 * cite: INTERFACES.md §2(b); supervisor.go:225-296.
 */
export function walletSockPath(ourSocket: string): string {
  const installRoot = path.join(path.dirname(ourSocket), '..');
  return path.join(installRoot, WALLET_APP_ID, 'app.sock');
}

/** State file for delivery dedupe. cite: app/manifest.json $APP/delivered.jsonl. */
function deliveredStatePath(flags: LifecycleFlags): string {
  // $APP is our install dir == dirname(--socket). Keep dedupe next to it.
  return path.join(path.dirname(flags.socket), 'delivered.jsonl');
}

interface Config {
  ideonEndpoint: string;
  ideonApiKey: string;
  dryRun: boolean;
  ttlSeconds: number;
  acceptedMethods: string[];
  daemonSocketPath: string;
}

function loadConfig(): Config {
  const methodsEnv = (process.env['PAYMENT_METHODS'] ?? '').trim();
  const acceptedMethods =
    methodsEnv !== ''
      ? methodsEnv.split(',').map((s) => s.trim()).filter(Boolean)
      : [MOCK_METHOD_ID];
  return {
    ideonEndpoint: process.env['IDEON_MCP_ENDPOINT'] ?? 'http://ideon:3001/mcp',
    ideonApiKey: process.env['IDEON_MCP_API_KEY'] ?? '',
    dryRun: (process.env['IDEON_DRY_RUN'] ?? 'true').toLowerCase() !== 'false',
    ttlSeconds: Number.parseInt(process.env['ARTICLE_TTL_SECONDS'] ?? '900', 10) || 900,
    acceptedMethods,
    daemonSocketPath: process.env['PILOT_SOCKET'] ?? '/tmp/pilot.sock',
  };
}

/**
 * Build the per-request handler. Captures the resolved payee address, config,
 * and a factory for fresh wallet connections (one in-flight call per conn, so
 * we open a short-lived conn per verify).
 */
function makeHandler(
  recipientAddr: string,
  cfg: Config,
  stateFile: string,
  walletSock: string,
): (req: ArticleRequest) => Promise<ArticleResponse> {
  return async (req: ArticleRequest): Promise<ArticleResponse> => {
    if (req.op === 'quote') {
      return handleQuote(req, recipientAddr, cfg);
    }
    if (req.op === 'deliver') {
      return handleDeliver(req, cfg, stateFile, walletSock);
    }
    return { op: 'deliver', ok: false, error: `unknown op: ${String((req as { op?: unknown }).op)}` };
  };
}

function handleQuote(req: ArticleRequest, recipientAddr: string, cfg: Config): ArticleResponse {
  if (!req.idea || req.idea.trim() === '') {
    return { op: 'deliver', ok: false, error: 'quote: missing idea' };
  }
  const amount = priceForLength(req.length);
  const contract = buildContract({
    recipientAddr,
    amount,
    ttlSeconds: cfg.ttlSeconds,
    memo: `article: ${req.idea.slice(0, 120)}`,
    acceptedMethods: cfg.acceptedMethods,
  });
  log('info', 'issued quote', { contractId: contract.id, amount, methods: cfg.acceptedMethods });
  return { op: 'quote', contract };
}

async function handleDeliver(
  req: ArticleRequest,
  cfg: Config,
  stateFile: string,
  walletSock: string,
): Promise<ArticleResponse> {
  // 0. Structural validation.
  if (!req.contract || !req.receipt) {
    return { op: 'deliver', ok: false, error: 'deliver: contract and receipt are required' };
  }
  if (!req.idea || req.idea.trim() === '') {
    return { op: 'deliver', ok: false, error: 'deliver: missing idea' };
  }
  const contract: PaymentContract = req.contract;

  // 1. Expiry check (cheap, before any wallet round-trip).
  const exp = Date.parse(contract.expires_at);
  if (Number.isFinite(exp) && exp < Date.now()) {
    return { op: 'deliver', ok: false, error: 'payment required: contract expired' };
  }

  // 2. Method must be one we accept.
  const acceptable = contract.accepted_methods ?? cfg.acceptedMethods;
  if (acceptable.length > 0 && !acceptable.includes(req.receipt.method_id)) {
    return { op: 'deliver', ok: false, error: `payment required: unaccepted method ${req.receipt.method_id}` };
  }

  // 3. Verify the receipt with the wallet. NEVER call Ideon before this passes.
  let ok = false;
  let wconn: WalletConn | undefined;
  try {
    wconn = await connectWallet(walletSock);
    ok = await walletVerify(wconn, contract, req.receipt);
  } catch (err) {
    log('error', 'deliver: wallet verify errored', { contractId: contract.id, error: (err as Error).message });
    return { op: 'deliver', ok: false, error: 'payment required: verification error' };
  } finally {
    wconn?.close();
  }
  if (!ok) {
    log('warn', 'deliver: payment rejected', { contractId: contract.id, method: req.receipt.method_id });
    return { op: 'deliver', ok: false, error: 'payment required: receipt did not verify' };
  }

  // 4. Replay / dedupe: atomically reserve the contract id so a paid contract
  //    delivers exactly one article. markDelivered returns false when the id was
  //    already reserved (prior or concurrent delivery) — this single atomic
  //    reservation closes the check-then-act (TOCTOU) window.
  const reserved = await markDelivered(stateFile, contract.id);
  if (!reserved) {
    log('warn', 'deliver: replay rejected (already delivered)', { contractId: contract.id });
    return { op: 'deliver', ok: false, error: 'already delivered for this contract' };
  }

  // 5. Generate via Ideon, then package the article. Normalize the caller's
  //    length to Ideon's accepted vocabulary (small|medium|large or a word
  //    count) so a priced tier never fails generation AFTER payment.
  try {
    const ideonLength = ideonLengthFor(req.length);
    const result = await ideonWrite({
      endpoint: cfg.ideonEndpoint,
      apiKey: cfg.ideonApiKey,
      idea: req.idea,
      ...(req.style !== undefined ? { style: req.style } : {}),
      ...(req.intent !== undefined ? { intent: req.intent } : {}),
      ...(ideonLength !== undefined ? { length: ideonLength } : {}),
      dryRun: cfg.dryRun,
    });
    log('info', 'delivered article', { contractId: contract.id, slug: result.slug });
    return frameArticle(result);
  } catch (err) {
    // Generation failed AFTER payment verified. We keep the dedupe reservation
    // to avoid free retries draining the payee; surface a retryable error.
    log('error', 'deliver: ideon generation failed (payment already accepted)', {
      contractId: contract.id,
      error: (err as Error).message,
    });
    return { op: 'deliver', ok: false, error: `generation failed: ${(err as Error).message}` };
  }
}

/** Main lifecycle. Returns once the server is up; stays alive via the worker. */
export async function run(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const cfg = loadConfig();
  log('info', 'starting ideon-article app', {
    addr: flags.addr,
    socket: flags.socket,
    daemonSocket: cfg.daemonSocketPath,
    ideonEndpoint: cfg.ideonEndpoint,
    dryRun: cfg.dryRun,
    acceptedMethods: cfg.acceptedMethods,
  });

  if (cfg.ideonApiKey === '') {
    log('warn', 'IDEON_MCP_API_KEY is empty; ideon_write calls will be unauthenticated', {});
  }

  // 2. Readiness socket FIRST so the supervisor sees us promptly.
  const appSock = await serveAppSocket(flags.socket);

  // 3. Learn our payee RecipientAddr from the wallet.
  const walletSock = walletSockPath(flags.socket);
  let recipientAddr: string;
  {
    let wconn: WalletConn | undefined;
    try {
      wconn = await connectWallet(walletSock);
      recipientAddr = await walletAddress(wconn);
      log('info', 'resolved payee address', { recipientAddr, walletSock });
    } catch (err) {
      log('error', 'failed to resolve payee address from wallet', { walletSock, error: (err as Error).message });
      appSock.close();
      throw err;
    } finally {
      wconn?.close();
    }
  }

  // 4. Capability server.
  const stateFile = deliveredStatePath(flags);
  const handler = makeHandler(recipientAddr, cfg, stateFile, walletSock);
  const server = await startCapabilityServer({
    daemonSocketPath: cfg.daemonSocketPath,
    port: CAPABILITY_PORT,
    onRequest: handler,
  });

  log('info', 'ideon-article app ready', { port: CAPABILITY_PORT, recipientAddr });

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
