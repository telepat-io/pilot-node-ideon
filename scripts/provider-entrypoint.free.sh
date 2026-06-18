#!/usr/bin/env bash
#
# provider-entrypoint.free.sh — bring up the FREE provider node inside its
# container. Unlike provider-entrypoint.sh (the paid node) this installs exactly
# ONE bundle — io.telepat.ideon-free — and supervises no wallet, because the free
# node has no payment leg.
#
# Why we COPY the bundle into the install root (instead of `pilotctl appstore
# install`): the install path copies ONLY manifest.json + the single binary at
# binary.path (appstore.go:1070-1081), which DROPS our Node app's node_modules +
# worker file. So we place the FULL, already-signed bundle dir into the writable
# install root ourselves; the always-on supervisor SCANS that root
# (monorepo/cmd/daemon/main.go:264-283), verifies the manifest signature + binary
# sha256, and supervises the app. The app dir must be WRITABLE (named volume, not
# a read-only bind) because the supervisor writes app.sock / identity.json /
# cap-state.jsonl into it.
set -euo pipefail

HOME_DIR="${HOME:-/home/pilot}"
APPS_DIR="${HOME_DIR}/.pilot/apps"
SOCK="${PILOT_SOCKET:-/run/pilot/pilot.sock}"
RUN_DIR="$(dirname "${SOCK}")"
REGISTRY="${RENDEZVOUS_REGISTRY:-rendezvous:9000}"
BEACON="${RENDEZVOUS_BEACON:-rendezvous:9001}"
HOSTN="${HOSTNAME_PILOT:-provider}"
IDENTITY="${IDENTITY_PATH:-/data/identity.json}"
LOGLEVEL="${LOG_LEVEL:-debug}"
APP_BUNDLE="${APP_BUNDLE:-/bundles/io.telepat.ideon-free}"

log() { printf '\033[1;36m[provider-entrypoint.free]\033[0m %s\n' "$*" >&2; }

mkdir -p "${APPS_DIR}" "${RUN_DIR}" "$(dirname "${IDENTITY}")"
[ -S "${SOCK}" ] && rm -f "${SOCK}" || true

# Install the single signed bundle into the writable install root. By default we
# install ONLY if the app dir is not already provisioned, which PRESERVES the
# supervised app's runtime state (identity.json) across restarts. Set
# PILOT_REINSTALL_APPS=1 to force a clean reinstall when deploying a new bundle.
REINSTALL="${PILOT_REINSTALL_APPS:-0}"
if [ -d "${APP_BUNDLE}" ] && [ -f "${APP_BUNDLE}/manifest.json" ]; then
  id="$(basename "${APP_BUNDLE}")"
  dest="${APPS_DIR}/${id}"
  if [ -f "${dest}/manifest.json" ] && [ "${REINSTALL}" != "1" ]; then
    log "keeping existing install ${id} (preserves identity; PILOT_REINSTALL_APPS=1 to refresh)"
  else
    log "installing bundle ${id} -> ${dest} (full copy, preserves node_modules)"
    rm -rf "${dest:?}"
    cp -a "${APP_BUNDLE}" "${dest}"
  fi
  binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${dest}/manifest.json" | head -1 | sed -E 's/.*"path"[^"]*"([^"]+)".*/\1/')"
  [ -n "${binrel}" ] && chmod +x "${dest}/${binrel}" 2>/dev/null || true
else
  log "FATAL: app bundle dir not found or missing manifest: ${APP_BUNDLE}"
  exit 1
fi

log "starting pilot-daemon (no_skillinject) hostname=${HOSTN} registry=${REGISTRY} beacon=${BEACON} socket=${SOCK}"
exec pilot-daemon \
  -registry "${REGISTRY}" \
  -beacon "${BEACON}" \
  -socket "${SOCK}" \
  -identity "${IDENTITY}" \
  -public \
  -trust-auto-approve \
  -hostname "${HOSTN}" \
  -no-dataexchange \
  -log-level "${LOGLEVEL}"
