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

builds the images and signed bundles (see **Containers** below) plus
`build/libpilot.so`, all inside `docker/*.Dockerfile`. Upstream refs are pinned to
exact commit SHAs by default (see `docs/upgrading-pins.md`); override for
development with `PILOT_REF=<ref> scripts/build-all.sh`.

## Containers (dev vs prod)

`build-all.sh` produces four images: **pilot** (one image carrying the daemon,
`pilotctl`, the wallet, and rendezvous binaries), **ideon** (the Ideon MCP server),
**ideon-article** (this app's bundle), and **libpilot** (a build-time carrier for
`libpilot.so`). Not all are *run*, and the wallet and this app are **not** their own
containers — the provider daemon's supervisor spawns them as child processes inside
`provider-daemon`:

| Service | Image | Dev (`compose.smoke.yaml`) | Prod (`compose.yaml`) |
|---------|-------|:--:|:--:|
| `provider-daemon` — our node; supervises `io.pilot.wallet` + `io.telepat.ideon-article` | pilot | ✓ | ✓ |
| `ideon-mcp` — the generator (dry-run in dev) | ideon | ✓ | ✓ |
| `rendezvous` — local overlay control plane | pilot | ✓ | — |
| `caller-daemon` — a second node playing the buyer | pilot | ✓ | — |
| `caller-wallet` — mock payer wallet | pilot | ✓ | — |

**Prod = two containers** (`provider-daemon` + `ideon-mcp`): the node joins Pilot's
real overlay via `PILOT_REGISTRY`/`PILOT_BEACON`, so we don't run rendezvous
ourselves. **Dev adds** a local `rendezvous` plus a buyer side (`caller-daemon` +
`caller-wallet`) on an isolated network, so the full `quote → pay → deliver`
round-trip runs offline.

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
scripts/sign-bundle.sh --key /path/to/publisher.key --out dist \
    [--bundle-url-base https://github.com/telepat-io/pilot-node-ideon/releases/download/<tag>]
```

builds the bundle **from the wrapper image** (npm ci + typecheck + tsup, all in
Docker), stages its complete `/app` tree (`bin/main.js` + `bin/pilotServerWorker.js`
+ `manifest.json` + `package.json` + prod-only `node_modules`), pins
`binary.sha256` into the **staged** manifest, signs it with the ed25519 publisher
key (`pilotctl appstore sign`), and produces a reproducible
`dist/io.telepat.ideon-article-<version>.tar.gz` + `.sha256` +
`catalogue-entry.json` (the same commit re-signs to the same tarball sha —
`app/package-lock.json` pins the dependency tree).

**Key custody + verification model.** The publisher private key is never stored
on GitHub — not in this repo (`/secure/` is gitignored) and not as a CI secret.
Releases are signed locally by the maintainer and published as GitHub Releases;
the [`verify-release` workflow](.github/workflows/verify-release.yml) then
independently re-checks every published release from the public artifacts alone:
tarball sha256, manifest id/version vs tag, the publisher identity against the
pinned [`PUBLISHER.pub`](PUBLISHER.pub), the binary sha256 pin, and the embedded
ed25519 signature (via `pilotctl` built from the pinned upstream ref).

All upstream refs (Pilot monorepo, libpilot siblings, wallet/rendezvous) are
pinned to exact SHAs/versions — see [docs/upgrading-pins.md](docs/upgrading-pins.md)
for the inventory and the bump procedure.

Going live is maintainer-gated: a Pilot maintainer commits the catalogue entry
(`dist/catalogue-entry.json`) to the upstream catalogue.

## Layout

```
.
├── README.md            # this file
├── LICENSE              # Apache-2.0
├── PUBLISHER.pub        # pinned publisher pubkey (CI verifies releases against it)
├── compose.yaml         # production topology (provider + wallet + ideon + app)
├── compose.smoke.yaml   # isolated mock + dry-run regression test
├── .env.example         # environment template
├── .github/workflows/   # ci (build gate) + verify-release (release integrity)
├── docs/                # upgrading-pins.md (pin inventory + bump procedure)
├── docker/              # Dockerfiles (compiled inside Docker; upstream pinned)
├── app/                 # the Node app (@telepat/ideon-article-app)
│   ├── manifest.json    # app-store manifest (sha256/sig pinned by sign-bundle.sh)
│   └── src/             # wrapper, capability server, wallet IPC, Ideon client, ...
└── scripts/             # build-all, sign-bundle, smoke-*, ...
```

## License

[Apache-2.0](./LICENSE).
