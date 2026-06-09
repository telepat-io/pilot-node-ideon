#!/usr/bin/env bash
#
# provider-entrypoint.sh — bring up the provider node inside its container.
#
# Why we COPY bundles into the install root (instead of `pilotctl appstore
# install`): the install path copies ONLY manifest.json + the single binary at
# binary.path (appstore.go:1070-1081). That is fine for the Go wallet but DROPS
# our Node app's node_modules + worker file. So we place the FULL, already-signed
# bundle dirs into the writable install root ourselves; the always-on supervisor
# SCANS that root (monorepo/cmd/daemon/main.go:264-283), verifies each manifest
# signature + binary sha256, and supervises both apps. The app dir must be
# WRITABLE (named volume, not a read-only bind) because the supervisor writes
# app.sock / data.db / identity.json / cap-state.jsonl into it.
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
WALLET_BUNDLE="${WALLET_BUNDLE:-/bundles/io.pilot.wallet}"
APP_BUNDLE="${APP_BUNDLE:-/bundles/io.telepat.ideon-article}"

log() { printf '\033[1;36m[provider-entrypoint]\033[0m %s\n' "$*" >&2; }

mkdir -p "${APPS_DIR}" "${RUN_DIR}" "$(dirname "${IDENTITY}")"
[ -S "${SOCK}" ] && rm -f "${SOCK}" || true

# Install each signed bundle into the writable install root. By default we install
# ONLY if the app dir is not already provisioned, which PRESERVES the supervised
# app's runtime state across restarts — the wallet's identity.json + data.db (its
# keys + ledger) and our app's state. Unconditionally wiping would regenerate the
# wallet identity on every boot and orphan any funds tied to the old payee address.
# Set PILOT_REINSTALL_APPS=1 to force a clean reinstall when deploying a new bundle
# (back up the app dir first — a reinstall drops identity/db).
REINSTALL="${PILOT_REINSTALL_APPS:-0}"
for b in "${WALLET_BUNDLE}" "${APP_BUNDLE}"; do
  if [ -d "${b}" ] && [ -f "${b}/manifest.json" ]; then
    id="$(basename "${b}")"
    dest="${APPS_DIR}/${id}"
    if [ -f "${dest}/manifest.json" ] && [ "${REINSTALL}" != "1" ]; then
      log "keeping existing install ${id} (preserves identity/db; PILOT_REINSTALL_APPS=1 to refresh)"
    else
      log "installing bundle ${id} -> ${dest} (full copy, preserves node_modules)"
      rm -rf "${dest:?}"
      cp -a "${b}" "${dest}"
    fi
    binrel="$(grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' "${dest}/manifest.json" | head -1 | sed -E 's/.*"path"[^"]*"([^"]+)".*/\1/')"
    [ -n "${binrel}" ] && chmod +x "${dest}/${binrel}" 2>/dev/null || true
  else
    log "WARN: bundle dir not found or missing manifest: ${b} (skipping)"
  fi
done

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
