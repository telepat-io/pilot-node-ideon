/**
 * Shared type contract for the io.telepat.ideon-free Pilot app-store app.
 *
 * The FREE node drops the entire payment leg of io.telepat.ideon-article: there
 * is no quote/contract/receipt/wallet. A caller sends ONE request frame and gets
 * the generated article back. Types and exported function SIGNATURES live here;
 * implementations live in their named modules.
 *
 * Two distinct wire formats are in play and MUST NOT be conflated:
 *
 *   1. dataexchange frame  — peer<->peer over the Pilot overlay, port 1001.
 *      [4B type BE][4B len BE][payload]. See DxFrame / DxType below.
 *      Upstream: org/dataexchange/dataexchange.go:64-93.
 *
 *   2. app-store IPC envelope — app<->daemon/app over a unix socket.
 *      [4B len BE][JSON Envelope]. See IpcEnvelope below.
 *      Upstream: org/app-store/pkg/ipc/frame.go:15-69,
 *                org/app-store/pkg/ipc/envelope.go:33-41.
 */

// ───────────────────────────────────────────────────────────────────────────
// dataexchange wire (peer <-> peer, port 1001)
// ───────────────────────────────────────────────────────────────────────────

/**
 * dataexchange frame type discriminator.
 * Upstream: org/dataexchange/dataexchange.go:15-23 (TypeTrace=5 unused by us).
 */
export enum DxType {
  TEXT = 1,
  BINARY = 2,
  JSON = 3,
  FILE = 4,
}

/**
 * A decoded dataexchange frame. For FILE frames, `filename` is set and
 * `payload` is the raw file bytes (the [2B nameLen][name] prefix is stripped
 * by decodeFrame). For TEXT/JSON/BINARY, `filename` is undefined.
 */
export interface DxFrame {
  type: DxType;
  payload: Buffer;
  /** Only present (and required) for DxType.FILE. */
  filename?: string;
}

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

// ───────────────────────────────────────────────────────────────────────────
// our app's peer-facing protocol (carried inside a dataexchange JSON frame)
// ───────────────────────────────────────────────────────────────────────────

/** The FREE protocol is ASYNC (real generation takes ~60-90s, longer than the
 *  Pilot overlay holds an idle dataexchange connection ~60-70s). So a caller
 *  "generate" returns a jobId immediately; the caller then "poll"s that jobId
 *  until the article is ready. Each round-trip is sub-second, surviving the
 *  overlay's connection lifetime. No payment step anywhere. */
export type RequestOp = 'generate' | 'poll';

/** Optional Ideon shaping knobs forwarded to ideon_write. `length` is either a
 *  named bucket (small|medium|large) or a positive integer word count — both
 *  accepted by ideon_write verbatim, so no tier mapping is needed. */
export interface IdeonOptions {
  style?: string;
  intent?: string;
  length?: string | number;
}

/** Request frame our capability server accepts (decoded from a DxType.JSON
 *  frame on port 1001). `idea` is required for op:"generate"; `jobId` is
 *  required for op:"poll". */
export interface GenerateRequest extends IdeonOptions {
  op: RequestOp;
  idea?: string;
  jobId?: string;
}

/** Per-job status the wrapper tracks in memory. */
export type JobStatus = 'pending' | 'done' | 'error';

/** Reply frame. op:"accepted" answers a generate (carries the jobId to poll);
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
 *   --socket <app.sock>         unix socket WE must create (readiness signal)
 *   --identity <path>           our ed25519 identity file
 *   --manifest <path>           pinned manifest.json
 *   --cap-state <path>          JSONL cap-state log (unused by us)
 *
 * NOTE: the daemon DATA-PLANE socket is NOT in these flags. It is found via
 * $PILOT_SOCKET / driver.DefaultSocketPath() (inherited env).
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

/** dxframe.ts — encode/decode dataexchange frames.
 *  Mirrors org/dataexchange/dataexchange.go:73-140 and
 *  org/sdk-node/src/client.ts:481-543. */
export interface DxFrameModule {
  /** Build [4B type BE][4B len BE][payload]. For FILE, caller passes a
   *  payload already produced by encodeFilePayload. */
  encodeFrame(type: DxType, payload: Buffer): Buffer;
  /** Parse one frame from a buffer that begins with the 8-byte header.
   *  Returns the frame plus the number of bytes consumed. */
  decodeFrame(buf: Buffer): { frame: DxFrame; bytesRead: number };
  /** Build a FILE payload: [2B nameLen BE][name][data]. */
  encodeFilePayload(filename: string, data: Buffer): Buffer;
}
export declare const encodeFrame: DxFrameModule['encodeFrame'];
export declare const decodeFrame: DxFrameModule['decodeFrame'];
export declare const encodeFilePayload: DxFrameModule['encodeFilePayload'];

/** appSock.ts — create the --socket unix listener the supervisor polls for
 *  readiness. We don't serve real IPC methods on it (we expose no methods); it
 *  exists purely as the readiness signal. Upstream: supervisor.go:795-808. */
export interface AppSockModule {
  serveAppSocket(socketPath: string): Promise<AppSockHandle>;
}
export interface AppSockHandle {
  close(): void;
}
export declare const serveAppSocket: AppSockModule['serveAppSocket'];

/** pilotServer.ts — bind the daemon data plane on port 1001 and serve our
 *  generate capability to peers. Uses sdk-node Driver.listen(1001). */
export interface PilotServerModule {
  startCapabilityServer(opts: CapabilityServerOpts): Promise<CapabilityServerHandle>;
}
export interface CapabilityServerOpts {
  /** Daemon data-plane unix socket (PILOT_SOCKET / default /tmp/pilot.sock). */
  daemonSocketPath: string;
  /** Port to bind on the overlay; the capability port (1001 == dataexchange). */
  port: number;
  /** Handler invoked once per decoded request frame; returns the response
   *  object to encode back as a JSON frame. */
  onRequest(req: GenerateRequest): Promise<GenerateResponse>;
}
export interface CapabilityServerHandle {
  close(): void;
}
export declare const startCapabilityServer: PilotServerModule['startCapabilityServer'];

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
