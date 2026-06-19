#!/usr/bin/env bash
# scripts/sign-bundle.sh — produce a submission-ready, sha256-pinned app bundle
# for io.telepat.ideon-free. (See the Pilot catalogue go-live process.)
#
# WHAT THIS DOES (all builds inside Docker; NO daemon is run):
#   1. Build the wrapper image (docker/wrapper.Dockerfile: npm ci + typecheck +
#      tsup) and stage the SINGLE self-contained bundle:
#         manifest.json  bin/main.mjs
#      bin/main.mjs is ESM-self-interpreting (no package.json/node_modules), so the
#      official catalogue install (manifest + binary only) yields a working app.
#   2. Compute sha256(bin/main.mjs) and pin it into the STAGED manifest.json —
#      the value the supervisor re-checks on EVERY spawn (supervisor.go:717).
#      The repo's app/manifest.json keeps its placeholder; the working tree
#      stays clean and re-runs are idempotent.
#   3. Sign the staged manifest (pilotctl appstore sign --key …); `sign` ALSO
#      rewrites store.publisher to match the key and self-verifies
#      (appstore_sign.go:131-159). Then `pilotctl appstore verify` on the
#      staged bundle dir as an independent check.
#   4. tar.gz the stage deterministically (sorted names, fixed owner/mtime) and
#      sha256 the tarball — that sha is what a catalogue entry pins
#      (cmd/pilotctl/appstore_catalogue.go:198). Reproducible end-to-end:
#      app/package-lock.json + `npm ci` fix the dependency tree, so the same
#      commit re-signs to the SAME tarball sha.
#   5. Write dist/catalogue-entry.json ({id, version, description, bundle_url,
#      bundle_sha256}) ready to hand to a Pilot maintainer.
#
# pilotctl is invoked from the pilot image we build under docker/ (it ships the
# pilotctl binary). We DO NOT run a daemon: gen-key/sign/verify are pure local
# crypto subcommands. The container gets no network, runs as the invoking user,
# and is removed after each call.
#
# CITATIONS (paths are into the public upstream sources):
#   - manifest schema  : org/app-store/pkg/manifest/manifest.go + validate.go
#   - signing payload  : manifest.go:185  (publisher:id:mver:bin.sha256:sha256(grants))
#   - gen-key / sign   : monorepo/cmd/pilotctl/appstore_sign.go
#   - spawn execs path : org/app-store/plugin/appstore/supervisor.go:763
#   - binary re-hash   : org/app-store/plugin/appstore/supervisor.go:717-731
#   - bundle sha pin   : monorepo/cmd/pilotctl/appstore_catalogue.go:185-205
#
# USAGE:
#   scripts/sign-bundle.sh [--key /secure/publisher.key] [--out dist] \
#                          [--bundle-url-base https://github.com/<org>/<repo>/releases/download/<tag>]
#
# ENV:
#   PILOT_IMAGE    pilot image carrying pilotctl (default: pilot-protocol/pilot:dev)
#   WRAPPER_IMAGE  wrapper image tag to build/stage (default: pilot-protocol/ideon-free:release)
#   SKIP_IMAGE_BUILD=1  reuse an existing WRAPPER_IMAGE (skip docker build)
#
# DEFERRED MANUAL MAINTAINER STEPS (NOT done here — see end of output):
#   - publishing the tarball to a URL (tools/release-ideon.sh in the private
#     monorepo automates GitHub Release publication),
#   - opening the catalogue PR (catalogue/catalogue.json),
#   - adding the publisher key to the daemon's TrustedPublishers anchor.

set -euo pipefail

# ── Resolve paths (repo root = parent of this script's dir) ──────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${REPO_ROOT}/app"

PILOT_IMAGE="${PILOT_IMAGE:-pilot-protocol/pilot:dev}"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/ideon-free:release}"
KEY_FILE="${KEY_FILE:-${REPO_ROOT}/secure/publisher.key}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/dist}"
BUNDLE_URL_BASE="${BUNDLE_URL_BASE:-}"

# ── Flags ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY_FILE="$2"; shift 2 ;;
    --out) OUT_DIR="$2";  shift 2 ;;
    --bundle-url-base) BUNDLE_URL_BASE="$2"; shift 2 ;;
    -h|--help) sed -n '2,55p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

APP_ID="io.telepat.ideon-free"

