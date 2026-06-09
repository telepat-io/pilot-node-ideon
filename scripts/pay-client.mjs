#!/usr/bin/env node
//
// pay-client.mjs — payer-side MOCK payment client for the deliver smoke test.
//
// Talks to a STANDALONE wallet's unix socket using the app-store IPC envelope
// ([4B len BE][JSON]) — the SAME framing as app/src/walletIpc.ts. Pure Node
// (node:net + node:crypto only); it does NOT import pilotprotocol / libpilot,
// because the payment dance is wallet-local (no overlay hop).
//
// Flow (mock method io.pilot.wallet-mock/v1):
//   1. parse the PaymentContract out of the provider's quote reply.
//   2. wallet.topup {asset, amount, source}  — fund the payer, else Pay returns
//      ErrInsufficientBalance (store_mem.go:71-80).
//   3. derive a Challenge from the contract (contractToChallenge shape:
//      org/wallet hooks.go:88-98 / app/src/walletIpc.ts:322-335) and
//      wallet.pay {challenge} -> {signed_auth} (wallet.go:174-229).
//   4. wrap the SignedAuth as a Receipt {contract_id, method_id, payload:
//      base64(JSON(signed_auth))} — WalletMethod.Satisfy (hooks.go:37-55).
//   5. emit the full deliver request {op:"deliver", idea, length?, contract,
//      receipt} as one JSON line on stdout (the shell pipes it to dx-client).
//
//   --tamper sig    : corrupt the SignedAuth signature  -> provider ErrBadSignature
//   --tamper amount : ship a contract whose amount != the signed challenge
//                     -> provider ErrChallengeMismatch
//   Both must make the provider answer "payment required" WITHOUT running Ideon.
//
// Usage:
//   pay-client.mjs --socket <wallet.sock> --quote '<quote-reply-json>' \
//                  --idea '<idea>' [--length <bucket>] [--tamper sig|amount]
//
// cite framing: app-store/pkg/ipc/frame.go:15-69, envelope.go:33-41,
//               client.go:60-72 (err/reply switch).

import net from 'node:net';
import { randomBytes } from 'node:crypto';

const MOCK_METHOD_ID = 'io.pilot.wallet-mock/v1';
const IPC_MAX_FRAME = 1 << 20; // frame.go:15 MaxFrameSize

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--socket': out.socket = argv[++i]; break;
      case '--quote':  out.quote  = argv[++i]; break;
      case '--idea':   out.idea   = argv[++i]; break;
      case '--length': out.length = argv[++i]; break;
      case '--source': out.source = argv[++i]; break;
      case '--tamper': out.tamper = argv[++i]; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

// One framed IPC round-trip: connect, send {type:req,...}, read the matching
// reply envelope, return its payload (throws on type:err). One in-flight call
// per connection, matching the Go client contract (ipc/client.go:18-21).
function rpc(socketPath, method, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const reqId = randomBytes(8).toString('hex');
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; sock.destroy(); fn(arg); } };

    sock.on('connect', () => {
      const env = { type: 'req', req_id: reqId, method };
      if (payload !== undefined) env.payload = payload;
      const body = Buffer.from(JSON.stringify(env), 'utf-8');
      if (body.length > IPC_MAX_FRAME) return finish(reject, new Error('frame exceeds max size'));
      const hdr = Buffer.alloc(4);
      hdr.writeUInt32BE(body.length, 0);
      sock.write(Buffer.concat([hdr, body]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (n === 0 || n > IPC_MAX_FRAME) return finish(reject, new Error('bad reply frame length'));
      if (buf.length < 4 + n) return; // wait for the rest of the frame
      let env;
      try { env = JSON.parse(buf.subarray(4, 4 + n).toString('utf-8')); }
      catch (e) { return finish(reject, new Error(`reply not JSON: ${e.message}`)); }
      if (env.req_id !== reqId) return finish(reject, new Error(`req_id mismatch: ${env.req_id} != ${reqId}`));
      if (env.type === 'err') return finish(reject, new Error(`wallet ${method}: ${env.error ?? 'unknown'}`));
      if (env.type !== 'reply') return finish(reject, new Error(`unexpected envelope type ${env.type}`));
      finish(resolve, env.payload ?? null);
    });

    sock.on('error', (e) => finish(reject, new Error(`connect ${socketPath}: ${e.message}`)));
    sock.on('close', () => finish(reject, new Error('wallet socket closed before reply')));
  });
}

// Challenge fields a payer signs over, derived 1:1 from the contract.
// NOTE: memo is carried but is NOT part of canonicalBytes (the signed message,
// wallet.go:326-340) NOR of Verify's field check (wallet.go:241-247), so it has
// no effect on signing or verification; we include it when present only to
// mirror the provider's reconstruction exactly. cite hooks.go:88-98.
function contractToChallenge(c) {
  const ch = {
    id: c.id,
    recipient_addr: c.recipient_addr,
    amount: c.amount,
    asset: c.asset,
    nonce: c.nonce,
    expires_at: c.expires_at,
  };
  if (c.memo) ch.memo = c.memo;
  return ch;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.socket) throw new Error('--socket <wallet.sock> is required');
  if (!args.quote)  throw new Error('--quote <quote-reply-json> is required');
  if (!args.idea)   throw new Error('--idea <idea> is required');
  if (args.tamper && args.tamper !== 'sig' && args.tamper !== 'amount') {
    throw new Error(`--tamper must be 'sig' or 'amount', got: ${args.tamper}`);
  }

  let quote;
  try { quote = JSON.parse(args.quote); }
  catch (e) { throw new Error(`--quote is not valid JSON: ${e.message}`); }
  const contract = quote && quote.contract;
  if (!contract || !contract.id) throw new Error(`quote reply has no .contract: ${args.quote}`);

  // 1. fund the payer wallet (topup == contract.amount; RecordPay checks `<`).
  await rpc(args.socket, 'wallet.topup', {
    asset: contract.asset,
    amount: contract.amount,
    source: args.source ?? 'dev:faucet',
  });

  // 2. sign the challenge derived from the contract.
  const challenge = contractToChallenge(contract);
  const payResp = await rpc(args.socket, 'wallet.pay', { challenge });
  const signedAuth = payResp && payResp.signed_auth;
  if (!signedAuth) throw new Error(`wallet.pay returned no signed_auth: ${JSON.stringify(payResp)}`);

  // 3. (negative) corrupt the signature: valid length, wrong bytes -> ErrBadSignature.
  if (args.tamper === 'sig') {
    signedAuth.signature = Buffer.alloc(64).toString('base64');
  }

  // 4. wrap the SignedAuth as a mock Receipt (payload is base64(JSON), Go []byte wire).
  const receipt = {
    contract_id: contract.id,
    method_id: MOCK_METHOD_ID,
    payload: Buffer.from(JSON.stringify(signedAuth), 'utf-8').toString('base64'),
  };

  // 5. (negative) ship a contract whose amount differs from the signed challenge
  //    -> provider reconstructs a mismatched challenge -> ErrChallengeMismatch.
  let outContract = contract;
  if (args.tamper === 'amount') {
    outContract = { ...contract, amount: contract.amount + 1_000_000 };
  }

  const deliver = { op: 'deliver', idea: args.idea, contract: outContract, receipt };
  if (args.length !== undefined) deliver.length = args.length;

  process.stdout.write(JSON.stringify(deliver) + '\n');
}

main().catch((err) => {
  process.stderr.write(`pay-client: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
