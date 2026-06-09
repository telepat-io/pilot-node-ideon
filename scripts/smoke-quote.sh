#!/usr/bin/env bash
#
# smoke-quote.sh — VERIFIED end-to-end check (request path): the caller node
# dials the provider's request-article capability over the overlay and asserts a
# USDC PaymentContract comes back. Proves: the local rendezvous, two
# trusted nodes, the supervised wrapper, and the dataexchange request/reply path.
#
# Prereq: scripts/build-all.sh then `docker compose -f compose.smoke.yaml up -d`.
# (The pay(mock)+deliver leg is scripts/smoke-deliver.sh — see README "status".)
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"; cd "${ROOT}"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.smoke.yaml}"   # target the smoke topology, not prod compose.yaml
PROJECT="${COMPOSE_PROJECT:-ideon-article-smoke}"
NET="${PROJECT}_pilot-net"
CALLER_RUN_VOL="${PROJECT}_caller-run"
log() { printf '\033[1;36m[smoke-quote]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke-quote:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f build/libpilot.so ] || die "build/libpilot.so missing — run scripts/build-all.sh first"

log "waiting for provider app readiness (its app.sock == ready)"
for _ in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-provider-daemon-1" 2>/dev/null || echo none)"
  [ "${st}" = healthy ] && break
  sleep 2
done
[ "${st:-}" = healthy ] || die "provider-daemon not healthy (status=${st:-none}); check 'docker compose logs provider-daemon'"

PADDR="$(docker compose logs provider-daemon 2>&1 | grep -oE 'addr=0:[0-9.A-F]+' | tail -1 | cut -d= -f2)"
[ -n "${PADDR}" ] || die "could not determine provider overlay address from logs"
log "provider overlay address: ${PADDR}"

IDEA='How small teams productionize AI writing'
log "caller -> provider:1001  {op:quote, idea, length:medium}"
REPLY="$(docker run --rm --network "${NET}" \
  -v "${CALLER_RUN_VOL}:/caller-run" \
  -v "${ROOT}/build/libpilot.so:/opt/libpilot.so:ro" \
  -v "${ROOT}/scripts:/app/scripts:ro" \
  -e PILOT_LIB_PATH=/opt/libpilot.so \
  --entrypoint node -w /app \
  pilot-protocol/ideon-article:dev \
  /app/scripts/dx-client.mjs --socket /caller-run/pilot.sock --target "${PADDR}" \
  --json "{\"op\":\"quote\",\"idea\":\"${IDEA}\",\"length\":\"medium\"}")"

echo "reply: ${REPLY}"
echo "${REPLY}" | grep -q '"op":"quote"' || die "no quote in reply"
echo "${REPLY}" | grep -q '"asset":"USDC"' || die "contract missing USDC asset"
echo "${REPLY}" | grep -q '"accepted_methods":\["io.pilot.wallet-mock/v1"\]' || die "contract missing mock method"
log "PASS ✅  caller received a valid USDC PaymentContract over the overlay"
