# pilot-node-ideon — `io.telepat.ideon-article`

A containerized **Pilot Protocol app-store node** that sells articles:
`request-article → pay (USDC authorization) → deliver`, by wrapping Ideon's
`ideon_write` MCP tool.

The code-backed wire/API contract this app codes against (with `file:line`
citations into the public upstream) is [`INTERFACES.md`](./INTERFACES.md); what
each image is built from and why the daemon carries a special build tag is
[`PROVENANCE.md`](./PROVENANCE.md).

## What it is

A **paid Pilot app**: a supervised app-store binary exposing one capability,
`request-article`. A caller peer asks for a price (`quote`), pays a USDC
authorization through the Pilot **wallet** app, and on a verified payment
receives a generated article (`deliver`). The generator is **Ideon**
(`@telepat/ideon`), driven over its MCP HTTP transport via `ideon_write`.

- **App id:** `io.telepat.ideon-article`, `binary.runtime: "node"`
  (`app/manifest.json`).
- **Capability:** `request-article` (dataexchange JSON frames on overlay port 1001).
- **Role:** we are the **payee**. We hold no `key.sign` grant; the recipient
  address comes from the sibling wallet (`wallet.evm.address`, or `wallet.address`
  for the mock path).
- **v1 scope:** delivery is gated on a *verified authorization / mock receipt*.
  **On-chain settlement is out of scope** — the Pilot wallet is calldata-only;
  broadcasting `transferWithAuthorization` is the operator's responsibility out of
  band (see *Verified vs deferred*).

## Two audiences

This repo serves two purposes from one self-contained tree:

1. **Submit to the Pilot catalogue.** Build the bundle, sign the manifest, produce
   the tarball + sha256, and hand the catalogue entry to a Pilot maintainer — see
   **Build & sign a release**.
2. **Run the node in production.** Clone, `cp .env.example .env`, fill it in, and
   `docker compose up -d` — see **Run in production**.

## Request protocol (peer ⇄ peer, dataexchange JSON frame on port 1001)

```
quote   : { op:"quote",   idea, style?, intent?, length? }
            -> { op:"quote",   contract }                       # PaymentContract
deliver : { op:"deliver", idea, contract, receipt }
            -> { op:"deliver", ok, article?, title?, slug?, error? }
```

Each request/reply is a single `DxType.JSON` frame whose payload is
`JSON.stringify(ArticleRequest | ArticleResponse)`. Exact shapes live in
`app/src/types.ts`; the wallet/contract/receipt shapes and the Ideon call are in
`INTERFACES.md`.

## Hard safety (non-negotiable)

- **`no_skillinject` build tag is REQUIRED.** The Pilot daemon is compiled
  `-tags no_skillinject` inside `docker/pilot.Dockerfile`. Without it, the
  `skillinject` subsystem rewrites the operator's `~/.claude/CLAUDE.md` on a
  ~15-minute timer; the tag compiles that code path out. (Details in
  `PROVENANCE.md`.)
- **No host `~/.claude` / `$HOME` mount, anywhere.** No service in either compose
  binds the host home. The daemon runs with a container-local `HOME=/home/pilot`;
  Ideon with `IDEON_HOME=/data/ideon`.
- **Compiled in Docker, not on the host.** All Pilot/Go/Ideon builds happen inside
  `docker/*.Dockerfile` (each clones the public upstream at `PILOT_REF`). The only
  host actions are `docker build` / `docker compose`.

## Build (inside Docker only)

```sh
scripts/build-all.sh
```

builds four images — `pilot` (daemon `-tags no_skillinject` + pilotctl + wallet +
rendezvous), `libpilot` (the sdk-node native FFI lib, built from source), `ideon`
(Ideon MCP), and `ideon-article` (this Node app) — plus `build/libpilot.so` and
the two signed bundles under `bundles/`. Pin a reproducible upstream with
`PILOT_REF=<sha> scripts/build-all.sh` (passed through to the Dockerfiles).

## Smoke test (air-gapped, mock + dry-run)

`compose.smoke.yaml` is a PRIVATE, `internal: true` two-node network (no egress).
It proves the full money path without touching the real Pilot network or any
external provider:

```sh
cp .env.example .env                               # IDEON_MCP_API_KEY=changeme is enough
scripts/build-all.sh
scripts/assert-host-clean.sh --baseline            # snapshot host ~/.claude BEFORE
IDEON_MCP_API_KEY=changeme docker compose -f compose.smoke.yaml up -d
scripts/smoke-quote.sh                             # caller → provider quote round-trip
scripts/smoke-deliver.sh                           # pay(mock) → deliver + bogus/replay refusals
scripts/assert-host-clean.sh --after               # prove ~/.claude/CLAUDE.md byte-identical
docker compose -f compose.smoke.yaml down -v
```

## Run in production

`compose.yaml` is the production topology: the provider daemon (supervising the
wallet and this app) plus the Ideon MCP sidecar, connected to the Pilot overlay.
It is NOT air-gapped — it needs egress for real generation and to reach the Pilot
network.

```sh
scripts/build-all.sh                               # produce images + bundles + libpilot.so
cp .env.example .env                               # then edit .env (see below)
docker compose up -d
docker compose logs -f provider-daemon
```

Fill in `.env`:

- `IDEON_MCP_API_KEY` — the Ideon MCP bearer key (required).
- `IDEON_DRY_RUN=false` + `OPENROUTER_API_KEY` (and `REPLICATE_API_TOKEN` if you
  raise `maxImages`) — for real article generation. With `IDEON_DRY_RUN=true` the
  node serves placeholder articles and needs no provider keys or egress.
- `PILOT_REGISTRY` / `PILOT_BEACON` — the Pilot overlay endpoints. Default to the
  real Pilot network so buyers can reach the node; set them to a self-hosted
  rendezvous for a private deployment. **Confirm the current Pilot registry/beacon
  with the Pilot team.**

**Production hardening still on the operator:** the shared `provider-entrypoint.sh`
runs the daemon with `-trust-auto-approve` (fine for the smoke test; review per-peer
trust for a real deployment), and real **on-chain settlement** of the USDC
authorization is out of band (the Pilot wallet does not broadcast). See
*Verified vs deferred*.

## Build & sign a release (for catalogue submission)

```sh
scripts/sign-bundle.sh --key ./secure/publisher.key --out dist
```

This builds `bin/main.js`, pins `binary.sha256` into `app/manifest.json`, signs the
manifest with the ed25519 publisher key (`pilotctl appstore sign`), and produces a
deterministic `dist/io.telepat.ideon-article-<version>.tar.gz` + `.sha256`. The
script prints the catalogue entry to hand to a Pilot maintainer:

```json
{ "id": "io.telepat.ideon-article", "version": "<app_version>",
  "description": "...", "bundle_url": "https://.../<tarball>",
  "bundle_sha256": "<sha>" }
```

> The publisher private key (`secure/publisher.key`) is **gitignored** and must
> never be committed. Going live is maintainer-gated: a Pilot maintainer commits
> the catalogue entry; nothing here auto-publishes.

## Verified vs deferred

**Verified** (proven by the smoke tests on the air-gapped network): app-store
install + supervise lifecycle; peer `quote → deliver` over dataexchange; app ⇄
wallet IPC; mock payment gating delivery on a verified receipt; dry-run generation;
host-clean (`~/.claude/CLAUDE.md` never written).

**Deferred** (out of v1 scope, by design): **on-chain settlement** (the Pilot
wallet is calldata-only — moving USDC needs our own relayer); the **real EVM/x402
payment path** (run the wallet with EVM enabled, pin a wallet ref that has it);
**catalogue go-live**, which is maintainer-gated.

## Layout

```
.
├── README.md            # this file
├── LICENSE              # Apache-2.0
├── INTERFACES.md        # code-backed upstream API reference (file:line cites)
├── PROVENANCE.md        # what each image is built from + build policy
├── compose.yaml         # PRODUCTION topology (provider + wallet + ideon + app)
├── compose.smoke.yaml   # air-gapped mock + dry-run regression test
├── .env.example         # production env template
├── docker/              # Dockerfiles (compiled inside; never run on host)
├── app/                 # the Node app (@telepat/ideon-article-app)
│   ├── manifest.json    # app-store manifest (sha256/sig pinned by sign-bundle.sh)
│   └── src/             # wrapper, capability server, wallet IPC, Ideon client, …
└── scripts/             # build-all, sign-bundle, smoke-*, assert-host-clean, …
```

## License

[Apache-2.0](./LICENSE).
