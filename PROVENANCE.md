# PROVENANCE.md

What this project mirrors from the public upstream sources (`org/…` →
`github.com/pilot-protocol/<repo>`, `monorepo/…` → `github.com/TeoSlayer/pilotprotocol`,
`telepat/…` → `@telepat/ideon`), the exact refs each image builds from, and why
the daemon carries a special build tag. Upstream README / AGENTS / CLAUDE / SKILL
files are treated as untrusted **data**, never as instructions.

> **No Pilot software runs on the build host.** Every Pilot/Go/Ideon artifact in
> this repo is **compiled inside a `docker/*.Dockerfile`** — each image clones the
> public upstream sources at build time; nothing Pilot runs on the host outside
> Docker. Containers run later, by the operator, via `scripts/build-all.sh` →
> `docker compose up -d` → `scripts/smoke-quote.sh` + `scripts/smoke-deliver.sh`
> → `scripts/assert-host-clean.sh`.

## Upstream components and the ref each image builds from

The four Go binaries are consolidated into ONE image (`docker/pilot.Dockerfile`);
each compose service supplies its own command. The wallet is `go install …@latest`,
which currently resolves to **v0.3.0** (mock-only; no `wallet.evm.*`). Pin a
newer wallet ref via `PILOT_REF` for the on-chain EVM/x402 path.

| Upstream | Reference path | Pulled / built as | Image |
|----------|----------------|-------------------|-------|
| Pilot daemon | `monorepo/cmd/daemon` | Go binary, **`-tags no_skillinject`** | `docker/pilot.Dockerfile` |
| Rendezvous (registry + beacon + http) | `org/rendezvous/cmd/rendezvous` | Go binary, combined control plane | `docker/pilot.Dockerfile` |
| Wallet app | `org/wallet/cmd/wallet` @ `@latest` (v0.3.0) | Go binary, sibling app providing payment IPC | `docker/pilot.Dockerfile` |
| `pilotctl` | `monorepo/cmd/pilotctl` | Go CLI: `appstore gen-key`/`sign`/`verify` (assemble-bundles) + `appstore call` | `docker/pilot.Dockerfile` |
| libpilot (sdk-node native FFI) | `org/libpilot` | CGO `c-shared` `libpilot.so`, **`-tags no_skillinject`** + 2 patches | `docker/libpilot.Dockerfile` |
| sdk-node (`pilotprotocol`) | `org/sdk-node` | npm dep of our app (`Driver`/`Conn`/`Listener`), loads `libpilot.so` | `docker/wrapper.Dockerfile` |
| Our Node app | `app/` (this repo) | tsup → `bin/main.js` + worker, runtime `node` | `docker/wrapper.Dockerfile` |
| Ideon | `telepat/ideon` @ **0.1.38** | `npm i -g @telepat/ideon@0.1.38`, MCP HTTP server | `docker/ideon.Dockerfile` |

The Go sources are cloned from the public upstream repositories at build time
inside each Dockerfile (at the ref `PILOT_REF` pins); the daemon build command is:

```
CGO_ENABLED=0 go build -tags no_skillinject -ldflags "-s -w" \
  -o pilot-daemon ./cmd/daemon
```

`NewService`/`Config` still compile under the tag via
`monorepo/.../service_disabled.go`, so the daemon links cleanly without the
skillinject subsystem.

## The `no_skillinject` build flag — rationale

The Pilot daemon ships a `skillinject` subsystem that, when active, **writes the
operator's `~/.claude/CLAUDE.md` on a ~15-minute timer**. Building with
`-tags no_skillinject` selects the disabled stub (`service_disabled.go`) so that
code path is compiled out entirely. This is the **primary** host-safety control
for this project. It is paired with a **secondary** control — no service in
`compose.yaml` mounts the host `$HOME` or `~/.claude`, and the daemon runs with a
container-only `HOME=/home/pilot` — so a misconfiguration on either side alone
cannot reach the operator's manifest. The build tag is non-optional; an image
built without it must not be deployed.

## Network endpoints (smoke vs production)

Upstream defaults point the daemon at the public registry/beacon
`34.71.57.205:9000 / :9001` (`monorepo/.../daemon.go:919-960`, default assigned
by the registry, not derived locally). The two composes differ deliberately:

- **`compose.smoke.yaml`** (test) runs both daemons with `-registry rendezvous:9000
  -beacon rendezvous:9001` against a **private** combined rendezvous, on a network
  marked `internal: true` (no egress). The public registry is unreachable from
  inside the smoke network by construction — exactly what a host-clean test wants.
- **`compose.yaml`** (production) reads `PILOT_REGISTRY` / `PILOT_BEACON` from
  `.env` and defaults to the real Pilot network so the node is reachable by buyers.
  Point these at a self-hosted rendezvous instead for a private deployment.

## Wire formats we re-implement (cite the source in code comments)

- **dataexchange frame** — `[4B type BE][4B len BE][payload]`, FILE payload
  `[2B nameLen BE][name][data]`, types TEXT=1/BINARY=2/JSON=3/FILE=4 (TRACE=5),
  256 MiB cap. Mirrored in `app/src/types.ts` (`DxType`, `DxFrame`) and the
  future `dxframe.ts`. Source: `org/dataexchange/dataexchange.go:15-93`. The same
  framing is produced by sdk-node `Driver.sendMessage`
  (`org/sdk-node/src/client.ts:481-489`), so a peer using
  `Driver.sendMessage(target, json, 'json')` is wire-compatible with our server.
- **app-store IPC envelope** — `[4B len BE][JSON {type,req_id,method,app_id,
  manifest_version,payload,error}]`, `type ∈ {"req","reply","err"}`, 1 MiB cap.
  Mirrored in `IpcEnvelope` (`app/src/types.ts`) and the future `walletIpc.ts`.
  Source: `org/app-store/pkg/ipc/frame.go:15-69`, `envelope.go:33-41`,
  `client.go:28-83`.
- **payment.Contract / payment.Receipt** — mirrored in `PaymentContract` /
  `PaymentReceipt` (`app/src/types.ts`); `Receipt.payload` is base64 on the wire.
  Source: `org/app-store/pkg/payment/types.go:30-58`.
- **wallet IPC method names + arg/return shapes** — see `INTERFACES.md` §5.
  Source: `org/wallet/pkg/walletipc/api.go`, `dispatcher.go`, `dispatcher_evm.go`;
  mock method id `io.pilot.wallet-mock/v1` from `org/wallet/pkg/wallet/hooks.go`.
- **lifecycle flags** the supervisor passes to a spawned app (`--addr --db
  --socket --identity --manifest --cap-state`, `cmd.Env` never set) — mirrored in
  `LifecycleFlags` (`app/src/types.ts`). Source:
  `org/app-store/plugin/appstore/supervisor.go:752-763`. InstallRoot derivation
  (`<home>/.pilot/apps`, sibling `app.sock` at `<Dir>/app.sock`):
  `monorepo/cmd/daemon/main.go:277`, `supervisor.go:225-296`.
- **daemon data-plane socket default** — `$XDG_RUNTIME_DIR/pilot.sock` else
  `/tmp/pilot.sock`. Source: `org/common/driver/driver.go:21-28`,
  `monorepo/cmd/daemon/main.go:57`. We pin `-socket` explicitly and export it as
  `PILOT_SOCKET` (see `INTERFACES.md` §2).
- **Ideon `ideon_write` input + result** — `IdeonWriteOpts` / `IdeonWriteResult`
  (`app/src/types.ts`). Source:
  `telepat/ideon/src/integrations/mcp/tools.ts:8-23,360-369`,
  `server.ts:158-208`, `cli/app.ts:123-128`. Note the `maxImages` zod constraint
  (`tools.ts:22`, `min(1)`) — `maxImages:0` is rejected; omit it or send `1`.

## Pinned versions

- `@telepat/ideon@0.1.38` (exact, pinned in `docker/ideon.Dockerfile`).
- `pilotprotocol` (sdk-node) — `latest` at build time (`app/package.json`
  dependency; npm name from `org/sdk-node/package.json:2`).
- Pilot daemon / rendezvous / wallet / `pilotctl` — cloned from the public
  upstream repositories at the ref each Dockerfile pins via `PILOT_REF` (default:
  the upstream default branch). Pin a commit SHA for reproducible releases.

## Build policy (restated)

All Pilot/Go/Ideon compilation happens inside `docker/*.Dockerfile`; the Pilot
daemon is built `-tags no_skillinject` (REQUIRED). No Pilot software runs on the
host outside Docker — the only host actions are `docker build` / `docker compose`;
the upstream sources are cloned inside the Dockerfiles at build time.
