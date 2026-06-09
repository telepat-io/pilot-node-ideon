#!/usr/bin/env bash
#
# assert-host-clean.sh — guard the host's ~/.claude/CLAUDE.md against the
# skillinject tamper.
#
# Upstream's skillinject writes the host ~/.claude/CLAUDE.md every ~15 minutes,
# fencing its payload between `pilot:begin` / `pilot:end` markers. We build the
# Pilot daemon with `-tags no_skillinject` precisely to disable that, but this
# script is the belt-and-suspenders check: it proves the file was NOT mutated
# across a build/smoke run.
#
# Two modes:
#   (default / --baseline)  capture the current state into a baseline file:
#                             - sha256 of ~/.claude/CLAUDE.md (or "ABSENT")
#                             - assert the `pilot:begin` marker count is 0
#                           Exits non-zero if the marker is ALREADY present
#                           (the host is already tampered — fail loudly).
#   --after                 re-capture and compare against the baseline:
#                             - sha256 must be unchanged
#                             - `pilot:begin` marker count must still be 0
#                           Exits non-zero on ANY change.
#
# Usage:
#   assert-host-clean.sh [--baseline] [--file PATH] [--baseline-file PATH]
#   assert-host-clean.sh  --after     [--file PATH] [--baseline-file PATH]

set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────
CLAUDE_MD="${CLAUDE_MD:-${HOME}/.claude/CLAUDE.md}"
BASELINE_FILE="${BASELINE_FILE:-${TMPDIR:-/tmp}/pp-host-clean.baseline}"
MARKER='pilot:begin'   # skillinject fence-start marker; must never appear
MODE="baseline"

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline)      MODE="baseline" ;;
    --after)         MODE="after" ;;
    --file)          CLAUDE_MD="$2"; shift ;;
    --baseline-file) BASELINE_FILE="$2"; shift ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) printf 'assert-host-clean: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;34m[host-clean]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[host-clean:ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[host-clean:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# ── primitives ──────────────────────────────────────────────────────────────

# file_sha256 PATH -> prints the sha256 hex, or the literal "ABSENT" when the
# file does not exist (an absent CLAUDE.md is a perfectly clean state).
file_sha256() {
  local f="$1"
  if [ ! -e "${f}" ]; then
    printf 'ABSENT'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${f}" | awk '{print $1}'
  else
    shasum -a 256 "${f}" | awk '{print $1}'
  fi
}

# marker_count PATH -> number of lines containing the skillinject fence marker.
# 0 when the file is absent (grep on a missing file would error under set -e).
marker_count() {
  local f="$1"
  if [ ! -e "${f}" ]; then
    printf '0'
    return 0
  fi
  # Count matching lines via `grep -F | wc -l`. We deliberately do NOT use
  # `grep -Fc` here: on a no-match grep prints "0" to stdout AND exits 1, so a
  # `|| printf 0` fallback would double-print ("00"). Piping into `wc -l` gives a
  # clean count regardless. NOTE: the script runs under `set -o pipefail`, so
  # grep's exit-1 on no-match would otherwise propagate and kill the script on a
  # CLEAN host (the common case); `|| true` neutralises that without affecting
  # the count (wc still reads grep's empty stdout).
  { grep -F "${MARKER}" "${f}" 2>/dev/null || true; } | wc -l | tr -d '[:space:]'
}

# ── modes ───────────────────────────────────────────────────────────────────
case "${MODE}" in
  baseline)
    log "capturing baseline for ${CLAUDE_MD}"
    sha="$(file_sha256 "${CLAUDE_MD}")"
    mc="$(marker_count "${CLAUDE_MD}")"

    # A non-zero marker count at BASELINE time means the host is already
    # tampered — refuse to proceed; a green smoke run on a pre-tampered host
    # would be meaningless.
    if [ "${mc}" -ne 0 ]; then
      fail "host ALREADY tampered: '${MARKER}' appears ${mc}x in ${CLAUDE_MD} before the run even started"
    fi

    # Persist the baseline (sha + marker count) for --after to diff against.
    {
      printf 'file=%s\n' "${CLAUDE_MD}"
      printf 'sha256=%s\n' "${sha}"
      printf 'marker_count=%s\n' "${mc}"
    } > "${BASELINE_FILE}"

    ok "baseline saved -> ${BASELINE_FILE} (sha256=${sha}, ${MARKER} count=0)"
    ;;

  after)
    [ -f "${BASELINE_FILE}" ] \
      || fail "no baseline at ${BASELINE_FILE} — run with --baseline BEFORE the build/smoke run"

    # Read the saved baseline.
    base_sha="$(awk -F= '/^sha256=/{print $2}' "${BASELINE_FILE}")"
    base_mc="$(awk -F= '/^marker_count=/{print $2}' "${BASELINE_FILE}")"
    [ -n "${base_sha}" ] || fail "baseline file ${BASELINE_FILE} is missing sha256= line"

    now_sha="$(file_sha256 "${CLAUDE_MD}")"
    now_mc="$(marker_count "${CLAUDE_MD}")"

    log "comparing ${CLAUDE_MD} against baseline ${BASELINE_FILE}"
    log "  baseline: sha256=${base_sha} marker=${base_mc}"
    log "  now:      sha256=${now_sha} marker=${now_mc}"

    changed=0
    if [ "${now_mc}" -ne 0 ]; then
      printf '\033[1;31m[host-clean:FAIL]\033[0m %s\n' \
        "skillinject marker '${MARKER}' appeared ${now_mc}x in ${CLAUDE_MD} — host was tampered during the run" >&2
      changed=1
    fi
    if [ "${now_sha}" != "${base_sha}" ]; then
      printf '\033[1;31m[host-clean:FAIL]\033[0m %s\n' \
        "${CLAUDE_MD} sha256 changed (${base_sha} -> ${now_sha}) — host file was modified during the run" >&2
      changed=1
    fi

    [ "${changed}" -eq 0 ] || exit 1
    ok "host clean — ${CLAUDE_MD} unchanged and no '${MARKER}' marker introduced"
    ;;

  *)
    fail "unknown mode ${MODE}"
    ;;
esac
