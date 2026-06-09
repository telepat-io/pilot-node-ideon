# INTERFACES.md — code-backed API contract for io.telepat.ideon-article

All citations are `file:line` into the public upstream sources: `org/…` maps to
`github.com/pilot-protocol/<repo>`, `monorepo/…` to
`github.com/TeoSlayer/pilotprotocol`, and `telepat/…` to the `@telepat/ideon`
package. This file is the authority the Node wrapper codes against;
`app/src/types.ts` is its machine-readable companion.

There are **two distinct wire formats**, never to be conflated:

| Layer | Direction | Framing | Source |
|-------|-----------|---------|--------|
| **app-store IPC** | app ⇄ daemon, app ⇄ wallet (unix socket) | `[4B len BE][JSON Envelope]`, cap 1 MiB | `org/app-store/pkg/ipc/frame.go:15-69`, `envelope.go:33-41` |
| **dataexchange** | peer ⇄ peer over Pilot overlay (port 1001) | `[4B type BE][4B len BE][payload]`, cap 256 MiB | `org/dataexchange/dataexchange.go:64-93` |

---

## 1. sdk-node Driver / Conn / Listener (`org/sdk-node/src/client.ts`)

`pilotprotocol` (npm name in `org/sdk-node/package.json:2`). A `Driver` dials an
**already-running** daemon's IPC socket via FFI (`PilotConnect`).

### Constructor / lifecycle
- `new Driver(socketPath = DEFAULT_SOCKET_PATH)` — `client.ts:189-193`. Default
  socket `'/tmp/pilot.sock'` (`client.ts:38`). Pass our daemon's data-plane
  socket explicitly (see §2 for why and which path).
- `d.close(): void` — `client.ts:196-202`. Idempotent. `[Symbol.dispose]` too.

### Server side (what OUR capability uses)
- `d.listen(port: number): Listener` — `client.ts:328-333`. Binds a port on the
  overlay. **Port 1001 is the dataexchange port** (`PortDataExchange`), so a
  listener on 1001 receives dataexchange frames from peers.
- `listener.accept(): Conn` — `client.ts:158-164`. **Blocking.** One conn per peer.
- `listener.close(): void` — `client.ts:167-173`.

### Conn (per-connection stream)
- `conn.read(size = 4096): Buffer` — `client.ts:78-90`. **Blocks until data.**
  Returns `Buffer.alloc(0)` on size<=0 / zero bytes. NB: may return fewer bytes
  than requested — frame readers must loop until the wanted length is gathered.
- `conn.write(data: Buffer|Uint8Array|string): number` — `client.ts:93-106`.
  Returns bytes written.
- `conn.setReadDeadline(d: Date|number|null): void` — `client.ts:124-137`. Number
  = ms-from-now; `null` clears.
- `conn.close(): void` — `client.ts:109-115`.

### Client side (dialing a peer)
- `d.dial(addr, timeoutMs?): Conn` — `client.ts:317-325`. `addr` format
  `"N:XXXX.YYYY.YYYY:PORT"` (`client.ts:313`).
- `d.resolveHostname(hostname): {address, ...}` — `client.ts:270-272`.
- `d.setHostname(hostname): {...}` — `client.ts:275-277`.
- `d.setVisibility(isPublic: boolean): {...}` — `client.ts:282-284`.
- `d.deregister()`, `d.setTags(string[])` — `client.ts:287-294`.

### High-level peer helpers (build dataexchange frames for you)
- `d.sendMessage(target, data, msgType='text'|'json'|'binary'): {...}` —
  `client.ts:477-516`. Internally dials `${addr}:1001`, writes
  `[4B type][4B len][payload]` (`client.ts:485-489`), reads an 8-byte ACK header
  then the ACK body. **Type map: text=1, binary=2, json=3, file=4**
  (`client.ts:482`). This is the *client* counterpart of our server.
- `d.sendFile(target, filePath): {...}` — `client.ts:524-570`. FILE payload =
  `[2B nameLen BE][name][data]` (`client.ts:534-536`).

### Minimal connect → listen(1001) → accept → read → write (REAL API)

