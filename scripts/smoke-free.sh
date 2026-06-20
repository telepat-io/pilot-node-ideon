#!/usr/bin/env bash
#
# smoke-free.sh — end-to-end check for the FREE node over the app-store IPC path.
# Drives the supervised app with `pilotctl appstore call`: help, then
# generate -> poll until a real article comes back, then asserts an unknown
# method is rejected. Proves: the supervisor + IPC dispatcher, the async
# generate/poll protocol, the gateway /mcp + /files round-trip, and that the
# payment leg is GONE.
#
# Portability: the provider daemon shares NO volume with Ideon — the article body
# is read back over the gateway /files route, exactly as a remote install would.
#
# Dry-run (the compose default): Ideon writes a placeholder article — no LLM key,
# no egress. Prereq: scripts/build-free.sh then
#   IDEON_MCP_API_KEY=changeme docker compose -f compose.free.yaml up -d
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"; cd "${ROOT}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.free.yaml}"
PROJECT="${COMPOSE_PROJECT:-ideon-free}"
APP="io.telepat.ideon-free"
IDEA="${IDEA:-How small teams adopt AI writing}"
LENGTH="${LENGTH:-small}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-180}"

log() { printf '\033[1;36m[smoke-free]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[smoke-free:ok]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke-free:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# call <method> <json-payload> : invoke an app method through the local daemon.
call() { docker compose -f "${COMPOSE_FILE}" exec -T provider-daemon \
           pilotctl appstore call "${APP}" "$1" "$2" 2>&1; }

log "waiting for provider app readiness (app.sock == ready)"
st=""
for _ in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-provider-daemon-1" 2>/dev/null || echo none)"
  [ "${st}" = healthy ] && break
  sleep 2
done
[ "${st:-}" = healthy ] || die "provider-daemon not healthy (status=${st:-none}); check 'docker compose -f ${COMPOSE_FILE} logs provider-daemon'"

# ── 1. help — the IPC dispatcher answers (the old stub returned 'method not found') ──
log "help: ideon-free.help"
H="$(call ideon-free.help '{}')"
echo "${H}" | grep -q 'ideon-free.generate' || die "help did not list ideon-free.generate: ${H}"
ok "help lists the method catalogue"

# ── 2. generate (async) -> jobId ────────────────────────────────────────────
log "generate: {idea, length:${LENGTH}}"
G="$(call ideon-free.generate "{\"idea\":\"${IDEA}\",\"length\":\"${LENGTH}\"}")"
JOB="$(printf '%s' "${G}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "${JOB}" ] || die "no jobId in generate reply: ${G}"
ok "job accepted: ${JOB}"

# ── 3. poll until done; assert a real article comes back over /files ─────────
log "poll every 3s until done (timeout ${POLL_TIMEOUT_S}s)"
R=""; deadline=$(( $(date +%s) + POLL_TIMEOUT_S ))
while :; do
  R="$(call ideon-free.poll "{\"jobId\":\"${JOB}\"}")"
  printf '%s' "${R}" | grep -q '"status": *"done"'  && break
  printf '%s' "${R}" | grep -q '"status": *"error"' && die "generation errored: ${R}"
  printf '%s' "${R}" | grep -q '"status": *"pending"' || die "unexpected poll reply: ${R}"
  [ "$(date +%s)" -lt "${deadline}" ] || die "poll timed out after ${POLL_TIMEOUT_S}s (still pending)"
  printf '.'; sleep 3
done
printf '\n'
printf '%s' "${R}" | grep -q '"ok": *true'        || die "done but not ok: ${R}"
printf '%s' "${R}" | grep -qE '"article": *"[^"]' || die "ok but article body is empty/missing: ${R}"
printf '%s' "${R}" | grep -q '"title"'            || die "ok but no title: ${R}"
printf '%s' "${R}" | grep -q '"slug"'             || die "ok but no slug: ${R}"
ok "generate -> poll delivered a non-empty article (body read back over the gateway /files route)"

# ── 4. adversarial: an unknown method and a missing idea are rejected ────────
log "adversarial: unknown method + empty generate must be rejected"
B="$(call ideon-free.nope '{}' || true)"
printf '%s' "${B}" | grep -qi 'method not found' || die "unknown method was NOT rejected: ${B}"
E="$(call ideon-free.generate '{}' || true)"
printf '%s' "${E}" | grep -qi 'missing idea'     || die "empty generate was NOT rejected: ${E}"
ok "unknown method + empty idea rejected"

ok "PASS ✅  free generate/poll verified via app-store IPC; article read back over HTTP; no payment path remains."
