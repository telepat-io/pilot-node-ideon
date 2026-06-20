# Ideon — free article generation for Pilot agents

`io.telepat.ideon-free` is a Pilot Protocol app-store node. Hand it an idea and it
writes you a finished, well-structured markdown article — title, slug, and body.
No payment, no keys to set up: install it on a Pilot daemon and an agent can start
generating right away.

It's a thin adapter in front of [Ideon](https://telepat.io), Telepat's writing
pipeline, which we host for you at `ideon-mcp.telepat.io`.

- **App id:** `io.telepat.ideon-free`
- **Install:** `pilotctl appstore install io.telepat.ideon-free`
- **Methods:** `ideon-free.generate`, `ideon-free.poll`, `ideon-free.help`
- **License:** Apache-2.0

## How a request works

A real article takes a few minutes to write — longer than a Pilot call stays open —
so generation is asynchronous. You ask for an article and get a job id back right
away, then poll that job until it's ready. Each call returns in well under a second.

```
ideon-free.generate { idea, style?, intent?, length? }  →  { jobId }

ideon-free.poll { jobId }
   → { status: "pending" }                                # still writing
   → { status: "done", ok: true, article, title, slug }   # here's your article
   → { status: "error", error }
```

`length` is either a named size (`small`, `medium`, `large`) or a word count —
whatever you pass goes straight through to Ideon.

## Install and use it

You'll need a running Pilot daemon. Install the app from the catalogue:

```sh
pilotctl appstore install io.telepat.ideon-free
```

Then ask for an article and poll until it's ready:

```sh
# start a job
pilotctl appstore call io.telepat.ideon-free ideon-free.generate \
  '{"idea": "why API design shapes developer experience", "length": "small"}'
# → {"jobId": "8c1f…"}

# poll every few seconds until status is "done"
pilotctl appstore call io.telepat.ideon-free ideon-free.poll \
  '{"jobId": "8c1f…"}'
# → {"status": "done", "ok": true, "title": "…", "slug": "…", "article": "# …"}
```

That's the whole flow. There's no API key to configure — the app talks to our
hosted backend out of the box.

## Built for agents

Agents don't read READMEs, so the app describes itself. Calling `ideon-free.help`
returns its method catalogue — names, summaries, parameters, and rough latency —
which is the discovery contract the Pilot store expects every app to expose:

```sh
pilotctl appstore call io.telepat.ideon-free ideon-free.help '{}'
```

Any agent that can install an app and read its `*.help` output has everything it
needs to drive `generate` and `poll` on its own. The same method list, with longer
descriptions, also lives in the store-card `metadata.json`.

## How it works

The app is a single self-contained file (`bin/main.mjs`) that the Pilot daemon's
supervisor runs for you and exposes over its local IPC socket. It's a thin client:
each request goes to our hosted Ideon backend over HTTPS, and the finished article
comes back the same way.

```
  agent
    │  pilotctl appstore call ideon-free.generate / .poll / .help
    ▼
  Pilot daemon  (supervises the app)
    └─ io.telepat.ideon-free
         │  ① POST /mcp    write the article   (ideon_write)
         │  ② GET  /files  read the finished markdown back
         ▼
  ideon-mcp.telepat.io   (Caddy + TLS)
     ├─ /mcp   → Ideon → model provider
     └─ /files → the generated article (auth-gated)
```

One wrinkle is worth knowing. Ideon writes the article to disk and hands back a
*path*, not the text. Earlier versions read that path off a shared volume, which
only worked when the app ran on the same machine as the backend. Now the backend
serves its output over an authenticated `/files` route and the app fetches the
markdown over HTTPS, so the app is fully portable — it runs on any Pilot daemon,
anywhere.

The bundle ships with a default backend token baked in, which is what makes
install-and-go work with no configuration. To point the app at your own Ideon
instance instead, set `IDEON_MCP_ENDPOINT` and `IDEON_MCP_API_KEY` in the daemon
environment and they override the defaults.

Under the hood it's plain Node — a `net.Server` on the supervisor socket speaking
the app-store's length-prefixed JSON framing. No native code, no worker threads,
no SDK.

## Build and test it yourself

Everything builds and runs in Docker; nothing Pilot touches the host.

```sh
scripts/build-all.sh    # base images + the native lib (slow first run, cached after)
scripts/build-free.sh   # the wrapper bundle, signed with a throwaway key for local use
```

There's a self-contained smoke test that needs no network and no model key. It
brings up a local daemon, a Caddy gateway that mirrors the public edge
(`/mcp` + `/files`), and Ideon in dry-run mode, then drives a real `generate → poll`
round-trip. The daemon deliberately shares no volume with Ideon, so the test
exercises the same portable path a remote install would:

```sh
IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d
scripts/smoke-free.sh
docker compose -f compose.free.yaml down -v
```

To generate real articles locally, add the egress override and a model key:

```sh
# @telepat/ideon reads TELEPAT_OPENROUTER_KEY (mapped from OPENROUTER_API_KEY in compose)
IDEON_DRY_RUN=false OPENROUTER_API_KEY=sk-... \
  docker compose -f compose.free.yaml -f compose.free.egress.yaml up -d
```

Choose the model with `IDEON_MODEL`; set `REPLICATE_API_TOKEN` if you want images.
For a submission-grade bundle signed with the real publisher key, use
`scripts/sign-bundle.sh --key <publisher.key>`.

## Safety

Everything runs in containers. The Pilot daemon is built `-tags no_skillinject`, so
the subsystem that would rewrite `~/.claude/CLAUDE.md` is compiled out, and no
service mounts the host home directory. [PROVENANCE.md](PROVENANCE.md) records what
every image is built from.

## A bit of history

This node started out as a paid `quote → pay → deliver` app backed by a USDC wallet.
That version still lives on the `paid` branch and the `v0.1.0` tag; `main` is the
free, generate-only node described here.

## Layout

```
.
├── compose.free.yaml          # self-contained smoke network (rendezvous + ideon-mcp + gateway + provider)
├── compose.free.egress.yaml   # override: enable egress for real generation
├── docker/
│   ├── pilot.Dockerfile       # daemon (no_skillinject) + pilotctl + rendezvous
│   ├── ideon.Dockerfile       # the Ideon MCP server image
│   ├── libpilot.Dockerfile    # the sdk-node native lib (build-all only)
│   ├── wrapper.Dockerfile     # this app's bundle (tsup → single bin/main.mjs)
│   └── gateway.Caddyfile      # local gateway (/mcp + /files), mirrors the public edge
├── app/
│   ├── manifest.json          # app-store manifest (sha256 + signature pinned at build)
│   └── src/                   # the wrapper: IPC dispatcher, Ideon client, types
└── scripts/                   # build-all, build-free, sign-bundle, smoke-free
```

## License

[Apache-2.0](./LICENSE).
