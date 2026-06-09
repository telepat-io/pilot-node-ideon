/**
 * Shared type contract for the io.telepat.ideon-article Pilot app-store app.
 *
 * This file is the SINGLE source of truth that every module author codes
 * against. Types and exported function SIGNATURES live here; implementations
 * live in their named modules. Do not change a signature here without
 * updating INTERFACES.md and notifying parallel authors.
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
// app-store IPC envelope (app <-> daemon, app <-> wallet)
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
// payment types (mirror app-store/pkg/payment/types.go)
// ───────────────────────────────────────────────────────────────────────────

/**
 * payment.Contract — the abstract statement of required payment.
 * Upstream: org/app-store/pkg/payment/types.go:30-49.
 * Amount is in the asset's smallest unit (USDC has 6 decimals, so
 * 1 USDC == 1_000_000). `expires_at` is an RFC3339 timestamp string on
 * the wire (Go time.Time marshals to RFC3339).
 */
export interface PaymentContract {
  id: string;
  amount: number;
  asset: string;
  recipient_addr: string;
  expires_at: string;
  nonce: string;
  accepted_methods?: string[];
  accepted_escrows?: string[];
  memo?: string;
}

/**
 * payment.Receipt — the method-tagged proof a Contract was satisfied.
 * Upstream: org/app-store/pkg/payment/types.go:54-58.
 * `payload` is base64 on the JSON wire ([]byte in Go marshals to base64).
 * For the mock method (io.pilot.wallet-mock/v1) the decoded payload is a
 * JSON-encoded SignedAuth.
 */
export interface PaymentReceipt {
  contract_id: string;
  method_id: string;
  payload: string;
}

/** Canonical method IDs. Upstream: wallet/pkg/wallet/hooks.go (mock),
 *  wallet/pkg/evm (EVMMethodID). */
export const MOCK_METHOD_ID = 'io.pilot.wallet-mock/v1';
export const EVM_METHOD_ID = 'io.pilot.wallet/v1';

// ───────────────────────────────────────────────────────────────────────────
// our app's peer-facing protocol (carried inside a dataexchange JSON frame)
// ───────────────────────────────────────────────────────────────────────────

/** Request op: "quote" asks for a PaymentContract; "deliver" redeems a
 *  receipt for the generated article. */
export type RequestOp = 'quote' | 'deliver';

/** Optional Ideon shaping knobs forwarded to ideon_write. `length` is either
 *  a named bucket or a positive integer word count. */
export interface IdeonOptions {
  style?: string;
  intent?: string;
  length?: string | number;
}

/** Request frame our capability server accepts (decoded from a DxType.JSON
 *  frame on port 1001). */
export interface ArticleRequest extends IdeonOptions {
  op: RequestOp;
  idea: string;
  /** Required on op:"deliver" — the contract the caller is paying against. */
  contract?: PaymentContract;
  /** Required on op:"deliver" — the caller's proof of payment. */
  receipt?: PaymentReceipt;
}

/** Reply to op:"quote". */
export interface QuoteResponse {
  op: 'quote';
  contract: PaymentContract;
}

/** Reply to op:"deliver". On success `article` holds the markdown body. */
export interface DeliverResponse {
  op: 'deliver';
  ok: boolean;
  /** Markdown article body (present when ok). */
  article?: string;
  title?: string;
  slug?: string;
  error?: string;
}

export type ArticleResponse = QuoteResponse | DeliverResponse;

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
 *   --cap-state <path>          JSONL spend-cap log (unused by us; payee role)
 *
 * NOTE: the daemon DATA-PLANE socket is NOT in these flags. It is found via
 * $PILOT_SOCKET / driver.DefaultSocketPath() (inherited env). See INTERFACES.md.
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

/** A connection-like handle exposing the subset of sdk-node Conn we use. */
export interface ConnLike {
  read(size?: number): Buffer;
  write(data: Buffer | Uint8Array | string): number;
  close(): void;
}

