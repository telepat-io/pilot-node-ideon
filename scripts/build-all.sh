#!/usr/bin/env bash
#
# build-all.sh — build the BASE images + the libpilot.so FFI the free node needs.
# Run this once, then scripts/build-free.sh, then the compose.free.yaml smoke.
#
# Nothing here RUNS any Pilot service on the host — every Go/Node build happens
# inside a Dockerfile; the only host actions are `docker build`.
#
# Images produced:
#   pilot-protocol/pilot:dev      daemon(no_skillinject)+pilotctl+rendezvous (+node)
#   pilot-protocol/libpilot:dev   carrier for libpilot.so (sdk-node FFI native lib)
#   pilot-protocol/ideon:dev      ideon mcp serve-http (the article generator)
# Artifacts:
#   build/libpilot.so             extracted, bind-mounted by compose.free.yaml
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
export DOCKER_BUILDKIT=0   # this host has no buildx; Dockerfiles avoid BuildKit features
log() { printf '\033[1;32m[build-all]\033[0m %s\n' "$*"; }

log "1/3 pilot image (Go binaries, no_skillinject) — clones upstream, small context"
mkdir -p /tmp/pp-emptyctx
docker build -f docker/pilot.Dockerfile -t pilot-protocol/pilot:dev /tmp/pp-emptyctx

log "2/3 libpilot.so (CGO c-shared, no_skillinject, sibling-replace layout + patches)"
docker build -f docker/libpilot.Dockerfile -t pilot-protocol/libpilot:dev .
mkdir -p build
LCID="$(docker create pilot-protocol/libpilot:dev)"
docker cp "${LCID}:/libpilot.so" build/libpilot.so
docker rm -f "${LCID}" >/dev/null 2>&1 || true
log "    -> build/libpilot.so ($(stat -c%s build/libpilot.so 2>/dev/null || echo ?) bytes)"

log "3/3 ideon image (@telepat/ideon)"
docker build -f docker/ideon.Dockerfile -t pilot-protocol/ideon:dev docker/

log "DONE. Next:"
log "  scripts/build-free.sh                                      # wrapper image + signed bundle"
log "  IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d"
log "  scripts/smoke-free.sh                                      # generate -> poll over IPC"
