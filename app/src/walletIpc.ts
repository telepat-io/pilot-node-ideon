/**
 * walletIpc.ts — app-store IPC client that dials the sibling wallet app.sock
 * and calls the wallet.* methods we (the payee) need.
 *
 * Wire: [4B len BE][JSON Envelope], cap 1 MiB. One in-flight Call per conn.
 * cite: org/app-store/pkg/ipc/frame.go:21-69 (WriteFrame/ReadFrame, MaxFrameSize 1<<20)
 * cite: org/app-store/pkg/ipc/envelope.go:33-41 (Envelope fields)
 * cite: org/app-store/pkg/ipc/client.go:28-83 (Call: req_id match, err/reply switch)
 *
 * Methods used:
 *   wallet.evm.address  -> {address,chain_id,token}  cite: walletipc/api.go:176-184
 *   wallet.address      -> {address}                 cite: walletipc/api.go:72-74 (mock payee id)
 *   wallet.evm.verify   -> {ok}                      cite: walletipc/api.go:209-217
 *   wallet.verify       -> {ok} (mock Challenge/SignedAuth) cite: walletipc/api.go:102-108
 */

import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { MOCK_METHOD_ID } from './types.js';
import type { IpcEnvelope, PaymentContract, PaymentReceipt, WalletConn } from './types.js';

/** cite: org/app-store/pkg/ipc/frame.go:15 (MaxFrameSize = 1<<20). */
const IPC_MAX_FRAME_SIZE = 1 << 20;

/** Server-side error surfaced from an EnvErr reply. cite: ipc/client.go:13-15. */
export class WalletIpcError extends Error {
  constructor(msg: string) {
    super(`wallet ipc: server error: ${msg}`);
    this.name = 'WalletIpcError';
  }
}

/** Fresh 8-byte hex req_id. cite: org/app-store/pkg/ipc/client.go:77-83. */
function randReqId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Frame an envelope as [4B len BE][json]. cite: ipc/frame.go:24-41.
 */
function writeFrame(env: IpcEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(env), 'utf-8');
  if (body.length > IPC_MAX_FRAME_SIZE) {
    throw new Error('wallet ipc: frame exceeds max size');
  }
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body], 4 + body.length);
}

/**
 * Incremental reader: feed socket chunks, pull complete envelopes.
 * Mirrors io.ReadFull semantics on a 4-byte BE length prefix.
 * cite: org/app-store/pkg/ipc/frame.go:46-69.
 */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  /** Returns the next decoded envelope, or null if not yet complete. */
  next(): IpcEnvelope | null {
    if (this.buf.length < 4) return null;
    const n = this.buf.readUInt32BE(0);
    if (n === 0) throw new Error('wallet ipc: zero-length frame');
    if (n > IPC_MAX_FRAME_SIZE) throw new Error('wallet ipc: frame exceeds max size');
    if (this.buf.length < 4 + n) return null;
    const body = this.buf.subarray(4, 4 + n);
    this.buf = this.buf.subarray(4 + n);
    return JSON.parse(body.toString('utf-8')) as IpcEnvelope;
  }
}

/**
 * A framed IPC connection to the wallet. Serializes calls (one in flight at a
 * time, matching the Go client contract). cite: ipc/client.go:18-21.
 */
class WalletConnImpl implements WalletConn {
  private queue: Promise<unknown> = Promise.resolve();
  private reader = new FrameReader();
  private pending: { reqId: string; resolve: (e: IpcEnvelope) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(private readonly sock: net.Socket) {
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', (err: Error) => this.fail(err));
    sock.on('close', () => this.fail(new Error('wallet ipc: socket closed')));
  }

  private onData(chunk: Buffer): void {
    this.reader.push(chunk);
    if (!this.pending) return;
    let env: IpcEnvelope | null;
    try {
      env = this.reader.next();
    } catch (err) {
      this.fail(err as Error);
      return;
    }
    if (env === null) return;
    const p = this.pending;
    this.pending = null;
    if (env.req_id !== p.reqId) {
      p.reject(new Error(`wallet ipc: req_id mismatch: got ${env.req_id} want ${p.reqId}`));
      return;
    }
    p.resolve(env);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(err);
    }
    this.sock.destroy();
  }

  call<TResult = unknown>(method: string, args?: unknown): Promise<TResult> {
    // Chain on the queue so only one request is outstanding at a time.
    const run = this.queue.then(() => this.doCall<TResult>(method, args));
    // Keep the chain alive even if a call rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private doCall<TResult>(method: string, args?: unknown): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('wallet ipc: connection closed'));
        return;
      }
      const reqId = randReqId();
      const env: IpcEnvelope = { type: 'req', req_id: reqId, method };
      if (args !== undefined) env.payload = args;

      this.pending = {
        reqId,
        resolve: (reply) => {
          // cite: ipc/client.go:60-72 (err/reply switch).
          if (reply.type === 'err') {
            reject(new WalletIpcError(reply.error ?? 'unknown'));
            return;
          }
          if (reply.type !== 'reply') {
            reject(new Error(`wallet ipc: unexpected envelope type ${reply.type}`));
            return;
          }
          resolve((reply.payload ?? null) as TResult);
        },
        reject,
      };

      try {
        this.sock.write(writeFrame(env));
      } catch (err) {
        this.pending = null;
        reject(err as Error);
      }
      // Data may already be buffered; drain in case the reply arrived before
      // `pending` was set (cooperatively, via the next data event normally).
      this.drainBuffered();
    });
  }

  private drainBuffered(): void {
    if (!this.pending) return;
    let env: IpcEnvelope | null;
    try {
      env = this.reader.next();
    } catch (err) {
      this.fail(err as Error);
      return;
    }
    if (env === null) return;
    const p = this.pending;
    this.pending = null;
    if (env.req_id !== p.reqId) {
      p.reject(new Error(`wallet ipc: req_id mismatch: got ${env.req_id} want ${p.reqId}`));
      return;
    }
    p.resolve(env);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
  }
}