```ts
import { Driver } from 'pilotprotocol';

const d = new Driver(process.env.PILOT_SOCKET ?? '/tmp/pilot.sock');
const lis = d.listen(1001);                  // dataexchange port
for (;;) {
  const conn = lis.accept();                 // blocks for a peer
  // read the 8-byte dataexchange header: [4B type BE][4B len BE]
  const hdr = readExactly(conn, 8);
  const type = hdr.readUInt32BE(0);
  const len  = hdr.readUInt32BE(4);
  const body = readExactly(conn, len);       // [type][len][body]
  // ... decode body (JSON for our request), build a reply ...
  const reply = Buffer.from(JSON.stringify(resp));
  const out = Buffer.alloc(8 + reply.length);
  out.writeUInt32BE(3, 0);                    // 3 = JSON
  out.writeUInt32BE(reply.length, 4);
  reply.copy(out, 8);
  conn.write(out);
  conn.close();
}

// conn.read() may short-read; loop until `n` bytes are gathered.
function readExactly(conn: { read(n?: number): Buffer }, n: number): Buffer {
  const parts: Buffer[] = []; let got = 0;
  while (got < n) {
    const chunk = conn.read(n - got);
    if (chunk.length === 0) throw new Error('peer closed mid-frame');
    parts.push(chunk); got += chunk.length;
  }
  return Buffer.concat(parts, n);
}
```

`index.ts` re-exports only `Driver, Conn, Listener, DEFAULT_SOCKET_PATH,
PilotError` (`org/sdk-node/src/index.ts:1`). No standalone `connect()`/`accept()`
free functions — everything hangs off the `Driver` instance.

---

## 2. How a spawned app reaches the daemon + the wallet socket

### What the supervisor passes (and does NOT pass)
The supervisor spawns the app binary with exactly six flags
(`org/app-store/plugin/appstore/supervisor.go:752-759`):

```
--addr <daemon-pilot-addr>   our OWN pilot overlay address (e.g. 0:0001.HHHH.LLLL)
--db <Dir>/data.db           state path
--socket <Dir>/app.sock      unix socket WE must create  (Dir = <InstallRoot>/<app_id>)
--identity <Dir>/identity... ed25519 identity file
--manifest <Dir>/manifest.json
--cap-state <Dir>/cap-state.jsonl
```

`--addr` is the daemon's own overlay address (`daemonAddrFromDeps`,
`supervisor.go:935-944`) — it is **not** a socket path. `cmd.Env` is **never
set** (`supervisor.go:760-763` only sets Stdout/Stderr/SysProcAttr), so the child
**inherits the daemon's environment** verbatim.

### (a) Reaching the daemon data plane (to `listen(1001)`)
The wallet binary (`org/wallet/cmd/wallet/main.go`) is the canonical reference
app, and it **never calls `driver.Connect`** — it only opens a `net.Listen("unix",
*sockPath)` on `--socket` (`main.go:216`) and serves app-store IPC. The wallet is
IPC-only; it does **no** dataexchange.

OUR app is different: it must accept peer requests over the overlay, so it **must**
open its own `Driver` to the daemon's data-plane socket and call `listen(1001)`.
The daemon's data-plane socket is the daemon's `-socket` flag, which defaults to
`driver.DefaultSocketPath()` (`monorepo/cmd/daemon/main.go:57`).
`DefaultSocketPath()` (`org/common/driver/driver.go:21-28`) is:
- `$XDG_RUNTIME_DIR/pilot.sock` on Linux when `XDG_RUNTIME_DIR` is set,
- else `/tmp/pilot.sock`.
`driver.Connect("")` also honors `$PILOT_SOCKET` indirectly only via the empty →
default path; the Go test fleet sets `PILOT_SOCKET` explicitly
(`monorepo/tests/zz_agent_alpha_direct_path_test.go:109`).

**RESOLVED MECHANISM (a):** our wrapper constructs
`new Driver(process.env.PILOT_SOCKET ?? '/tmp/pilot.sock')` and calls
`.listen(1001)`. Because we control the compose file, we will run the daemon with
an explicit, stable `-socket /run/pilot/pilot.sock` and export the same path to
our app's container as `PILOT_SOCKET` (or bind the daemon socket at
`/tmp/pilot.sock`). Pin `XDG_RUNTIME_DIR` consistently so the default resolves the
same in both processes if we rely on the default.

> Caveat: port 1001 is also where the daemon's **built-in** dataexchange service
> binds when `-no-dataexchange` is NOT passed (`monorepo/cmd/daemon/main.go:227`).
> The pinned topology runs the daemon with `-no-dataexchange` to free port 1001 so
> OUR app can bind it. Confirm a single listener owns 1001. (See OPEN QUESTION 1.)

### (b) Locating the wallet app.sock
Each installed app lives at `<InstallRoot>/<app_id>` with its socket at
`<Dir>/app.sock` (`supervisor.go:225-296`, `:296` sets
`SocketPath: filepath.Join(dir, "app.sock")`). `InstallRoot` is
`<home>/.pilot/apps` (`monorepo/cmd/daemon/main.go:277`). The wallet's id is
`io.pilot.wallet` (wallet `manifest.json:id`).

