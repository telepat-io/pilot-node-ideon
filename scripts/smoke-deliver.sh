#!/usr/bin/env bash
#
# smoke-deliver.sh — VERIFIED end-to-end check (pay(mock)+deliver leg).
#
# Builds on scripts/smoke-quote.sh (the request path). Proves the full money
# path on the local test network:
#   quote   -> caller gets a USDC PaymentContract.
#   pay      -> a STANDALONE mock payer wallet (service `caller-wallet`) funds
#              itself (wallet.topup) and signs
#              the contract (wallet.pay) into a Receipt. (scripts/pay-client.mjs)
#   deliver  -> caller sends {op:deliver, contract, receipt}; the provider
#              VERIFIES the receipt via its supervised wallet (signature-only,
#              cross-node) and only THEN runs ideon_write (dry-run), returning
#              article-1.md inline. Ground truth that Ideon ran: a NEW dir under
#              the shared Ideon output volume.
#   NEGATIVE — bogus receipt: corrupted signature on a FRESH contract ->
#              "payment required" AND Ideon does NOT run (dir count unchanged).
#   NEGATIVE — replay: re-deliver an already-redeemed contract -> rejected
#              ("already delivered") AND Ideon does NOT run.
#
# Everything runs in containers; the host never executes Pilot/Ideon/Node.
# No host `jq`: pay-client.mjs does all JSON in-container; we assert with grep.
#
# Prereq: scripts/build-all.sh then `docker compose up -d` (all services healthy).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"; cd "${ROOT}"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.smoke.yaml}"   # target the smoke topology, not prod compose.yaml
PROJECT="${COMPOSE_PROJECT:-ideon-article-smoke}"
NET="${PROJECT}_pilot-net"
CALLER_RUN_VOL="${PROJECT}_caller-run"
IDEA="${IDEA:-How small teams productionize AI writing}"
LENGTH="${LENGTH:-medium}"
WALLET_SOCK="/home/pilot/wallet/wallet.sock"
IDEON_OUTPUT_DIR="/data/ideon/.ideon/output"

log() { printf '\033[1;36m[smoke-deliver]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[smoke-deliver:ok]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke-deliver:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f build/libpilot.so ] || die "build/libpilot.so missing — run scripts/build-all.sh first"

# ── wait for the services we need to be healthy ─────────────────────────────
wait_healthy() { # <container-suffix> <label>
  local name="${PROJECT}-$1-1" label="$2" st=""
  for _ in $(seq 1 40); do
    st="$(docker inspect -f '{{.State.Health.Status}}' "${name}" 2>/dev/null || echo none)"
    [ "${st}" = healthy ] && { ok "${label} healthy"; return 0; }
    sleep 2
  done
  die "${label} (${name}) not healthy (status=${st:-none}); check 'docker compose logs $1'"
}
log "waiting for provider, caller daemon, and payer wallet to be healthy"
wait_healthy provider-daemon "provider app"
wait_healthy caller-daemon   "caller daemon"
wait_healthy caller-wallet   "payer wallet"

# ── provider overlay address (from its daemon log) ──────────────────────────
PADDR="$(docker compose logs provider-daemon 2>&1 | grep -oE 'addr=0:[0-9.A-F]+' | tail -1 | cut -d= -f2)"
[ -n "${PADDR}" ] || die "could not determine provider overlay address from logs"
log "provider overlay address: ${PADDR}"

# ── helpers ─────────────────────────────────────────────────────────────────
# dx <json> : one dataexchange round-trip caller -> provider:1001. Prints reply.
dx() {
  docker run --rm --network "${NET}" \
    -v "${CALLER_RUN_VOL}:/caller-run" \
    -v "${ROOT}/build/libpilot.so:/opt/libpilot.so:ro" \
    -v "${ROOT}/scripts:/app/scripts:ro" \
    -e PILOT_LIB_PATH=/opt/libpilot.so \
    --entrypoint node -w /app \
    pilot-protocol/ideon-article:dev \
    /app/scripts/dx-client.mjs --socket /caller-run/pilot.sock --target "${PADDR}" --json "$1"
}

# pay <quote-reply> [tamper] : run the payer client INSIDE caller-wallet (local
# socket). Emits the full deliver-request JSON on stdout.
pay() {
  local quote="$1" tamper="${2:-}"
  local extra=()
  [ -n "${tamper}" ] && extra=(--tamper "${tamper}")
  docker compose exec -T caller-wallet \
    node /scripts/pay-client.mjs \
    --socket "${WALLET_SOCK}" --quote "${quote}" --idea "${IDEA}" --length "${LENGTH}" \
    "${extra[@]}"
}

# ideon_dirs : number of generation dirs under the shared Ideon output volume.
ideon_dirs() {
  local n
  n="$(docker compose exec -T ideon-mcp sh -c "ls -1 ${IDEON_OUTPUT_DIR} 2>/dev/null | wc -l | tr -d '[:space:]'" 2>/dev/null || true)"
  case "${n}" in ''|*[!0-9]*) echo 0 ;; *) echo "${n}" ;; esac
}

