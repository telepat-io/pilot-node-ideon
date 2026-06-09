#!/usr/bin/env bash
# scripts/sign-bundle.sh — produce a submission-ready, sha256-pinned app bundle
# for io.telepat.ideon-article. (See the Pilot catalogue go-live process.)
#
# WHAT THIS DOES (host-side, deterministic, NO daemon is run):
#   1. Build the Node app to bin/main.js (tsup), prepend a `node` shebang and
#      chmod +x — because the supervisor execs binary.path DIRECTLY, not via a
#      `node` wrapper (org/app-store/plugin/appstore/supervisor.go:763).
#   2. gen-key a fresh ed25519 publisher key (once) into a secure dir, OUTSIDE
#      the bundle (pilotctl appstore gen-key, cmd/pilotctl/appstore_sign.go:42).
#   3. Compute sha256(bin/main.js) and write it into manifest.json binary.sha256
#      — the value the supervisor re-checks on EVERY spawn (supervisor.go:717).
#   4. Sign the manifest in place (pilotctl appstore sign --key … manifest.json);
#      `sign` ALSO rewrites store.publisher to match the key and self-verifies
#      (appstore_sign.go:131-159).
#   5. Assemble the staging tree (manifest.json + bin/ + any runtime
#      node_modules), tar.gz it, and shasum the tarball — that tarball sha256 is
#      what a catalogue entry pins (cmd/pilotctl/appstore_catalogue.go:198).
#
# pilotctl is invoked from the pilot daemon image we build under docker/ (it
# ships the pilotctl binary). We DO NOT run a daemon: gen-key/sign are pure
# local crypto subcommands. The container is given no network and is removed
# after each call.
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
#   scripts/sign-bundle.sh [--key /secure/publisher.key] [--out dist]
#
# ENV:
#   PILOT_IMAGE   pilot image carrying pilotctl   (default: pilot-daemon:local)
#   KEY_FILE      ed25519 publisher private key   (default: ./secure/publisher.key)
#   OUT_DIR       output dir for the tarball       (default: ./dist)
#   SKIP_BUILD=1  reuse an existing app/bin/main.js (skip `npm run build`)
#
# DEFERRED MANUAL MAINTAINER STEPS (NOT done here — see end of file):
#   - publishing the tarball to a URL,
#   - opening the catalogue PR (catalogue/catalogue.json),
#   - adding the publisher key to the daemon's TrustedPublishers anchor.

set -euo pipefail

# ── Resolve paths (repo root = parent of this script's dir) ──────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${REPO_ROOT}/app"

PILOT_IMAGE="${PILOT_IMAGE:-pilot-daemon:local}"
KEY_FILE="${KEY_FILE:-${REPO_ROOT}/secure/publisher.key}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/dist}"

# ── Flags ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY_FILE="$2"; shift 2 ;;
    --out) OUT_DIR="$2";  shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

MANIFEST="${APP_DIR}/manifest.json"
BIN="${APP_DIR}/bin/main.js"
APP_ID="io.telepat.ideon-article"

log() { printf '\033[1;34m[sign-bundle]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[sign-bundle] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
[[ -f "${MANIFEST}" ]] || die "manifest not found: ${MANIFEST}"

# pilotctl runner: a throwaway, network-less container that mounts the repo and
# (only if it lives outside the repo) the key dir. --entrypoint pilotctl so we
# hit the CLI directly. No daemon is started — gen-key/sign/verify are pure
# local crypto subcommands.
pilotctl() {
  local key_dir extra=()
  key_dir="$(cd "$(dirname "${KEY_FILE}")" && pwd)"
  # Avoid a duplicate/overlapping -v when the key dir is already under REPO_ROOT.
  case "${key_dir}/" in
    "${REPO_ROOT}/"*) : ;;                         # covered by the repo mount
    *) extra=(-v "${key_dir}:${key_dir}") ;;
  esac
  docker run --rm --network none \
    -v "${REPO_ROOT}:${REPO_ROOT}" \
    "${extra[@]}" \
    -w "${REPO_ROOT}" \
    --entrypoint pilotctl \
    "${PILOT_IMAGE}" "$@"
}

# ── 1. Build the Node app (tsup → bin/main.js), make it self-executing ───────
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "building app → bin/main.js (npm run build)"
  ( cd "${APP_DIR}" && npm run build )
fi
[[ -f "${BIN}" ]] || die "expected built binary missing: ${BIN} (run 'npm run build' in app/ or set SKIP_BUILD=0)"

# The supervisor execs binary.path directly (supervisor.go:763) — node is NOT
# prepended. Ensure a shebang + exec bit so `exec(bin/main.js)` launches node.
if ! head -c 2 "${BIN}" | grep -q '#!'; then
  log "prepending '#!/usr/bin/env node' shebang to bin/main.js"
  tmp="$(mktemp)"
  printf '#!/usr/bin/env node\n' > "${tmp}"
  cat "${BIN}" >> "${tmp}"
  mv "${tmp}" "${BIN}"