**RESOLVED MECHANISM (b):** our wrapper opens a plain Node `net.connect` to the
**sibling** path
`<InstallRoot>/io.pilot.wallet/app.sock`, i.e. relative to our own `--socket`:
`path.join(path.dirname(flags.socket), '..', 'io.pilot.wallet', 'app.sock')`.
Over that connection we speak the **app-store IPC envelope** (§4), not
dataexchange. We derive `InstallRoot` from our `--socket` flag's grandparent
directory rather than re-deriving `$HOME` (robust to the daemon's `$HOME`).

> The "correct" production path is for the daemon to broker app→app IPC so the
> caller never needs the sibling path; but the supervisor's broker
> (`supervisor.go:865-889`, `dialer.DialContext("unix", app.SocketPath)`) is the
> daemon dialing the app, not an app dialing a sibling. For v1 we dial the sibling
> socket directly. (See OPEN QUESTION 2.)

---

## 3. dataexchange frame wire (`org/dataexchange/dataexchange.go`)

- Types: `TEXT=1, BINARY=2, JSON=3, FILE=4, TRACE=5` (`dataexchange.go:15-23`).
- `WriteFrame`: header `[4B type BE][4B len BE]` then payload
  (`dataexchange.go:85-92`). For `TypeFile` the payload is rewritten to
  `[2B nameLen BE][name][data]` *before* the length is computed
  (`dataexchange.go:76-83`).
- `ReadFrame`: reads 8-byte header, rejects `len > 1<<28` (256 MiB,
  `dataexchange.go:62,104`), reads payload; for FILE strips the name prefix,
  rejects path-traversal / non-UTF8 names (`dataexchange.go:115-137`).
- Server pattern: `Driver.Listen(PortDataExchange)` → `Accept` loop → per-conn
  `ReadFrame` → handler (`org/dataexchange/server.go:29-56`). Example client
  sends TEXT then JSON and reads ACK frames (`examples/main.go:75-104`).
- **Our use:** request and response both travel as a single `DxType.JSON` frame
  whose payload is `JSON.stringify(ArticleRequest|ArticleResponse)`.

This exactly matches sdk-node's `sendMessage` framing (`client.ts:481-489`), so a
peer using `Driver.sendMessage(target, json, 'json')` is wire-compatible with our
server.

---

## 4. app-store IPC envelope (`org/app-store/pkg/ipc/*`)

- **Framing** (`frame.go`): `WriteFrame` = `[4B len BE][json]`, reject
  `len > 1<<20` (1 MiB, `frame.go:15,29`). `ReadFrame` rejects zero-length and
  oversize frames (`frame.go:54-59`).
- **Envelope** (`envelope.go:33-41`): `{type, req_id, method?, app_id?,
  manifest_version?, payload?, error?}`. `type ∈ {"req","reply","err"}`
  (`envelope.go:17-24`).
- **Call pattern** (`client.go:28-75`): caller writes a `req` envelope with a
  fresh 8-byte hex `req_id` (`client.go:77-83`), reads one frame, checks
  `reply.req_id == req_id` (`client.go:58`), then: `type=="err"` → error from
  `reply.error`; `type=="reply"` → JSON-unmarshal `reply.payload` into result.
- Args/result are JSON; `payload` is `json.RawMessage`. `[]byte` fields (e.g.
  `Receipt.payload`) are **base64** on the wire.

**Our Node client** (`walletIpc.connectWallet`) implements this: write
`[4B len][{type:"req",req_id,method,payload}]`, read `[4B len][envelope]`, match
`req_id`, surface `err`. One in-flight call per connection (`client.go:20-21`).

---

## 5. wallet IPC methods (`org/wallet/pkg/walletipc/*`)

Method-name constants (`walletipc/api.go:15-35`); all are listed in the wallet
`manifest.json` `exposes`. Registered in `NewDispatcher`
(`walletipc/dispatcher.go:19-33`); EVM ones only when the wallet has an EVM
binding (`dispatcher_evm.go:26-35`).

### Internal-ledger (mock) flow — `io.pilot.wallet-mock/v1`
The **mock** Method (`wallet/pkg/wallet/hooks.go`, `MockMethodID =
"io.pilot.wallet-mock/v1"`) is the offline/dev backend. It is **NOT** exposed
under `wallet.evm.*`. It is reachable through the Challenge/SignedAuth IPC methods:

- `wallet.address` → `{address}` (`api.go:72-74`, `dispatcher.go:79-83`). The
  wallet's *pilot* address (not EVM). Use as our payee identity for the mock path.
- `wallet.request {amount, asset, expires_in_seconds, memo?}` →
  `{challenge}` (`api.go:78-89`, `dispatcher.go:85-100`). The payee (us) issues a
  Challenge.
- `wallet.pay {challenge}` → `{signed_auth}` (`api.go:93-98`,
  `dispatcher.go:102-114`). The **payer** signs. (Caller-side, not ours.)
- `wallet.verify {challenge, signed_auth}` → `{ok}` (`api.go:102-108`,
  `dispatcher.go:116-127`). We (payee) verify the payer's SignedAuth.
- `wallet.settle {challenge, signed_auth}` → `{transaction}`
  (`api.go:112-118`, `dispatcher.go:129-141`).

The mock Method itself maps a `payment.Contract` → internal `Challenge` and signs
via `Pay` (`hooks.go` `Satisfy`/`contractToChallenge`); its Receipt
`method_id == io.pilot.wallet-mock/v1`, payload = JSON SignedAuth.

### EVM / x402 flow — `io.pilot.wallet/v1`
Registered only with EVM support (`dispatcher_evm.go:26-35`). All accept an
optional `chain_id` (omit → primary chain).

- `wallet.evm.address {chain_id?}` → `{address, chain_id, token}`
  (`api.go:176-184`, `dispatcher_evm.go:64-80`). `address` = 0x-prefixed EVM
  recipient — **this is OUR payee RecipientAddr** for an on-chain/x402 contract.
- `wallet.evm.balance {chain_id?}` → `{address, chain_id, token, balance,
  rpc_enabled}` (`api.go:186-196`, `dispatcher_evm.go:82-104`).
- `wallet.evm.satisfy {chain_id?, contract}` → `{receipt}`
  (`api.go:200-207`, `dispatcher_evm.go:106-129`). **Payer-side** — produces a
  signed EIP-3009 Receipt with `method_id == io.pilot.wallet/v1`. Not ours.
- `wallet.evm.verify {chain_id?, contract, receipt}` → `{ok}`
  (`api.go:209-217`, `dispatcher_evm.go:131-151`). **We (payee) call this** to
  verify the caller's on-chain authorization receipt.
- `wallet.evm.chains` → `{primary, chains[]}` (`api.go:224-233`,
  `dispatcher_evm.go:153-169`). Discover configured chain IDs.

### How to request the MOCK method specifically
There is **no** single `satisfy`/`verify` IPC method that takes a
`method_id` argument and routes to the mock. The routing is implicit:

- `wallet.evm.satisfy` / `wallet.evm.verify` → always the **EVM** method
  (`io.pilot.wallet/v1`), via `w.SatisfyEVMOn` / `EVMMethodFor`
  (`dispatcher_evm.go:121,142`).
- The mock method (`io.pilot.wallet-mock/v1`) is exercised via
  `wallet.request` → `wallet.pay` → `wallet.verify` (Challenge/SignedAuth), OR
  via the in-process payment hooks where `Contract.accepted_methods` includes
  `io.pilot.wallet-mock/v1` (`hooks.go` `contractMatchesWallet`).

**Smoke-test consequence:** for the pinned MOCK smoke test, drive payment as a
Contract whose `accepted_methods = ["io.pilot.wallet-mock/v1"]`, and either
(i) reproduce the Challenge/SignedAuth dance over `wallet.request`/`wallet.pay`/
`wallet.verify`, or (ii) have the caller's wallet `Satisfy` the contract via the
mock Method and we verify with `wallet.verify` after decoding the receipt's
SignedAuth. See OPEN QUESTION 3.

### payment.Contract / Receipt (`org/app-store/pkg/payment/types.go:30-58`)
```
Contract { id, amount(uint64, USDC 6dp), asset:"USDC", recipient_addr,
           expires_at(RFC3339), nonce, accepted_methods?, accepted_escrows?, memo? }
Receipt  { contract_id, method_id, payload([]byte → base64 on wire) }
```

---

## 6. Ideon MCP (`telepat/ideon` @ 0.1.38)

- Serve: `ideon mcp serve-http --api-key <k> --host 0.0.0.0 --port 3001
  --endpoint /mcp`. Flag defaults: `--port 3001`, `--host 127.0.0.1`,
  `--endpoint /mcp`, `--api-key` from `$IDEON_MCP_API_KEY`
  (`telepat/ideon/src/cli/app.ts:123-128`). **Must override host to 0.0.0.0** for
  cross-container reach (default binds loopback only).
- Stateful HTTP transport: `StreamableHTTPServerTransport`, exposes the
  `Mcp-Session-Id` header (`integrations/mcp/httpServer.ts:41,52-54`). Flow:
  `POST /mcp` (Bearer key) `initialize` → capture `Mcp-Session-Id` from the
  response → subsequent `POST /mcp` with that header for `tools/call`.
- Tool `ideon_write`, required `["idea"]` (`integrations/mcp/tools.ts:360-369`).
  Input schema (`tools.ts:8-23`): `idea` (required), `primary?` (string spec,
  e.g. `"article=1"` — parsed by `parsePrimaryAndSecondarySpecs`,
  `server.ts:168-171`), `style?`, `intent?`, `length?` (named bucket or positive
  int), `dryRun?`, `maxImages?`.
  **WARNING:** `maxImages` is `z.coerce.number().int().min(1)` (`tools.ts:22`) —
  **`maxImages: 0` is REJECTED by zod.** To suppress images either OMIT
  `maxImages` entirely or set `maxImages: 1`. (The pinned fact `maxImages:0` is
  not accepted by this version. See OPEN QUESTION 4.)
- Result (`server.ts:192-208`): `content[0].text` summary + `structuredContent`:
  `{ slug, title, outputCount, markdownPath, markdownPaths, generationDir,
  analyticsPath }`. Dry-run still writes a placeholder `article-1.md` + `meta.json`
  under `$IDEON_HOME/.ideon/output/<...>/`; we read `markdownPath` to get the body.
- Env: `TELEPAT_DISABLE_KEYTAR=true`, `IDEON_HOME=/data/ideon`, plus
  `IDEON_MCP_API_KEY`.

---

## OPEN QUESTIONS (resolve during build)

1. **Port 1001 ownership.** Our app and the daemon's built-in dataexchange both
   want port 1001. The pinned topology runs the daemon with `-no-dataexchange`
   (`monorepo/cmd/daemon/main.go:227` gates registration on `!*noDataExchange`) to
   free it. Confirm that with `-no-dataexchange` the overlay still lets an app
   `listen(1001)` (i.e. 1001 is a logical overlay port the app owns, not a host
   TCP port the daemon pre-binds). If `listen(1001)` collides, pick a different
   capability port and have callers `dial(addr:PORT)` directly instead of
   `sendMessage` (which hardcodes :1001, `client.ts:491`).

2. **App→sibling-app IPC.** We dial `<InstallRoot>/io.pilot.wallet/app.sock`
   directly. Verify the wallet's socket is `0600` owned by the same UID as our app
   (wallet chmods 0600, `wallet/cmd/wallet/main.go:215,224`); since the daemon
   spawns both under its own UID this should be readable, but confirm in-container.
   If the daemon enforces broker-only app IPC, we instead need the daemon's
   app→app bridge entrypoint (not found on the spawned-app side in this tree).

3. **Mock payment path end-to-end.** Decide the exact mock smoke flow: the
   `wallet.evm.*` methods route to the EVM method only; the mock
   (`io.pilot.wallet-mock/v1`) is reached via `wallet.request`/`wallet.pay`/
   `wallet.verify`. Pin which side issues the Challenge (we, the payee, via
   `wallet.request`) and which side signs (the caller, via `wallet.pay`), and how
   the caller transmits the `signed_auth` (inside the `op:"deliver"` frame as the
   receipt payload). Our `PaymentReceipt.payload` (base64 SignedAuth JSON) carries it.

4. **`maxImages` value.** `maxImages:0` is rejected by the zod schema in 0.1.38.
   Build must OMIT `maxImages` (relies on `dryRun:true` to avoid real image
   generation) or send `maxImages:1`. Confirm dry-run never calls Replicate.

5. **`primary` spec exact grammar.** `primary:"article=1"` is passed to
   `parsePrimaryAndSecondarySpecs` (`server.ts:168`,
   `src/cli/commands/writeTargetSpecs.ts` — not read in full). Confirm `"article=1"`
   yields one primary article output before relying on it.

6. **EVM enabled in the air-gapped wallet?** `wallet.evm.address` only exists when
   the wallet was started WITHOUT `-no-evm` (`dispatcher_evm.go:27`). The wallet
   signs EIP-3009 even with no RPC, but for the MOCK smoke test we do not need an
   EVM key — `wallet.address` suffices as the payee identity. Decide whether to run
   the wallet with EVM on (so `wallet.evm.address` works for a future on-chain path)
   or off (mock-only).
