#
# docker/libpilot.Dockerfile — build libpilot.so (the C ABI the Node sdk-node
# FFI loads). The npm platform package `pilotprotocol-linux-x64` that would ship
# this prebuilt .so is NOT published (404 on npm/PyPI; the daemon release tarball
# does not contain it), so we compile it from source.
#
# libpilot/go.mod uses local `replace => ../<name>` for the monorepo (../web4)
# and ~15 org modules, so it builds ONLY in a side-by-side checkout. We clone the
# repos as siblings under /src (web4 = the monorepo) and build with
# `-tags no_skillinject`.
#
# ONE LOCAL PATCH is applied (the org repos are versioned inconsistently, so
# libpilot's checkout needs reconciling with the rest):
#   - COPY docker/patches/libpilot-stubs.go: no-op //export stubs for 3 symbols
#     the SDK declares that libpilot (at the pinned SHA) does not export (koffi
#     resolves all symbols eagerly at load; our app never calls these three).
#
# A FORMER PATCH is now an assertion: libpilot's bindings.go used to call the
# 2-arg common/driver.PolicySet and we sed-patched in the 3rd `adminToken` arg;
# upstream adopted it natively as of libpilot bb2287d (PilotPolicySet takes
# adminToken). The grep below fails the build if a future pin regresses —
# re-add the sed patch in that case (see docs/upgrading-pins.md).
#
# BUILD CONTEXT = the project root (so docker/patches is reachable):
#   docker build -f docker/libpilot.Dockerfile -t pilot-protocol/libpilot:dev .
# Override the upstream pin with --build-arg PILOT_REF=<branch|tag|sha>.
#
# PINNING: PILOT_REF defaults to a pinned monorepo commit SHA (keep in lockstep
# with docker/pilot.Dockerfile and docker/pilotctl.Dockerfile), and the org
# sibling repos are pinned per-SHA in docker/upstream-pins.txt. A bad/garbage-
# collected SHA fails the build loudly — there is deliberately NO fallback to
# an unpinned clone. Bump procedure: docs/upgrading-pins.md.
FROM golang:1.25-bookworm AS build

ARG PILOT_REF=27e3039658bfa69a743ce8bd23ead240560a8dff
ENV CGO_ENABLED=1 \
    GOFLAGS=-buildvcs=false \
    GOTOOLCHAIN=local

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Monorepo becomes the ../web4 sibling. clone-then-checkout (NOT --branch) so a
# raw commit SHA pins; a bad ref aborts the build instead of silently falling
# back to the branch tip.
RUN git clone https://github.com/TeoSlayer/pilotprotocol web4 \
 && git -C web4 checkout --detach "${PILOT_REF}"

# Every org module libpilot's go.mod replaces => ../<name>, plus libpilot
# itself — each pinned to the SHA in docker/upstream-pins.txt. GitHub permits
# fetching an arbitrary commit by SHA, so init+fetch --depth 1 stays shallow;
# an unknown SHA makes the fetch (and the build) fail loudly.
COPY docker/upstream-pins.txt /src/upstream-pins.txt
RUN set -eu; grep -v '^#' /src/upstream-pins.txt | while read -r r sha; do \
      [ -n "$r" ] || continue; \
      git init -q "$r" \
      && git -C "$r" remote add origin "https://github.com/pilot-protocol/$r" \
      && git -C "$r" fetch --depth 1 -q origin "$sha" \
      && git -C "$r" checkout -q --detach FETCH_HEAD; \
    done

# ASSERT (ex-PATCH 1) — upstream libpilot now passes adminToken to the 3-arg
# common/driver.PolicySet natively. If a future pin loses this, the build fails
# here: re-add the old sed patch (history: git log on this file; procedure:
# docs/upgrading-pins.md).
RUN grep -qF 'C.GoString(adminToken)' libpilot/bindings.go

# PATCH — no-op //export stubs for the 3 symbols the SDK needs but libpilot
# lacks (PilotSetTaskExec, PilotManagedScore, PilotManagedRankings). If a future
# pin exports any of these natively, the build fails with a duplicate-symbol
# error — trim the stub file accordingly.
COPY docker/patches/libpilot-stubs.go /src/libpilot/zz_pp_stubs.go

WORKDIR /src/libpilot
# -mod=mod lets go reconcile go.mod/go.sum for the sibling-replace layout.
RUN go build -mod=mod -tags no_skillinject -buildmode=c-shared -o /out/libpilot.so . \
 && ls -la /out/libpilot.so

# Tiny carrier stage so callers can `docker create` + `docker cp /libpilot.so`.
FROM debian:bookworm-slim
COPY --from=build /out/libpilot.so /libpilot.so
