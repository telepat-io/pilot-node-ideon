# pilot-node-ideon — `io.telepat.ideon-free`

A **Pilot Protocol app-store node** that generates long-form articles on demand.
An agent sends one idea and gets back a finished markdown article — title, slug,
and body — with **no payment step**. It's a thin, portable adapter over Telepat's
[Ideon](https://telepat.io) writing pipeline.

- **App id:** `io.telepat.ideon-free` · **runtime:** `node` · **license:** Apache-2.0
- **Install:** `pilotctl appstore install io.telepat.ideon-free`
- **Methods:** `ideon-free.generate`, `ideon-free.poll`, `ideon-free.help`

## What it does

The installed app is a single self-contained binary (`bin/main.mjs`) that the
Pilot daemon's app-store **supervisor** runs locally and exposes over its IPC
socket. It is a **client**: it forwards each request to Telepat's hosted Ideon
MCP backend (`ideon-mcp.telepat.io`) and returns the finished article. There is
no wallet, no quote/pay/deliver — just generate and poll.

```
ideon-free.generate { idea, style?, intent?, length? }  ->  { jobId }
ideon-free.poll     { jobId }
        -> { status: "pending" }                                   # still generating
        -> { status: "done", ok: true, article, title, slug }      # finished markdown
        -> { status: "error", error }
ideon-free.help     {}  ->  { app, methods[…] }                    # local discovery, no backend call
```

Generation is **asynchronous** because a real article takes ~60–90 s — longer
than the daemon holds a synchronous call open. `generate` returns a `jobId`
immediately; `poll` that job until it's `done`. Each call is sub-second.

`length` is a named bucket (`small | medium | large`) or an integer word count —
forwarded to Ideon's `ideon_write` verbatim. An unknown method is rejected with
`method not found`; the legacy payment ops no longer exist.

## Architecture

The app talks **only** to the backend over HTTPS — it shares no filesystem with
it, so it runs on any Pilot daemon (portable by design).

```
  caller (agent)
     │  pilotctl appstore call ideon-free.generate / .poll / .help
     ▼
  provider-daemon  (pilot, no_skillinject)
     └─ supervises ▶ io.telepat.ideon-free  (bin/main.mjs)
                       │  ① POST /mcp   initialize → tools/call ideon_write   (Bearer)
                       │  ② GET  /files/.ideon/output/…/article.md            (Bearer)
                       ▼
              ideon-mcp.telepat.io   (Caddy, TLS)
                 ├─ /mcp   ─▶ ideon-mcp  (@telepat/ideon serve-http) ─▶ OpenRouter
                 └─ /files ─▶ generated article volume (read-only)
```

`ideon_write` returns a filesystem **path**, not the article body. Rather than
require a shared volume, the backend serves its output directory at an
authenticated `/files` route, and the app fetches the finished markdown back over
the same HTTPS origin (`①` generates, `②` reads it back). Both routes require the
`IDEON_MCP_API_KEY` bearer; the key is supplied by the operator at runtime (via
the daemon environment) and is **never** baked into the published bundle.

The wrapper is pure Node (`net.Server` on the supervisor `--socket`, length-prefixed
JSON-envelope IPC). No native FFI, no worker thread, no SDK — `bin/main.mjs` is a
single ESM file with no `node_modules`.

## Build (inside Docker)

```sh
scripts/build-all.sh    # base images (pilot:dev + ideon:dev) + build/libpilot.so — slow first run
scripts/build-free.sh   # wrapper image + signed bundle dir -> bundles-free/io.telepat.ideon-free
```

`build-all.sh` compiles the base artifacts from pinned upstream sources, all inside
`docker/*.Dockerfile` (slow the first time, cached afterwards — see
[docs/upgrading-pins.md](docs/upgrading-pins.md)). `build-free.sh` then builds the
light wrapper image (`npm ci` + typecheck + tsup), stages the minimal bundle
(`manifest.json` + `bin/main.mjs`), pins `binary.sha256`, and signs it with a
throwaway ed25519 key for local testing. For a **submission** bundle signed with the
real publisher key, use `scripts/sign-bundle.sh --key <publisher.key>` (writes
`dist/io.telepat.ideon-free-<version>.tar.gz`).

## Smoke test (isolated network, dry-run)

```sh
scripts/build-all.sh
scripts/build-free.sh
IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d
scripts/smoke-free.sh
docker compose -f compose.free.yaml down -v
```

`compose.free.yaml` is a self-contained network (`internal: true`, no egress): the
provider daemon supervises the app, a **gateway** (Caddy) fronts `ideon-mcp`
exactly like the public edge (`/mcp` + `/files`), and Ideon runs **dry-run** by
default — so the full `generate → poll` round-trip runs offline with no LLM key.
`smoke-free.sh` calls the app via `pilotctl appstore call`, drives
`generate → poll` until the article comes back, and asserts an unknown method is
rejected. Because the daemon shares **no** volume with Ideon, the smoke exercises
the exact portable path a remote install uses.

| Service | Image | Role |
|---------|-------|------|
| `provider-daemon` | pilot | our node; supervises `io.telepat.ideon-free` |
| `ideon-mcp` | ideon | the Ideon generator (`@telepat/ideon` HTTP MCP; dry-run by default) |
| `gateway` | caddy | fronts ideon-mcp: `/mcp` (generate) + `/files` (article read-back) |
| `rendezvous` | pilot | local overlay control plane (demo only) |

## Real generation

Ideon defaults to **dry-run** (placeholder articles, no egress, no key). The
public backend at `ideon-mcp.telepat.io` is configured for real generation
(`IDEON_DRY_RUN=false` + an OpenRouter key); an installed app reaches it by
presenting the `IDEON_MCP_API_KEY` bearer. To run real generation locally, add the
egress override and a provider key:

```sh
# @telepat/ideon reads TELEPAT_OPENROUTER_KEY (mapped from OPENROUTER_API_KEY in compose).
IDEON_DRY_RUN=false OPENROUTER_API_KEY=sk-... \
  docker compose -f compose.free.yaml -f compose.free.egress.yaml up -d
```

`compose.free.egress.yaml` flips the network to `internal: false` so `ideon-mcp`
can reach OpenRouter. Select the model with `IDEON_MODEL`; set
`REPLICATE_API_TOKEN` for image generation.

## Safety posture

Containers only. The Pilot daemon is built `-tags no_skillinject` (the
`~/.claude/CLAUDE.md` hijack is compiled out); no service mounts the host `$HOME`
or `~/.claude`. See [PROVENANCE.md](PROVENANCE.md) and the security overview.

## History

The earlier paid variant of this node (`io.telepat.ideon-article` — a
`quote → pay → deliver` flow against a USDC wallet) is preserved on the **`paid`**
branch and the **`v0.1.0`** tag. `main` ships the free generate-only node described
here.

## Layout

```
.
├── README.md                  # this file
├── LICENSE                    # Apache-2.0
├── compose.free.yaml          # self-contained smoke network (rendezvous + ideon-mcp + gateway + provider)
├── compose.free.egress.yaml   # override: enable egress for real generation
├── .env.example               # environment template
├── docker/
│   ├── pilot.Dockerfile       # daemon(no_skillinject)+pilotctl+rendezvous
│   ├── ideon.Dockerfile       # the Ideon MCP server image
│   ├── libpilot.Dockerfile    # the sdk-node FFI native lib (build-all only)
│   ├── wrapper.Dockerfile     # this app's bundle (tsup → single bin/main.mjs)
│   ├── gateway.Caddyfile      # local smoke gateway (/mcp + /files), mirrors the public edge
│   └── upstream-pins.txt      # pinned SHAs for the upstream sibling repos
├── app/
│   ├── manifest.json          # app-store manifest (sha256/sig pinned at build)
│   └── src/                   # wrapper (IPC dispatcher), Ideon MCP client, types, …
└── scripts/                   # build-all, build-free, sign-bundle, smoke-free, provider-entrypoint.free
```

## License

[Apache-2.0](./LICENSE).
