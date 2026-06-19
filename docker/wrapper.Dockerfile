#
# wrapper.Dockerfile — builds the io.telepat.ideon-free app bundle.
#
# WHAT THIS PRODUCES
#   A minimal /app tree containing exactly the catalogue bundle:
#     /app/manifest.json    the app-store manifest
#     /app/bin/main.mjs     the bundled wrapper entrypoint (tsup ESM, .mjs)
#
#   The app has NO runtime dependencies: the sdk-node SDK (pilotprotocol) was
#   dropped — nothing imports it — so bin/main.mjs is a SINGLE self-contained
#   file. `.mjs` is ESM regardless of any package.json, so the official
#   catalogue install (which copies ONLY manifest.json + binary.path) yields a
#   working app. binary.path in manifest.json is `bin/main.mjs`.
#
# INTEGRATION
#   The app binary is NOT run as its own container/service. The Pilot app-store
#   supervisor (org/app-store/plugin/appstore/supervisor.go:752-790) execs it as
#   a CHILD PROCESS inside the provider-daemon container:
#       node /app/bin/main.mjs --addr ... --db ... --socket ... \
#                              --identity ... --manifest ... --cap-state ...
#   This image is a BUILD-ARTIFACT carrier that sign-bundle.sh stages from.
#
# Build context MUST be the repo root (so `app/` is reachable):
#   docker build -f docker/wrapper.Dockerfile -t pilot-protocol/ideon-free:release .
#

# ── Stage 1: build — install deps, typecheck, bundle with tsup ───────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy manifests first for layer-cached dependency install.
COPY app/package.json app/package-lock.json app/tsconfig.json app/tsup.config.ts ./

# Full install (devDeps: typescript, tsup, tsx, @types/node) — `npm ci` against
# the committed lockfile so the build (and the release tarball sha) is
# reproducible. There are no runtime dependencies.
RUN npm ci --no-audit --no-fund

# Bring in the TypeScript sources and the manifest.
COPY app/src ./src
COPY app/manifest.json ./manifest.json

# Typecheck (tsc --noEmit) then bundle src/main.ts -> bin/main.mjs (ESM, node20).
RUN npm run typecheck \
 && npm run build \
 && test -f bin/main.mjs   # fail the build early if the entrypoint is missing

# ── Stage 2: bundle — the minimal {manifest.json, bin/main.mjs} artifact ─────
# Final image is the catalogue bundle; it does NOT run on its own (the supervisor
# execs bin/main.mjs inside the provider-daemon container — see header).
FROM node:22-bookworm-slim AS bundle
WORKDIR /app
COPY --from=build  /app/bin/main.mjs   ./bin/main.mjs
COPY --from=build  /app/manifest.json  ./manifest.json

LABEL org.telepat.ideon-free.bundle="/app" \
      org.telepat.ideon-free.entrypoint="/app/bin/main.mjs" \
      org.telepat.ideon-free.integration="catalogue install copies manifest.json + bin/main.mjs; supervisor execs 'node /app/bin/main.mjs'"

# Build-artifact carrier, not a service. CMD is never used in the supervised
# topology (the supervisor provides argv).
CMD ["node", "-e", "console.error('ideon-free bundle: not a standalone service. The app-store supervisor execs node bin/main.mjs with --addr/--db/--socket/--identity/--manifest/--cap-state.'); process.exit(1)"]