/** walletIpc.ts — talk to the sibling wallet app over its app.sock using the
 *  app-store IPC envelope. */
export interface WalletIpcModule {
  /** Open a unix-socket connection to the wallet app.sock. */
  connectWallet(walletSockPath: string): Promise<WalletConn>;
  /** wallet.evm.address -> 0x EVM recipient address we (the payee) advertise.
   *  Falls back to wallet.address for the mock/offline path. */
  walletAddress(conn: WalletConn): Promise<string>;
  /** wallet.evm.verify {chain_id?, contract, receipt} -> ok. For the mock
   *  path use wallet.verify with the decoded Challenge/SignedAuth instead. */
  walletVerify(
    conn: WalletConn,
    contract: PaymentContract,
    receipt: PaymentReceipt,
  ): Promise<boolean>;
}

/** A framed IPC connection to the wallet (one in-flight Call at a time). */
export interface WalletConn {
  /** Send one IpcEnvelope req and await the matching reply.
   *  Resolves with the reply payload, rejects on EnvErr. */
  call<TResult = unknown>(method: string, args?: unknown): Promise<TResult>;
  close(): void;
}
export declare const connectWallet: WalletIpcModule['connectWallet'];
export declare const walletAddress: WalletIpcModule['walletAddress'];
export declare const walletVerify: WalletIpcModule['walletVerify'];

/** appSock.ts — create the --socket unix listener the supervisor polls for
 *  readiness. We don't serve real IPC methods on it (we have no exposed
 *  methods callable by other apps in v1); it exists purely as the readiness
 *  signal. Upstream readiness poll: supervisor.go:795-808. */
export interface AppSockModule {
  serveAppSocket(socketPath: string): Promise<AppSockHandle>;
}
export interface AppSockHandle {
  close(): void;
}
export declare const serveAppSocket: AppSockModule['serveAppSocket'];

/** pilotServer.ts — bind the daemon data plane on port 1001 and serve our
 *  request-article capability to peers. Uses sdk-node Driver.listen(1001). */
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
  onRequest(req: ArticleRequest): Promise<ArticleResponse>;
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
  /** Base URL of the Ideon MCP endpoint, e.g. "http://ideon:3001/mcp". */
  endpoint: string;
  /** Bearer API key (IDEON_MCP_API_KEY). */
  apiKey: string;
  idea: string;
  style?: string;
  intent?: string;
  length?: string | number;
  /** Default true for the air-gapped smoke test (writes placeholder output). */
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

/** quote.ts — build the PaymentContract a caller must satisfy. */
export interface QuoteModule {
  buildContract(opts: BuildContractOpts): PaymentContract;
}
export interface BuildContractOpts {
  /** Our EVM recipient address from wallet.evm.address (or wallet.address). */
  recipientAddr: string;
  /** Price in USDC smallest units (6dp). */
  amount: number;
  /** Seconds until the contract expires. */
  ttlSeconds: number;
  /** Human-readable note tying the contract to the requested idea. */
  memo?: string;
  /** Which payment methods we accept (e.g. [MOCK_METHOD_ID]). */
  acceptedMethods?: string[];
}
export declare const buildContract: QuoteModule['buildContract'];

/** dedupe.ts — idempotency: a paid contract delivers exactly one article. */
export interface DedupeModule {
  /** Atomically reserve a contract id (persists to delivered.jsonl). Returns
   *  true if THIS call reserved it, false if it was already reserved — the
   *  caller's authoritative exactly-once signal. */
  markDelivered(stateFile: string, contractId: string): Promise<boolean>;
  /** True if this contract id was already delivered. */
  isDelivered(stateFile: string, contractId: string): Promise<boolean>;
}
export declare const markDelivered: DedupeModule['markDelivered'];
export declare const isDelivered: DedupeModule['isDelivered'];

/** deliver.ts — package a generated article into the response frame. */
export interface DeliverModule {
  frameArticle(result: IdeonWriteResult): DeliverResponse;
}
export declare const frameArticle: DeliverModule['frameArticle'];