log() { printf '\033[1;34m[sign-bundle]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[sign-bundle] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
[[ -f "${APP_DIR}/manifest.json" ]] || die "manifest not found: ${APP_DIR}/manifest.json"
[[ -f "${APP_DIR}/package-lock.json" ]] || die "app/package-lock.json missing — required for a reproducible bundle (see docs/upgrading-pins.md)"

# pilotctl runner: a throwaway, network-less container that mounts the repo and
# (only if it lives outside the repo) the key dir. Runs as the INVOKING user so
# signed/staged files are not root-owned; HOME=/tmp keeps pilotctl from touching
# a real home. No daemon is started — gen-key/sign/verify are pure local crypto.
pilotctl() {
  local key_dir extra=()
  key_dir="$(cd "$(dirname "${KEY_FILE}")" && pwd)"
  # Avoid a duplicate/overlapping -v when the key dir is already under REPO_ROOT.
  case "${key_dir}/" in
    "${REPO_ROOT}/"*) : ;;                         # covered by the repo mount
    *) extra=(-v "${key_dir}:${key_dir}") ;;
  esac
  docker run --rm --network none \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -v "${REPO_ROOT}:${REPO_ROOT}" \
    "${extra[@]}" \
    -w "${REPO_ROOT}" \
    --entrypoint pilotctl \
    "${PILOT_IMAGE}" "$@"
}

# ── 1. Build the wrapper image and stage its complete /app tree ──────────────
if [[ "${SKIP_IMAGE_BUILD:-0}" != "1" ]]; then
  log "building wrapper image ${WRAPPER_IMAGE} (npm ci + typecheck + tsup, in docker)"
  ( cd "${REPO_ROOT}" && DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}" \
      docker build -f docker/wrapper.Dockerfile -t "${WRAPPER_IMAGE}" . )
else
  log "SKIP_IMAGE_BUILD=1 — reusing existing image ${WRAPPER_IMAGE}"
fi

# Stage under OUT_DIR so the repo mount covers it for the pilotctl container.
mkdir -p "${OUT_DIR}"
STAGE="${OUT_DIR}/.stage"
rm -rf "${STAGE}"
mkdir -p "${STAGE}"
trap 'rm -rf "${STAGE}"' EXIT

log "staging manifest.json + bin/main.mjs from ${WRAPPER_IMAGE} → ${STAGE}"
CID="$(docker create "${WRAPPER_IMAGE}")"
mkdir -p "${STAGE}/bin"
docker cp "${CID}:/app/manifest.json" "${STAGE}/manifest.json"
docker cp "${CID}:/app/bin/main.mjs" "${STAGE}/bin/main.mjs"
docker rm -f "${CID}" >/dev/null 2>&1 || true

BIN="${STAGE}/bin/main.mjs"
MANIFEST="${STAGE}/manifest.json"
for f in "${BIN}" "${MANIFEST}"; do
  [[ -e "$f" ]] || die "staged bundle incomplete — missing $(basename "$f")"
done

# The supervisor execs binary.path directly (supervisor.go:763) — node is NOT
# prepended. tsup's banner emits the shebang; keep the guard + exec bit. The
# bundle is a SINGLE self-contained .mjs (no node_modules/package.json), so the
# official catalogue install (manifest + binary only) yields a working app.
head -c 2 "${BIN}" | grep -q '#!' || die "bin/main.mjs lacks a shebang (tsup banner missing?)"
chmod +x "${BIN}"

# ── 2. gen-key (once) — fresh ed25519 publisher key, OUTSIDE the bundle ──────
mkdir -p "$(dirname "${KEY_FILE}")"
chmod 700 "$(dirname "${KEY_FILE}")" 2>/dev/null || true
if [[ -f "${KEY_FILE}" ]]; then
  log "reusing existing publisher key: ${KEY_FILE}"
else
  log "generating publisher key → ${KEY_FILE} (pilotctl appstore gen-key)"
  # gen-key refuses to overwrite (appstore_sign.go:48); we only reach here if absent.
  pilotctl appstore gen-key "${KEY_FILE}"
fi

# ── 3. Pin sha256(bin/main.mjs) into the STAGED manifest.binary.sha256 ────────
# 64 lowercase hex, exactly what validate.go:80 and verifyBinary (supervisor.go:730)
# expect. Use python3 for an in-place JSON edit that preserves the schema shape.
BIN_SHA="$(sha256sum "${BIN}" | awk '{print $1}')"
log "bin/main.mjs sha256 = ${BIN_SHA}"
python3 - "${MANIFEST}" "${BIN_SHA}" <<'PY'
import json, sys
mf_path, sha = sys.argv[1], sys.argv[2]
with open(mf_path) as f:
    m = json.load(f)
