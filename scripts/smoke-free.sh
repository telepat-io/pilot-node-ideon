#!/usr/bin/env bash
#
# smoke-free.sh — VERIFIED end-to-end check for the FREE node: the caller node
# dials the provider's generate capability over the overlay and asserts a real
# article comes back in ONE round-trip — no payment step. Proves: the local
# rendezvous, two trusted nodes, the supervised wrapper, the dataexchange
# request/reply path, and that the payment leg is GONE.
#
# Dry-run (default): Ideon writes a placeholder article — no LLM key needed.
#
# Prereq: scripts/build-free.sh then `docker compose -f compose.free.yaml up -d`.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"; cd "${ROOT}"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.free.yaml}"
PROJECT="${COMPOSE_PROJECT:-ideon-free}"
NET="${PROJECT}_pilot-net"
CALLER_RUN_VOL="${PROJECT}_caller-run"
IDEA="${IDEA:-How small teams adopt AI writing}"
LENGTH="${LENGTH:-small}"
WRAPPER_IMAGE="${WRAPPER_IMAGE:-pilot-protocol/ideon-free:dev}"
IDEON_OUTPUT_DIR="/data/ideon/.ideon/output"

log() { printf '\033[1;36m[smoke-free]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[smoke-free:ok]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke-free:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f build/libpilot.so ] || die "build/libpilot.so missing — run scripts/build-all.sh first"

log "waiting for provider app readiness (its app.sock == ready)"
st=""
for _ in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-provider-daemon-1" 2>/dev/null || echo none)"
  [ "${st}" = healthy ] && break
  sleep 2
done
[ "${st:-}" = healthy ] || die "provider-daemon not healthy (status=${st:-none}); check 'docker compose -f ${COMPOSE_FILE} logs provider-daemon'"

PADDR="$(docker compose logs provider-daemon 2>&1 | grep -oE 'addr=0:[0-9.A-F]+' | tail -1 | cut -d= -f2)"
[ -n "${PADDR}" ] || die "could not determine provider overlay address from logs"
log "provider overlay address: ${PADDR}"

# dx <json> : one dataexchange round-trip caller -> provider:1001. Prints reply.
dx() {
  docker run --rm --network "${NET}" \
    -v "${CALLER_RUN_VOL}:/caller-run" \
    -v "${ROOT}/build/libpilot.so:/opt/libpilot.so:ro" \
    -v "${ROOT}/scripts:/app/scripts:ro" \
    -e PILOT_LIB_PATH=/opt/libpilot.so \
    --entrypoint node -w /app \
    "${WRAPPER_IMAGE}" \
    /app/scripts/dx-client.mjs --socket /caller-run/pilot.sock --target "${PADDR}" --json "$1"
}

# ideon_dirs : number of generation dirs under the shared Ideon output volume.
ideon_dirs() {
  local n
  n="$(docker compose exec -T ideon-mcp sh -c "ls -1 ${IDEON_OUTPUT_DIR} 2>/dev/null | wc -l | tr -d '[:space:]'" 2>/dev/null || true)"
  case "${n}" in ''|*[!0-9]*) echo 0 ;; *) echo "${n}" ;; esac
}

# ── 1. GENERATE (the only op) ───────────────────────────────────────────────
log "generate: caller -> provider:1001 {op:generate, idea, length:${LENGTH}}"
before="$(ideon_dirs)"
REPLY="$(dx "{\"op\":\"generate\",\"idea\":\"${IDEA}\",\"length\":\"${LENGTH}\"}")" \
  || die "generate round-trip failed (dx-client errored)"
echo "  reply (head): $(printf '%s' "${REPLY}" | head -c 240)"
echo "${REPLY}" | grep -q '"op":"generate"' || die "reply op is not generate: ${REPLY}"
echo "${REPLY}" | grep -q '"ok":true'        || die "generate did not succeed: ${REPLY}"
echo "${REPLY}" | grep -q '"article":"'      || die "ok but no article body: ${REPLY}"
echo "${REPLY}" | grep -q '"article":""' && die "ok but article body is EMPTY: ${REPLY}" || true
echo "${REPLY}" | grep -q '"title":'         || die "ok but no title: ${REPLY}"
echo "${REPLY}" | grep -q '"slug":'          || die "ok but no slug: ${REPLY}"
after="$(ideon_dirs)"
[ "${after}" -gt "${before}" ] \
  || die "Ideon output dir count did NOT increase (before=${before} after=${after}) — did the shared /data/ideon volume + readback work?"
ok "generate OK — article delivered; Ideon ran (dirs ${before} -> ${after})"

# ── 2. ADVERSARIAL: the payment ops must be GONE ────────────────────────────
log "adversarial: a legacy {op:quote} must be rejected (no payment path exists)"
QREPLY="$(dx "{\"op\":\"quote\",\"idea\":\"${IDEA}\",\"length\":\"${LENGTH}\"}" || true)"
echo "  quote reply: ${QREPLY}"
echo "${QREPLY}" | grep -q '"ok":false'    || die "legacy quote was NOT rejected: ${QREPLY}"
echo "${QREPLY}" | grep -qi 'unknown op'   || die "quote rejection is not 'unknown op': ${QREPLY}"
echo "${QREPLY}" | grep -qi 'contract' && die "reply mentions a contract — payment path LEAKED: ${QREPLY}" || true
echo "${QREPLY}" | grep -qi 'USDC'     && die "reply mentions USDC — payment path LEAKED: ${QREPLY}" || true
ok "legacy quote rejected with 'unknown op'; no contract/USDC in any reply"

ok "PASS ✅  free generate verified over the overlay; no payment/quote path remains."
