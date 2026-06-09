#!/usr/bin/env bash
#
# build-all.sh — build every image, the libpilot.so FFI, and the signed bundles
# for the io.telepat.ideon-article node. Run this, then `docker
# compose up -d`, then scripts/smoke-quote.sh.
#
# Nothing here RUNS any Pilot service on the host — every Go/Node build happens
# inside a Dockerfile; the only host actions are `docker build` and pure-crypto
# `pilotctl` subcommands in throwaway, network-less containers (assemble-bundles).
#
# Images produced:
#   pilot-protocol/pilot:dev          daemon(no_skillinject)+pilotctl+wallet+rendezvous (+node)
#   pilot-protocol/libpilot:dev       carrier for libpilot.so (sdk-node FFI native lib)
#   pilot-protocol/ideon:dev          ideon mcp serve-http (dry-run)
#   pilot-protocol/ideon-article:dev  our Node wrapper bundle (bin/main.js + node_modules)
# Artifacts:
#   build/libpilot.so                 extracted, bind-mounted by compose (PILOT_LIB_PATH)
#   bundles/<id>/                     signed, sha256-pinned app bundles (compose mounts ro)
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
export DOCKER_BUILDKIT=0   # this host has no buildx; Dockerfiles avoid BuildKit features
log() { printf '\033[1;32m[build-all]\033[0m %s\n' "$*"; }

log "1/5 pilot image (Go binaries, no_skillinject) — clones upstream, small context"
mkdir -p /tmp/pp-emptyctx
docker build -f docker/pilot.Dockerfile -t pilot-protocol/pilot:dev /tmp/pp-emptyctx

log "2/5 libpilot.so (CGO c-shared, no_skillinject, sibling-replace layout + patches)"
docker build -f docker/libpilot.Dockerfile -t pilot-protocol/libpilot:dev .
mkdir -p build
LCID="$(docker create pilot-protocol/libpilot:dev)"
docker cp "${LCID}:/libpilot.so" build/libpilot.so
docker rm -f "${LCID}" >/dev/null 2>&1 || true
log "    -> build/libpilot.so ($(stat -c%s build/libpilot.so 2>/dev/null || echo ?) bytes)"

log "3/5 ideon image (@telepat/ideon)"
docker build -f docker/ideon.Dockerfile -t pilot-protocol/ideon:dev docker/

log "4/5 ideon-article wrapper image (typecheck + tsup bundle)"
docker build -f docker/wrapper.Dockerfile -t pilot-protocol/ideon-article:dev .

log "5/5 assemble + sign bundles (wallet + ideon-article)"
bash scripts/assemble-bundles.sh

log "DONE. Next (smoke test):"
log "  IDEON_MCP_API_KEY=changeme docker compose -f compose.smoke.yaml up -d"
log "  scripts/smoke-quote.sh         # caller -> provider quote round-trip"
log "  scripts/smoke-deliver.sh       # pay(mock) -> deliver"