/** Open a unix-socket connection to the wallet app.sock. */
export function connectWallet(walletSockPath: string): Promise<WalletConn> {
  return new Promise<WalletConn>((resolve, reject) => {
    const sock = net.connect(walletSockPath);
    const onError = (err: Error) => {
      sock.removeListener('connect', onConnect);
      reject(new Error(`wallet ipc: connect ${walletSockPath}: ${err.message}`));
    };
    const onConnect = () => {
      sock.removeListener('error', onError);
      resolve(new WalletConnImpl(sock));
    };
    sock.once('error', onError);
    sock.once('connect', onConnect);
  });
}

/** wallet.evm.address response shape. cite: walletipc/api.go:181-184. */
interface EvmAddressResp {
  address: string;
  chain_id?: number;
  token?: string;
}
/** wallet.address response shape. cite: walletipc/api.go:72-74. */
interface AddressResp {
  address: string;
}
/** wallet.evm.verify / wallet.verify response. cite: walletipc/api.go:107,216. */
interface VerifyResp {
  ok: boolean;
}

/**
 * Our payee identity. Prefer the 0x EVM recipient (wallet.evm.address); on a
 * mock/offline wallet (no EVM binding) that method is absent, so fall back to
 * the pilot address (wallet.address).
 */
export async function walletAddress(conn: WalletConn): Promise<string> {
  try {
    const r = await conn.call<EvmAddressResp>('wallet.evm.address', {});
    if (r?.address) return r.address;
  } catch (err) {
    // wallet.evm.* is unregistered on a no-EVM wallet -> "method not found".
    if (!(err instanceof WalletIpcError)) throw err;
  }
  const r = await conn.call<AddressResp>('wallet.address', {});
  if (!r?.address) throw new Error('wallet ipc: wallet returned no address');
  return r.address;
}

/**
 * Verify a caller's proof of payment against a Contract.
 *
 * Routing is by the receipt's method_id (mirrors the wallet's own implicit
 * routing):
 *   - EVM_METHOD_ID  -> wallet.evm.verify {contract, receipt}
 *   - MOCK_METHOD_ID -> wallet.verify {challenge, signed_auth}, where the
 *     receipt.payload is base64(JSON SignedAuth) and the challenge is derived
 *     from the contract. cite: walletipc/api.go:102-108, hooks.go contractToChallenge.
 */
export async function walletVerify(
  conn: WalletConn,
  contract: PaymentContract,
  receipt: PaymentReceipt,
): Promise<boolean> {
  if (receipt.contract_id !== contract.id) return false;

  if (receipt.method_id === MOCK_METHOD_ID) {
    // Mock path: decode SignedAuth from the base64 payload and verify against a
    // Challenge reconstructed from the Contract. The wallet rebuilds/validates
    // the Challenge internally; we pass both so wallet.verify can match them.
    let signedAuth: unknown;
    try {
      signedAuth = JSON.parse(Buffer.from(receipt.payload, 'base64').toString('utf-8'));
    } catch (err) {
      throw new Error(`wallet ipc: mock receipt payload is not JSON SignedAuth: ${(err as Error).message}`);
    }
    const challenge = contractToChallenge(contract);
    const r = await conn.call<VerifyResp>('wallet.verify', {
      challenge,
      signed_auth: signedAuth,
    });
    return r?.ok === true;
  }

  // Default / EVM path: hand the contract + receipt straight to the wallet.
  // wallet.evm.verify takes payment.Contract and payment.Receipt verbatim;
  // the receipt's payload stays base64 on the wire. cite: walletipc/api.go:209-217.
  const r = await conn.call<VerifyResp>('wallet.evm.verify', {
    contract: contractToWire(contract),
    receipt,
  });
  return r?.ok === true;
}

/**
 * Marshal our PaymentContract into the Go payment.Contract wire shape.
 * Amount is uint64 (USDC 6dp); we already carry it as a number.
 * cite: org/app-store/pkg/payment/types.go:30-49.
 */
function contractToWire(c: PaymentContract): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    amount: c.amount,
    asset: c.asset,
    recipient_addr: c.recipient_addr,
    expires_at: c.expires_at,
    nonce: c.nonce,
  };
  if (c.accepted_methods) out['accepted_methods'] = c.accepted_methods;
  if (c.accepted_escrows) out['accepted_escrows'] = c.accepted_escrows;
  if (c.memo) out['memo'] = c.memo;
  return out;
}

/**
 * Derive the mock-flow Challenge from a Contract. Mirrors the wallet's own
 * contractToChallenge EXACTLY so wallet.verify reconstructs the same Challenge
 * the payer signed. Field names/JSON tags must match wallet.Challenge:
 *   {id, recipient_addr, amount, asset, nonce, expires_at, memo?}.
 * cite: org/wallet/pkg/wallet/hooks.go:88-98 (contractToChallenge);
 *       org/wallet/pkg/wallet/types.go:24-32 (Challenge struct + json tags).
 */
function contractToChallenge(c: PaymentContract): Record<string, unknown> {
  const ch: Record<string, unknown> = {
    id: c.id,
    recipient_addr: c.recipient_addr,
    amount: c.amount,
    asset: c.asset,
    nonce: c.nonce,
    expires_at: c.expires_at,
  };
  // Memo carries `omitempty`; only include when set so the canonical encoding
  // matches the payer's (an empty memo and an absent memo must not diverge).
  if (c.memo) ch['memo'] = c.memo;
  return ch;
}