# ── 1. QUOTE ────────────────────────────────────────────────────────────────
log "quote: caller -> provider:1001 {op:quote, idea, length:${LENGTH}}"
QUOTE="$(dx "{\"op\":\"quote\",\"idea\":\"${IDEA}\",\"length\":\"${LENGTH}\"}")" \
  || die "quote round-trip failed (dx-client errored)"
echo "  quote: ${QUOTE}"
echo "${QUOTE}" | grep -q '"op":"quote"'  || die "no quote in reply: ${QUOTE}"
echo "${QUOTE}" | grep -q '"asset":"USDC"' || die "contract missing USDC asset: ${QUOTE}"

# ── 2. PAY (standalone mock payer wallet) ───────────────────────────────────
log "pay: funding payer wallet + signing the contract (mock method)"
DELIVER_REQ="$(pay "${QUOTE}")" || die "pay-client failed (topup/pay)"
echo "${DELIVER_REQ}" | grep -q '"op":"deliver"' || die "pay-client did not emit a deliver request: ${DELIVER_REQ}"
echo "${DELIVER_REQ}" | grep -q '"receipt"'      || die "deliver request missing receipt: ${DELIVER_REQ}"
ok "receipt minted"

# ── 3. DELIVER (good receipt) ───────────────────────────────────────────────
log "deliver: redeeming the receipt for the article"
before="$(ideon_dirs)"
DREPLY="$(dx "${DELIVER_REQ}")" || die "deliver round-trip failed (dx-client errored)"
echo "  deliver reply (head): $(printf '%s' "${DREPLY}" | head -c 200)"
echo "${DREPLY}" | grep -q '"ok":true'   || die "deliver did not succeed: ${DREPLY}"
echo "${DREPLY}" | grep -q '"article":"' || die "deliver ok but no article body: ${DREPLY}"
echo "${DREPLY}" | grep -q '"article":""' && die "deliver ok but article body is EMPTY: ${DREPLY}" || true
echo "${DREPLY}" | grep -q '"title":'    || die "deliver ok but no title: ${DREPLY}"
echo "${DREPLY}" | grep -q '"slug":'     || die "deliver ok but no slug: ${DREPLY}"
after="$(ideon_dirs)"
[ "${after}" -gt "${before}" ] \
  || die "Ideon output dir count did NOT increase on a paid deliver (before=${before} after=${after}) — did the shared /data/ideon volume + readback work?"
ok "deliver OK — article delivered; Ideon ran (dirs ${before} -> ${after})"

# ── 4. NEGATIVE: bogus receipt -> payment required AND Ideon never runs ─────
log "negative: bogus (corrupted-signature) receipt must be rejected without running Ideon"
QUOTE2="$(dx "{\"op\":\"quote\",\"idea\":\"${IDEA}\",\"length\":\"${LENGTH}\"}")" || die "second quote failed"
BOGUS_REQ="$(pay "${QUOTE2}" sig)" || die "pay-client (tamper sig) failed"
before_b="$(ideon_dirs)"
BREPLY="$(dx "${BOGUS_REQ}" || true)"
echo "  bogus reply: ${BREPLY}"
echo "${BREPLY}" | grep -q '"ok":false'        || die "bogus receipt was NOT rejected: ${BREPLY}"
echo "${BREPLY}" | grep -qi 'payment required' || die "bogus rejection is not 'payment required': ${BREPLY}"
after_b="$(ideon_dirs)"
[ "${after_b}" -eq "${before_b}" ] \
  || die "Ideon RAN on a bogus receipt (dirs ${before_b} -> ${after_b}) — payment gate LEAKED"
ok "bogus receipt rejected with 'payment required'; Ideon did NOT run (dirs steady at ${after_b})"

# ── 5. NEGATIVE: replay an already-delivered contract -> rejected ───────────
log "negative: replay of the already-delivered contract must be rejected"
before_r="$(ideon_dirs)"
RREPLY="$(dx "${DELIVER_REQ}" || true)"
echo "  replay reply: ${RREPLY}"
echo "${RREPLY}" | grep -q '"ok":false'        || die "replay was NOT rejected: ${RREPLY}"
echo "${RREPLY}" | grep -qi 'already delivered' || die "replay rejection is not 'already delivered': ${RREPLY}"
after_r="$(ideon_dirs)"
[ "${after_r}" -eq "${before_r}" ] \
  || die "Ideon RAN on a replay (dirs ${before_r} -> ${after_r}) — dedupe LEAKED"
ok "replay rejected ('already delivered'); Ideon did NOT re-run (dirs steady at ${after_r})"

# ── done ─────────────────────────────────────────────────────────────────────
ok "PASS ✅  quote -> pay(mock) -> deliver verified; bogus + replay correctly refused."