fi
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

# ── 3. Compute sha256(bin/main.js) and pin it into manifest.binary.sha256 ────
# 64 lowercase hex, exactly what validate.go:80 and verifyBinary (supervisor.go:730)
# expect. Use python3 for an in-place JSON edit that preserves the schema shape.
BIN_SHA="$(sha256sum "${BIN}" | awk '{print $1}')"
log "bin/main.js sha256 = ${BIN_SHA}"
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

# ── 4. Sign the manifest in place ────────────────────────────────────────────
# `sign` overwrites store.publisher to match the key AND store.signature, then
# self-verifies before writing (appstore_sign.go:131-159). The signed payload
# covers binary.sha256, so signing MUST happen AFTER step 3.
log "signing manifest (pilotctl appstore sign --key … manifest.json)"
pilotctl appstore sign --key "${KEY_FILE}" "${MANIFEST}"

# Sanity: verify locally too (independent of the daemon). `verify` re-checks the
# embedded ed25519 signature against store.publisher.
log "verifying signed manifest (pilotctl appstore verify)"
pilotctl appstore verify "${MANIFEST}" || die "post-sign verify failed"

# ── 5. Stage + tar + shasum the bundle ───────────────────────────────────────
# Bundle layout mirrors the install dir the supervisor scans: manifest.json at
# the root and binary.path resolving under it (supervisor.go:249,276).
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
mkdir -p "${STAGE}/bin"
cp "${MANIFEST}" "${STAGE}/manifest.json"
cp "${BIN}"      "${STAGE}/bin/main.js"
chmod +x "${STAGE}/bin/main.js"

# Runtime node_modules: include ONLY if the build did not fully bundle deps.
# tsup with the default config bundles app code but leaves `dependencies`
# (e.g. the pilotprotocol sdk-node FFI) external, so they must ship. If a
# production node_modules exists, vendor it; otherwise the app must be a single
# self-contained file.
if [[ -d "${APP_DIR}/node_modules" ]]; then
  log "vendoring app/node_modules into the bundle (external runtime deps)"
  # --prod-only sieve: copy node_modules as-is; the smoke-test image installs
  # nothing, so whatever the app needs at runtime must be here.
  cp -a "${APP_DIR}/node_modules" "${STAGE}/node_modules"
else
  log "no app/node_modules present — assuming a fully self-contained bin/main.js"
fi

mkdir -p "${OUT_DIR}"
TARBALL="${OUT_DIR}/${APP_ID}-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["app_version"])' "${MANIFEST}").tar.gz"
log "creating bundle tarball → ${TARBALL}"
# Deterministic-ish tar (sorted, fixed owner) so the sha is reproducible.
tar --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime='UTC 2020-01-01' \
    -czf "${TARBALL}" -C "${STAGE}" .

TAR_SHA="$(sha256sum "${TARBALL}" | awk '{print $1}')"
printf '%s  %s\n' "${TAR_SHA}" "$(basename "${TARBALL}")" > "${TARBALL}.sha256"

log "DONE."
echo
echo "  bundle tarball : ${TARBALL}"
echo "  tarball sha256 : ${TAR_SHA}"
echo "  manifest sha256: ${BIN_SHA}  (bin/main.js)"
echo "  publisher key  : ${KEY_FILE}  (mode 0600 — keep secret, NOT in the bundle)"
echo "  publisher pub  : $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["store"]["publisher"])' "${MANIFEST}")"
echo
cat <<EOF
LOCAL INSTALL — unpack the staging tree into a bundle
dir and hand it to the provider daemon's app store:

    tar -xzf "${TARBALL}" -C /path/to/bundle-dir
    pilotctl -socket <daemon.sock> appstore install /path/to/bundle-dir

──────────────────────────────────────────────────────────────────────────────
DEFERRED MANUAL MAINTAINER STEPS (catalogue go-live — NOT performed by this
script):

  1. Host \$(basename "${TARBALL}") at a stable https:// (or file://) URL.
  2. Open a catalogue PR adding an entry to catalogue/catalogue.json:
         { "id": "${APP_ID}",
           "version": "<app_version>",
           "description": "...",
           "bundle_url": "https://.../\$(basename "${TARBALL}")",
           "bundle_sha256": "${TAR_SHA}" }
     (schema: cmd/pilotctl/appstore_catalogue.go:64-70; the pinned sha lets a
      compromised CDN be detected — fetchAndUnpackBundle re-checks it.)
  3. Add the publisher pubkey above to the daemon's compile-time
     manifest.TrustedPublishers anchor (manifest.go:225) so VerifyTrustAnchor
     passes. (The smoke test uses the daemon's -trust-auto-approve instead.)
EOF
