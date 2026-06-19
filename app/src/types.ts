/**
 * Shared type contract for the io.telepat.ideon-free Pilot app-store app.
 *
 * The FREE node drops the entire payment leg of io.telepat.ideon-article: there
 * is no quote/contract/receipt/wallet. A caller sends a `generate` request and
 * polls for the finished article. Types and exported function SIGNATURES live
 * here; implementations live in their named modules.
 *
 * The wire is the app-store IPC envelope (app <-> daemon/app over a unix socket):
 *   [4B len BE][JSON Envelope]. See IpcEnvelope below.
 *   Upstream: org/app-store/pkg/ipc/frame.go:15-69,
 *             org/app-store/pkg/ipc/envelope.go:33-41.
 */

// ───────────────────────────────────────────────────────────────────────────
// app-store IPC envelope (app <-> daemon)
// ───────────────────────────────────────────────────────────────────────────

export type IpcEnvelopeType = 'req' | 'reply' | 'err';

/**
 * The single message shape on the app-store IPC wire.
 * Upstream: org/app-store/pkg/ipc/envelope.go:33-41.
 * `app_id` / `manifest_version` are set by the daemon when it BRIDGES a call
 * from one app to another; zero/absent on a direct connection.
 */
export interface IpcEnvelope {
  type: IpcEnvelopeType;
  req_id: string;
  method?: string;
  app_id?: string;
  manifest_version?: number;
  /** Raw JSON bytes; decode per-method. */
  payload?: unknown;
  error?: string;
}

/** A single app-store IPC method: receives the request payload and resolves to
 *  the result payload. A throw becomes an `err` reply (never crashes the conn). */
export type IpcMethod = (payload: unknown) => Promise<unknown>;
/** Method name → handler, consulted per inbound `req` frame. */
export type Dispatcher = Map<string, IpcMethod>;

// ───────────────────────────────────────────────────────────────────────────
// our app's request/response protocol (carried in the IPC envelope payload)
// ───────────────────────────────────────────────────────────────────────────

/** The FREE protocol is ASYNC (real generation takes ~60-90s). A caller
 *  "generate" returns a jobId immediately; the caller then "poll"s that jobId
 *  until the article is ready. Each round-trip is sub-second. No payment step. */
export type RequestOp = 'generate' | 'poll';

/** Optional Ideon shaping knobs forwarded to ideon_write. `length` is either a
 *  named bucket (small|medium|large) or a positive integer word count — both
 *  accepted by ideon_write verbatim, so no tier mapping is needed. */
export interface IdeonOptions {
  style?: string;
  intent?: string;
  length?: string | number;
}

/** Request our handler accepts. `idea` is required for op:"generate"; `jobId` is
 *  required for op:"poll". */
export interface GenerateRequest extends IdeonOptions {
  op: RequestOp;
  idea?: string;
  jobId?: string;
}

/** Per-job status the wrapper tracks in memory. */
export type JobStatus = 'pending' | 'done' | 'error';

/** Handler reply. op:"accepted" answers a generate (carries the jobId to poll);
 *  op:"result" answers a poll (status pending|done|error). On a done result
 *  `article` holds the markdown body. op:"error" is a malformed-request reply. */
export interface GenerateResponse {
  op: 'accepted' | 'result' | 'error';
  /** generate -> the job handle to poll; poll -> echoes the polled job. */
  jobId?: string;
  /** poll only: pending while generating, done on success, error on failure. */
  status?: JobStatus;
  /** true once a result is ready and succeeded. */
  ok?: boolean;
  /** Markdown article body (present when status==done && ok). */
  article?: string;
  title?: string;
  slug?: string;
  error?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// lifecycle flags (supervisor -> our binary)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Flags the app-store supervisor passes to a spawned app.
 * Upstream: org/app-store/plugin/appstore/supervisor.go:752-759.
 *   --addr <daemon-pilot-addr>  our OWN pilot address (e.g. "0:0001.HHHH.LLLL")
 *   --db <path>                 sqlite/state path (we use it as a state dir hint)
 *   --socket <app.sock>         unix socket WE must create (readiness + IPC)
 *   --identity <path>           our ed25519 identity file
 *   --manifest <path>           pinned manifest.json
 *   --cap-state <path>          JSONL cap-state log (unused by us)
 */
export interface LifecycleFlags {
  addr: string;
  db: string;
  socket: string;
  identity: string;
  manifest: string;
  capState: string;
}

// ───────────────────────────────────────────────────────────────────────────
// module stub SIGNATURES — implementations live in the named files
// ───────────────────────────────────────────────────────────────────────────

/** appSock.ts — create the --socket unix listener (readiness signal) and route
 *  each inbound `req` frame through the dispatcher. Upstream: supervisor.go:795-808. */
export interface AppSockModule {
  serveAppSocket(socketPath: string, dispatch: Dispatcher): Promise<AppSockHandle>;
}
export interface AppSockHandle {
  close(): void;
}
export declare const serveAppSocket: AppSockModule['serveAppSocket'];

/** ideonClient.ts — drive the Ideon MCP HTTP server (stateful: initialize ->
 *  capture Mcp-Session-Id -> tools/call ideon_write). */
export interface IdeonClientModule {
  ideonWrite(opts: IdeonWriteOpts): Promise<IdeonWriteResult>;
}
export interface IdeonWriteOpts {
  /** Base URL of the Ideon MCP endpoint, e.g. "http://ideon-mcp:3001/mcp". */
  endpoint: string;
  /** Bearer API key (IDEON_MCP_API_KEY). */
  apiKey: string;
  idea: string;
  style?: string;
  intent?: string;
  length?: string | number;
  /** Default true for the smoke test (writes placeholder output). */
  dryRun?: boolean;
}
/** Mirror of ideon_write structuredContent.
 *  Upstream: telepat/ideon/src/integrations/mcp/server.ts:199-207. */
export interface IdeonWriteResult {
  slug: string;
  title: string;
  outputCount: number;
  markdownPath: string;
  markdownPaths?: string[];
  generationDir: string;
  analyticsPath?: string;
  /** The article body read back from markdownPath. */
  markdown: string;
}
export declare const ideonWrite: IdeonClientModule['ideonWrite'];
