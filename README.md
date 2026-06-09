# pilot-node-ideon — `io.telepat.ideon-article`

A containerized **Pilot Protocol app-store node** that sells articles:
`request-article → pay (USDC authorization) → deliver`, by wrapping Ideon's
`ideon_write` MCP tool.

## What it is

A **paid Pilot app**: a supervised app-store binary exposing one capability,
`request-article`. A caller peer asks for a price (`quote`), pays a USDC
authorization through the Pilot **wallet** app, and on a verified payment
receives a generated article (`deliver`). The generator is **Ideon**
(`@telepat/ideon`), driven over its MCP HTTP transport via `ideon_write`.

- **App id:** `io.telepat.ideon-article`, `binary.runtime: "node"` (`app/manifest.json`).
- **Capability:** `request-article` (dataexchange JSON frames on overlay port 1001).
- **Role:** we are the **payee**; the recipient address comes from the sibling
  wallet (`wallet.evm.address`, or `wallet.address` for the mock path).
- **v1 scope:** delivery is gated on a verified authorization / mock receipt.
  On-chain settlement is out of scope for v1.

## Request protocol (peer ⇄ peer, dataexchange JSON frame on port 1001)

```
quote   : { op:"quote",   idea, style?, intent?, length? }
            -> { op:"quote",   contract }                       # PaymentContract
deliver : { op:"deliver", idea, contract, receipt }
            -> { op:"deliver", ok, article?, title?, slug?, error? }
```

Each request/reply is a single `DxType.JSON` frame whose payload is
`JSON.stringify(ArticleRequest | ArticleResponse)`. Exact shapes live in
`app/src/types.ts`.

## Build (inside Docker)

```sh
scripts/build-all.sh
```

builds four images — `pilot` (daemon + pilotctl + wallet + rendezvous), `libpilot`
(the sdk-node native FFI lib, built from source), `ideon` (Ideon MCP), and
`ideon-article` (this Node app) — plus `build/libpilot.so` and the two signed
bundles under `bundles/`. Pin a reproducible upstream with
`PILOT_REF=<sha> scripts/build-all.sh`. All compilation happens inside
`docker/*.Dockerfile`.

## Smoke test (isolated network, mock + dry-run)

`compose.smoke.yaml` is an isolated two-node network (`internal: true`, no egress)
that exercises the full money path with no external dependencies:

```sh
cp .env.example .env                               # IDEON_MCP_API_KEY=changeme is enough
scripts/build-all.sh
IDEON_MCP_API_KEY=changeme docker compose -f compose.smoke.yaml up -d
scripts/smoke-quote.sh                             # caller -> provider quote round-trip
scripts/smoke-deliver.sh                           # pay(mock) -> deliver + bogus/replay refusals
docker compose -f compose.smoke.yaml down -v
```

## Run in production

`compose.yaml` is the production topology: the provider daemon (supervising the
wallet and this app) plus the Ideon MCP sidecar, connected to the Pilot overlay.

```sh
scripts/build-all.sh
cp .env.example .env                               # then edit .env (see below)
docker compose up -d
docker compose logs -f provider-daemon
```

`.env`:

- `IDEON_MCP_API_KEY` — the Ideon MCP bearer key (required).
- `IDEON_DRY_RUN=false` + `OPENROUTER_API_KEY` (and `REPLICATE_API_TOKEN` if you
  raise `maxImages`) — for real article generation. With `IDEON_DRY_RUN=true` the
  node serves placeholder articles and needs no provider keys or egress.
- `PILOT_REGISTRY` / `PILOT_BEACON` — the Pilot overlay endpoints. Default to the
  real Pilot network so buyers can reach the node; set them to a self-hosted
  rendezvous for a private deployment.

## Build & sign a release (for catalogue submission)

```sh
scripts/sign-bundle.sh --key /path/to/publisher.key --out dist
```

builds `bin/main.js`, pins `binary.sha256` into `app/manifest.json`, signs the
manifest with the ed25519 publisher key (`pilotctl appstore sign`), and produces a
deterministic `dist/io.telepat.ideon-article-<version>.tar.gz` + `.sha256`. The
script prints the catalogue entry to hand to a Pilot maintainer:

```json
{ "id": "io.telepat.ideon-article", "version": "<app_version>",
  "description": "...", "bundle_url": "https://.../<tarball>",
  "bundle_sha256": "<sha>" }
```

The publisher private key is not stored in this repo (`/secure/` is gitignored).
Going live is maintainer-gated: a Pilot maintainer commits the catalogue entry.

## Layout

```
.
├── README.md            # this file
├── LICENSE              # Apache-2.0
├── compose.yaml         # production topology (provider + wallet + ideon + app)
├── compose.smoke.yaml   # isolated mock + dry-run regression test
├── .env.example         # environment template
├── docker/              # Dockerfiles (compiled inside Docker)
├── app/                 # the Node app (@telepat/ideon-article-app)
│   ├── manifest.json    # app-store manifest (sha256/sig pinned by sign-bundle.sh)
│   └── src/             # wrapper, capability server, wallet IPC, Ideon client, ...
└── scripts/             # build-all, sign-bundle, smoke-*, ...
```

## License

[Apache-2.0](./LICENSE).
