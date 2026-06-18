# pilot-node-ideon — `io.telepat.ideon-free`

A containerized **Pilot Protocol app-store node** that generates articles on
demand by wrapping Ideon's `ideon_write` MCP tool. A caller sends one idea over
the Pilot overlay and gets back a finished markdown article.

## What it does

A supervised app-store binary exposing a single dataexchange capability on
overlay port 1001. The wrapper drives **Ideon** (`@telepat/ideon`) over its
**HTTP MCP** transport (`ideon_write`), run as a sidecar container.

- **App id:** `io.telepat.ideon-free`, `binary.runtime: "node"` (`app/manifest.json`).
- **Capability:** dataexchange JSON frames on overlay port 1001.
- **Generator:** Ideon `ideon_write`, reached over HTTP MCP at `ideon-mcp`.
- **Role:** provider — the capability is served directly; no wallet, no quote/pay/deliver.

> The earlier variant of this node (`io.telepat.ideon-article` — a `quote → pay →
> deliver` flow against a USDC wallet) is preserved on the **`paid`** branch and
> the `v0.1.0` tag. `main` ships the generate-only node described here. Some
> paid-era files still sit alongside the free ones on `main` (`compose.yaml`,
> `scripts/build-all.sh`, `scripts/smoke-{quote,deliver}.sh`, `sign-bundle.sh`,
> the `.github` workflows) and are pending cleanup — use the `*-free` / `*.free.*`
> variants below.

## Request protocol (async, peer ⇄ peer, dataexchange JSON frame on port 1001)

Generation takes ~60–90 s — longer than the Pilot overlay holds an idle
dataexchange connection (~60–70 s). So the protocol is **asynchronous**: a
`generate` returns a `jobId` immediately, and the caller `poll`s that job until
the article is ready. Each round-trip is sub-second.

```
generate : { op:"generate", idea, style?, intent?, length? }
            -> { op:"accepted", jobId }
poll     : { op:"poll", jobId }
            -> { op:"result", status:"pending" }                          # still generating
            -> { op:"result", status:"done", ok:true, article, title, slug }
            -> { op:"result", status:"error", error }
```

`length` is a named bucket (`small|medium|large`) or an integer word count — both
forwarded to `ideon_write` verbatim. Each request/reply is a single
`DxType.JSON` frame; exact shapes live in `app/src/types.ts`. A malformed or
legacy op (e.g. `quote`) is rejected with `{ op:"error", error:"unknown op …" }`.

## Architecture

```
caller ──overlay:1001──▶ provider-daemon (pilot, no_skillinject, -no-dataexchange)
                          └─ app-store supervisor spawns ▶ io.telepat.ideon-free (bin/main.js)
                                                            └─ HTTP MCP ▶ ideon-mcp (ideon mcp serve-http)
```

The blocking sdk-node FFI accept loop runs on a worker thread
(`pilotServerWorker`); the main thread does the async MCP work. `ideon_write`
returns a filesystem **path**, not the article body, so `ideon-mcp`'s output
root is a volume shared into `provider-daemon` at the same absolute path,
letting the wrapper read the generated markdown back.

## Build (inside Docker)

```sh
scripts/build-all.sh    # base images (pilot:dev + ideon:dev) + build/libpilot.so — slow first run
scripts/build-free.sh   # free wrapper image + signed bundle -> bundles-free/io.telepat.ideon-free
```

`build-all.sh` compiles the base artifacts from pinned upstream sources, all
inside `docker/*.Dockerfile` (slow the first time; cached afterwards — see
[docs/upgrading-pins.md](docs/upgrading-pins.md)). `build-free.sh` then builds
just the light wrapper image (npm ci + typecheck + tsup), stages the complete
`/app` tree (`bin/main.js` + `bin/pilotServerWorker.js` + `manifest.json` +
prod `node_modules`), pins `binary.sha256`, and signs the bundle with a
throwaway ed25519 key — pure local crypto in a network-less container (the smoke
daemon runs `-trust-auto-approve`, so any publisher is accepted).

## Containers

| Service | Image | Role |
|---------|-------|------|
| `provider-daemon` | pilot | our node; supervises `io.telepat.ideon-free` |
| `ideon-mcp` | ideon | the Ideon generator (HTTP MCP; dry-run by default) |
| `rendezvous` | pilot | local overlay control plane (demo/smoke only) |
| `caller-daemon` | pilot | a second node playing the caller (demo/smoke only) |

`compose.free.yaml` is a self-contained network (`internal: true`, no egress):
the daemons talk only to the local rendezvous and Ideon runs **dry-run** by
default, so the full `generate → poll` round-trip runs offline with no LLM key.

## Smoke test (isolated network, dry-run)

```sh
scripts/build-all.sh
scripts/build-free.sh
IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d
scripts/smoke-free.sh
docker compose -f compose.free.yaml down -v
```

`smoke-free.sh` dials the provider over the overlay, runs the async
`generate → poll` until a (placeholder) article comes back, asserts the Ideon
output dir grew (proving the shared-volume readback worked), and adversarially
checks that a legacy `quote` is rejected — i.e. the payment leg is gone.

## Real generation

Ideon defaults to **dry-run** (placeholder articles, no egress, no key). For
real generation, add the egress override and supply a provider key:

```sh
# @telepat/ideon reads TELEPAT_OPENROUTER_KEY (mapped from OPENROUTER_API_KEY in compose)
IDEON_DRY_RUN=false OPENROUTER_API_KEY=sk-... \
  docker compose -f compose.free.yaml -f compose.free.egress.yaml up -d
```

`compose.free.egress.yaml` flips `pilot-net` to `internal: false` so `ideon-mcp`
can reach OpenRouter. Select the model with `IDEON_MODEL` (default
`deepseek/deepseek-v4-pro`); set `REPLICATE_API_TOKEN` for image generation.

## Layout

```
.
├── README.md            # this file
├── LICENSE              # Apache-2.0
├── compose.free.yaml         # self-contained local network (rendezvous + provider + ideon-mcp + caller)
├── compose.free.egress.yaml  # override: enable egress for real generation
├── .env.example         # environment template
├── docker/              # Dockerfiles (compiled inside Docker; upstream pinned)
│   ├── pilot.Dockerfile     # daemon(no_skillinject)+pilotctl+wallet+rendezvous
│   ├── ideon.Dockerfile     # the Ideon MCP server image
│   ├── libpilot.Dockerfile  # the sdk-node FFI native lib (CGO c-shared)
│   ├── wrapper.Dockerfile   # this app's bundle (tsup + prod node_modules)
│   └── upstream-pins.txt    # pinned SHAs for the upstream sibling repos
├── app/                 # the Node app
│   ├── manifest.json    # app-store manifest (sha256/sig pinned by build-free.sh)
│   └── src/             # wrapper, capability server, Ideon MCP client, types, ...
└── scripts/             # build-all, build-free, provider-entrypoint.free, smoke-free, dx-client
```

## License

[Apache-2.0](./LICENSE).
