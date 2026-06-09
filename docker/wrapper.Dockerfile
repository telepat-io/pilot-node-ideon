#
# wrapper.Dockerfile — builds the io.telepat.ideon-article Node app bundle.
#
# WHAT THIS PRODUCES
#   A self-contained app directory at /app containing:
#     /app/bin/main.js      the bundled wrapper entrypoint (tsup ESM output)
#     /app/node_modules     RUNTIME deps only (pilotprotocol sdk-node + its FFI)
#     /app/manifest.json    the app-store manifest
#     /app/package.json     (kept; declares "type":"module" so bin/main.js loads)
#
#   NB: the app's package.json `build` script emits `bin/main.js` (tsup), and the
#   app `manifest.json` `binary.path` is `bin/main.js`. The task brief calls this
#   "wrapper.js"; the concrete, manifest-pinned name is `bin/main.js`. They are
#   the same artifact — the supervisor execs `node <InstallRoot>/<app_id>/bin/main.js`.
#
# ─────────────────────────────────────────────────────────────────────────────
# INTEGRATION ASSUMPTION (read before wiring compose) — IMPORTANT
# ─────────────────────────────────────────────────────────────────────────────
# The app binary is NOT run as its own container/service. The Pilot app-store
# supervisor (org/app-store/plugin/appstore/supervisor.go:752-790) execs it as a
# CHILD PROCESS *inside the provider-daemon container*, with:
#       node /app/bin/main.js --addr ... --db ... --socket ... \
#                             --identity ... --manifest ... --cap-state ...
# (runtime "node" from our manifest.json; the supervisor spawns `node <path>`).
#
# Therefore this image's job is to BUILD a self-contained bundle that the
# PROVIDER-DAEMON image can carry. Two supported integration paths — the compose
# author picks one; both rely on this image producing a clean /app tree:
#
#   (A) SHARED BUILD STAGE (preferred, no host bind):
#       The provider-daemon Dockerfile does:
#           COPY --from=ideon-article-wrapper /app /opt/ideon-article-app
#       (referencing THIS image by build stage / `FROM <tag> AS wrapper`), then
#       installs that dir as an app bundle so the supervisor can find + exec it.
#       The provider image must also ship a Node runtime (>=20) on PATH because
#       the supervisor runs `node bin/main.js`. node:22 base or copying the node
#       binary both work; simplest is to base the provider image's final stage on
#       node:22-bookworm-slim too, or `COPY --from=node:22-bookworm-slim`.
#
#   (B) BIND MOUNT the built bundle:
#       `docker build -f docker/wrapper.Dockerfile -t ideon-article-wrapper .`
#       then in compose bind a volume from this image's /app into the provider
#       container at the app-store InstallRoot (<home>/.pilot/apps/io.telepat.ideon-article).
#       Heavier to wire (needs a sidecar to export /app); (A) is cleaner.
#
# The bundle is fully self-contained: `npm ci --omit=dev` leaves only runtime
# deps (pilotprotocol + its prebuilt FFI binding). No native toolchain is needed
# at app run time, and the app writes ONLY delivered.jsonl (no sqlite/native db).
#
# Build context MUST be the repo root (so `app/` is reachable):
#   docker build -f docker/wrapper.Dockerfile -t ideon-article-wrapper .
#
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build — install ALL deps, typecheck, bundle with tsup ───────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy manifests first for layer-cached dependency install.
COPY app/package.json app/package-lock.json app/tsconfig.json app/tsup.config.ts ./

# Full install (incl. devDeps: typescript, tsup, tsx, @types/node) — `npm ci`
# against the committed lockfile so the dependency tree (and therefore the
# release tarball sha) is reproducible. `pilotprotocol` is the sdk-node package
# (org/sdk-node/package.json:2), pinned to an exact version in package.json;
# it ships a prebuilt FFI binding (PilotConnect), so no compiler is required.
# If a future sdk-node release needs node-gyp, add build-essential + python3 here.
RUN npm ci --no-audit --no-fund

# Bring in the TypeScript sources and the manifest.
COPY app/src ./src
COPY app/manifest.json ./manifest.json

# Typecheck (tsc --noEmit) then bundle src/main.ts -> bin/main.js (ESM, node20).
# Matches app/package.json scripts: "typecheck" and "build".
RUN npm run typecheck \
 && npm run build \
 && test -f bin/main.js   # fail the build early if the entrypoint is missing

# ── Stage 2: prune — runtime-only node_modules for a slim, portable bundle ───
# A fresh dir with prod deps only, so the exported /app tree is minimal.
FROM node:22-bookworm-slim AS prune
WORKDIR /app
COPY app/package.json ./package.json
COPY app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund

# ── Stage 3: bundle — the artifact the provider-daemon image copies ──────────
# Final image is the self-contained app tree; it does NOT run on its own (the
# supervisor execs bin/main.js inside the provider-daemon container — see header).
FROM node:22-bookworm-slim AS bundle
WORKDIR /app

# Built entrypoint + runtime deps + manifest + package.json (for "type":"module").
COPY --from=build  /app/bin            ./bin
COPY --from=build  /app/manifest.json  ./manifest.json
COPY --from=build  /app/package.json   ./package.json
COPY --from=prune  /app/node_modules   ./node_modules

# Sanity marker for the compose author: the bundle is at /app, entry at /app/bin/main.js.
LABEL org.telepat.ideon-article.bundle="/app" \
      org.telepat.ideon-article.entrypoint="/app/bin/main.js" \
      org.telepat.ideon-article.integration="copy /app into provider-daemon image; supervisor execs 'node /app/bin/main.js'"

# This image is a BUILD ARTIFACT carrier, not a service. Its CMD is never used in
# the supervised topology (the supervisor provides argv). Provide a no-op default
# that prints the integration contract if someone runs the image directly.
CMD ["node", "-e", "console.error('ideon-article bundle: not a standalone service. Copy /app into the provider-daemon image; the app-store supervisor execs `node /app/bin/main.js` with --addr/--db/--socket/--identity/--manifest/--cap-state. See docker/wrapper.Dockerfile header.'); process.exit(1)"]
