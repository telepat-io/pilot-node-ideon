#!/usr/bin/env bash
#
# build-free.sh — build the io.telepat.ideon-free Node wrapper image and assemble
# the single SIGNED app bundle into ./bundles-free/. Reuses the prebuilt
# pilot-protocol/pilot:dev (pilotctl) and pilot-protocol/ideon:dev images and the
# already-extracted build/libpilot.so — only the (light) wrapper image is built.
#
#   bundles-free/io.telepat.ideon-free/  manifest.json + bin/{main,pilotServerWorker}.js
#                                        + node_modules (from the wrapper image)
#
# The manifest gets binary.sha256 pinned to its real binary, then signed with a
# THROWAWAY ed25519 publisher key (kept under bundles-free/, never the real
# secure/publisher.key) via `pilotctl appstore sign` — pure local crypto in a
# NETWORK-LESS throwaway container. The supervisor verifies sig + sha256, and the
# smoke daemon runs with -trust-auto-approve so any publisher is accepted.
#
# Nothing here RUNS a Pilot service on the host: the only host actions are
# `docker build` and pure-crypto pilotctl subcommands in throwaway containers.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLES="${ROOT}/bundles-free"
APP_ID="io.telepat.ideon-free"
KEY="${BUNDLES}/.publisher-free.key"
PILOT_IMAGE="${PILOT_IMAGE:-pilot-protocol/pilot:dev}"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/ideon-free:dev}"
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"   # this host has no buildx
log() { printf '\033[1;34m[build-free]\033[0m %s\n' "$*"; }

# pilotctl in a throwaway, network-less container that mounts the project.
pctl() { docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -v "${ROOT}:${ROOT}" -w "${ROOT}" --entrypoint pilotctl "${PILOT_IMAGE}" "$@"; }

# ── 1. build the free wrapper image (typecheck + tsup bundle) ─────────────────
if [ "${SKIP_IMAGE_BUILD:-0}" != "1" ]; then
  log "building free wrapper image ${WRAPPER_IMAGE} (npm ci + typecheck + tsup, in docker)"
  docker build -f "${ROOT}/docker/wrapper.Dockerfile" -t "${WRAPPER_IMAGE}" "${ROOT}"
else
  log "SKIP_IMAGE_BUILD=1 — reusing existing image ${WRAPPER_IMAGE}"
fi

# ── 2. stage the complete /app tree into the bundle dir ───────────────────────
rm -rf "${BUNDLES}"; mkdir -p "${BUNDLES}/${APP_ID}"
log "staging /app from ${WRAPPER_IMAGE} -> ${BUNDLES}/${APP_ID}"
ACID="$(docker create "${WRAPPER_IMAGE}")"; trap 'docker rm -f "${ACID}" >/dev/null 2>&1 || true' EXIT
docker cp "${ACID}:/app/." "${BUNDLES}/${APP_ID}/"
docker rm -f "${ACID}" >/dev/null 2>&1 || true; trap - EXIT
chmod +x "${BUNDLES}/${APP_ID}/bin/main.js"

for f in bin/main.js bin/pilotServerWorker.js manifest.json package.json; do
  [ -e "${BUNDLES}/${APP_ID}/${f}" ] || { echo "staged bundle incomplete — missing ${f}" >&2; exit 1; }
done
[ -d "${BUNDLES}/${APP_ID}/node_modules/pilotprotocol" ] || { echo "staged node_modules missing pilotprotocol" >&2; exit 1; }

# ── 3. throwaway publisher key (fresh each run) ───────────────────────────────
log "generating throwaway publisher key -> ${KEY}"
pctl appstore gen-key "${KEY}"

# ── 4. pin sha256(bin/main.js) + sign + verify ───────────────────────────────
mf="${BUNDLES}/${APP_ID}/manifest.json"
binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${mf}" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
sha="$(sha256sum "${BUNDLES}/${APP_ID}/${binrel}" | awk '{print $1}')"
log "pin ${binrel} sha256=${sha:0:16}…"
sed -i -E "s/(\"sha256\"[[:space:]]*:[[:space:]]*\")[0-9a-fA-F]{64}(\")/\1${sha}\2/" "${mf}"
log "sign + verify"
pctl appstore sign --key "${KEY}" "${mf}"
pctl appstore verify "${BUNDLES}/${APP_ID}"

log "DONE. bundle ready: ${BUNDLES}/${APP_ID} (signed, throwaway key)"
log "Next: IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d && scripts/smoke-free.sh"
