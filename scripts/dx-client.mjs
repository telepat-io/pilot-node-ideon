#!/usr/bin/env node
//
// dx-client.mjs — minimal caller-side dataexchange client for the smoke test.
//
// Connects to the CALLER daemon's data-plane unix socket, resolves the
// provider by hostname, dials provider:1001, writes ONE dataexchange JSON
// frame (our ArticleRequest), and prints the decoded JSON reply frame to
// stdout. Everything else (assertions, payment dance) lives in
// smoke-test.sh, which calls this for each round-trip.
//
// Wire format — dataexchange frame (org/dataexchange/dataexchange.go:64-93):
//   [4B type BE][4B len BE][payload]; types TEXT=1 BINARY=2 JSON=3 FILE=4.
// We send and expect DxType.JSON (3) with a JSON.stringify'd body. This is
// byte-identical to what sdk-node's Driver.sendMessage(target, json, 'json')
// writes (org/sdk-node/src/client.ts:481-489) — but sendMessage only reads a
// short ACK header, whereas we need the FULL reply frame, so we dial and
// frame by hand.
//
// Usage:
//   dx-client.mjs --socket <caller.sock> --target <hostname-or-addr> \
//                 --json '<request-json>'  [--timeout-ms 60000]
//
// Prints the reply JSON (one line) on success; exits non-zero with a
// diagnostic on stderr on any framing/transport error.

import { Driver } from 'pilotprotocol';

// ── arg parsing (tiny, dependency-free) ─────────────────────────────────────
function parseArgs(argv) {
  const out = { timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--socket':     out.socket = argv[++i]; break;
      case '--target':     out.target = argv[++i]; break;
      case '--json':       out.json = argv[++i]; break;
      case '--port':       out.port = parseInt(argv[++i], 10); break;
      case '--timeout-ms': out.timeoutMs = parseInt(argv[++i], 10); break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

const DX_JSON = 3;          // DxType.JSON
const DX_PORT = 1001;       // dataexchange / capability port (PortDataExchange)
const MAX_FRAME = 1 << 28;  // 256 MiB cap (dataexchange.go:62,104)

// readExactly loops because Conn.read() may short-read (client.ts:78-90).
function readExactly(conn, n) {
  const parts = [];
  let got = 0;
  while (got < n) {
    const chunk = conn.read(n - got);
    if (!chunk || chunk.length === 0) {
      throw new Error('peer closed mid-frame');
    }
    parts.push(chunk);
    got += chunk.length;
  }
  return Buffer.concat(parts, n);
}

function encodeJsonFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(DX_JSON, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.socket) throw new Error('--socket <caller daemon socket> is required');
  if (!args.target) throw new Error('--target <provider hostname-or-addr> is required');
  if (!args.json)   throw new Error('--json <request body> is required');

  const port = Number.isInteger(args.port) ? args.port : DX_PORT;

  let request;
  try {
    request = JSON.parse(args.json);
  } catch (e) {
    throw new Error(`--json is not valid JSON: ${e.message}`);
  }

  const d = new Driver(args.socket);
  try {
    // ── resolve the provider address ────────────────────────────────────
    // TODO(provider-discovery): the provider advertises hostname "provider"
    // on the shared private rendezvous (compose runs daemon-provider with
    // `-hostname provider -public`). We resolve it here via the daemon's
    // PilotResolveHostname RPC. If the caller already has a literal overlay
    // address ("0:...."), pass it through unchanged. resolveHostname returns
    // { address, ... } (client.ts:270-272); _resolveTarget in sdk-node uses
    // the same "starts with 0:" heuristic (client.ts:460-468).
    let addr = args.target;
    if (!addr.startsWith('0:')) {
      const res = d.resolveHostname(addr);
      addr = res && res.address;
      if (!addr) {
        throw new Error(
          `could not resolve provider hostname ${JSON.stringify(args.target)} ` +
          `via rendezvous — is daemon-provider up with -hostname provider -public, ` +
          `and pointed at the same rendezvous as this caller?`,
        );
      }
    }

    // ── dial provider:PORT and round-trip one frame ─────────────────────
    const conn = d.dial(`${addr}:${port}`, args.timeoutMs);
    try {
      conn.setReadDeadline(args.timeoutMs);
      conn.write(encodeJsonFrame(request));

      // Read the reply frame: [4B type BE][4B len BE][payload].
      const hdr = readExactly(conn, 8);
      const type = hdr.readUInt32BE(0);
      const len = hdr.readUInt32BE(4);
      if (len > MAX_FRAME) {
        throw new Error(`reply frame length ${len} exceeds 256 MiB cap`);
      }
      const body = readExactly(conn, len);

      // We expect JSON back. Emit the raw JSON body on stdout (one line) so
      // the shell harness can jq it; surface the frame type on stderr for
      // debugging if it is ever not JSON.
      if (type !== DX_JSON) {
        process.stderr.write(`warn: reply frame type=${type} (expected JSON=3)\n`);
      }
      process.stdout.write(body.toString('utf-8'));
      process.stdout.write('\n');
    } finally {
      conn.close();
    }
  } finally {
    d.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`dx-client: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