m["binary"]["sha256"] = sha
with open(mf_path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
PY

# ── 4. Sign the staged manifest, then verify the staged bundle dir ───────────
# `sign` overwrites store.publisher to match the key AND store.signature, then
# self-verifies before writing (appstore_sign.go:131-159). The signed payload
# covers binary.sha256, so signing MUST happen AFTER step 3.
log "signing staged manifest (pilotctl appstore sign --key …)"
pilotctl appstore sign --key "${KEY_FILE}" "${MANIFEST}"

log "verifying staged bundle (pilotctl appstore verify)"
pilotctl appstore verify "${STAGE}" || die "post-sign verify failed"

# ── 5. Deterministic tar + sha256 + catalogue entry ──────────────────────────
APP_VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["app_version"])' "${MANIFEST}")"
TARBALL="${OUT_DIR}/${APP_ID}-${APP_VERSION}.tar.gz"
log "creating bundle tarball → ${TARBALL}"
# Deterministic tar (sorted, fixed owner/mtime) + gzip -n (no embedded
# timestamp) so the sha is reproducible across runs of the same commit.
tar --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime='UTC 2020-01-01' \
    -cf - -C "${STAGE}" . | gzip -n > "${TARBALL}"

TAR_SHA="$(sha256sum "${TARBALL}" | awk '{print $1}')"
printf '%s  %s\n' "${TAR_SHA}" "$(basename "${TARBALL}")" > "${TARBALL}.sha256"

DESCRIPTION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["description"])' "${APP_DIR}/package.json")"
if [[ -n "${BUNDLE_URL_BASE}" ]]; then
  BUNDLE_URL="${BUNDLE_URL_BASE%/}/$(basename "${TARBALL}")"
else
  BUNDLE_URL="https://<host-the-tarball-here>/$(basename "${TARBALL}")"
fi
python3 - "${OUT_DIR}/catalogue-entry.json" "${APP_ID}" "${APP_VERSION}" "${DESCRIPTION}" "${BUNDLE_URL}" "${TAR_SHA}" <<'PY'
import json, sys
out, app_id, version, desc, url, sha = sys.argv[1:7]
with open(out, "w") as f:
    json.dump({"id": app_id, "version": version, "description": desc,
               "bundle_url": url, "bundle_sha256": sha}, f, indent=2)
    f.write("\n")
PY

PUBLISHER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["store"]["publisher"])' "${MANIFEST}")"

log "DONE."
echo
echo "  bundle tarball : ${TARBALL}"
echo "  tarball sha256 : ${TAR_SHA}"
echo "  manifest sha256: ${BIN_SHA}  (bin/main.mjs)"
echo "  catalogue entry: ${OUT_DIR}/catalogue-entry.json"
echo "  publisher key  : ${KEY_FILE}  (mode 0600 — keep secret, NOT in the bundle)"
echo "  publisher pub  : ${PUBLISHER}"
echo
cat <<EOF
LOCAL INSTALL — unpack the bundle into a dir and hand it to the provider
daemon's app store:

    tar -xzf "${TARBALL}" -C /path/to/bundle-dir
    pilotctl -socket <daemon.sock> appstore install /path/to/bundle-dir

──────────────────────────────────────────────────────────────────────────────
DEFERRED MANUAL MAINTAINER STEPS (catalogue go-live — NOT performed by this
script; the private monorepo's tools/release-ideon.sh automates step 1):

  1. Host $(basename "${TARBALL}") at a stable https:// URL (a GitHub Release
     asset on this repo is the convention).
  2. Open a catalogue PR adding ${OUT_DIR}/catalogue-entry.json's content to
     catalogue/catalogue.json
     (schema: cmd/pilotctl/appstore_catalogue.go:64-70; the pinned sha lets a
      compromised CDN be detected — fetchAndUnpackBundle re-checks it.)
  3. Add the publisher pubkey above to the daemon's compile-time
     manifest.TrustedPublishers anchor (manifest.go:225) so VerifyTrustAnchor
     passes. (The smoke test uses the daemon's -trust-auto-approve instead.)
EOF
