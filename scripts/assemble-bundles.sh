#!/usr/bin/env bash
#
# assemble-bundles.sh — build the two SIGNED app bundles from the already-built
# images, into ./bundles/. Run scripts/build.sh (or build the 3 images) first.
#
#   bundles/io.pilot.wallet/         manifest.json + bin/wallet           (Go, from pilot image)
#   bundles/io.telepat.ideon-article/ manifest.json + bin/{main,worker}.js + node_modules (from wrapper image)
#
# Each manifest gets binary.sha256 pinned to its real binary, then signed with a
# fresh ed25519 publisher key via `pilotctl appstore sign` (pure local crypto in
# a NETWORK-LESS throwaway container). The supervisor verifies sig + sha256.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLES="${ROOT}/bundles"
SECURE="${ROOT}/secure"
KEY="${SECURE}/publisher.key"
PILOT_IMAGE="${PILOT_IMAGE:-pilot-protocol/pilot:dev}"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/ideon-article:dev}"
log() { printf '\033[1;34m[assemble]\033[0m %s\n' "$*"; }

# pilotctl in a throwaway, network-less container that mounts the project.
pctl() { docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -v "${ROOT}:${ROOT}" -w "${ROOT}" --entrypoint pilotctl "${PILOT_IMAGE}" "$@"; }

rm -rf "${BUNDLES}"; mkdir -p "${BUNDLES}/io.pilot.wallet/bin" "${BUNDLES}/io.telepat.ideon-article" "${SECURE}"
chmod 700 "${SECURE}" || true

# ── wallet bundle: manifest from public upstream, binary from the pilot image ──
log "assembling wallet bundle (fetching wallet manifest from upstream)"
curl -fsSL https://raw.githubusercontent.com/pilot-protocol/wallet/main/manifest.json \
  -o "${BUNDLES}/io.pilot.wallet/manifest.json"
WCID="$(docker create "${PILOT_IMAGE}")"; trap 'docker rm -f "${WCID}" >/dev/null 2>&1 || true' EXIT
docker cp "${WCID}:/usr/local/bin/wallet" "${BUNDLES}/io.pilot.wallet/bin/wallet"
docker rm -f "${WCID}" >/dev/null 2>&1 || true; trap - EXIT
chmod +x "${BUNDLES}/io.pilot.wallet/bin/wallet"

# ── app bundle: full /app tree from the wrapper image ─────────────────────────
log "assembling ideon-article bundle"
ACID="$(docker create "${WRAPPER_IMAGE}")"; trap 'docker rm -f "${ACID}" >/dev/null 2>&1 || true' EXIT
docker cp "${ACID}:/app/." "${BUNDLES}/io.telepat.ideon-article/"
docker rm -f "${ACID}" >/dev/null 2>&1 || true; trap - EXIT
chmod +x "${BUNDLES}/io.telepat.ideon-article/bin/main.js"

# ── publisher key (once) ──────────────────────────────────────────────────────
[ -f "${KEY}" ] || { log "gen publisher key"; pctl appstore gen-key "${KEY}"; }

# ── pin sha256 + sign each bundle ─────────────────────────────────────────────
pin_and_sign() {
  local dir="$1" mf="$1/manifest.json"
  local binrel; binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${mf}" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  local sha; sha="$(sha256sum "${dir}/${binrel}" | awk '{print $1}')"
  log "  ${dir##*/}: pin ${binrel} sha256=${sha:0:16}…"
  # set binary.sha256 (portable sed; the only 64-hex value at the sha256 key)
  sed -i -E "s/(\"sha256\"[[:space:]]*:[[:space:]]*\")[0-9a-fA-F]{64}(\")/\1${sha}\2/" "${mf}"
  log "  ${dir##*/}: sign + verify"
  pctl appstore sign --key "${KEY}" "${mf}"
  pctl appstore verify "${dir}"
}
pin_and_sign "${BUNDLES}/io.pilot.wallet"
pin_and_sign "${BUNDLES}/io.telepat.ideon-article"

log "bundles ready under ${BUNDLES} (signed). publisher key: ${KEY}"
