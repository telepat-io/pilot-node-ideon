#
# docker/libpilot.Dockerfile — build libpilot.so (the C ABI the Node sdk-node
# FFI loads). The npm platform package `pilotprotocol-linux-x64` that would ship
# this prebuilt .so is NOT published (404 on npm/PyPI; the daemon release tarball
# does not contain it), so we compile it from source.
#
# libpilot/go.mod uses local `replace => ../<name>` for the monorepo (../web4)
# and ~15 org modules, so it builds ONLY in a side-by-side checkout. We clone the
# repos as siblings under /src (web4 = the monorepo) and build with
# `-tags no_skillinject` (the SDK never starts libpilot's embedded daemon — it
# only uses the client path — so the injector can't run; compiling it out
# guarantees it cannot even exist in the .so).
#
# TWO LOCAL PATCHES are applied (the org repos are versioned inconsistently and
# libpilot@HEAD lags the rest of the cascade — see PROVENANCE.md):
#   1. sed: common/driver.PolicySet gained a 3rd `adminToken string` arg that
#      libpilot's bindings.go hasn't adopted. We pass "" (unused by our app).
#   2. COPY docker/patches/libpilot-stubs.go: no-op //export stubs for 3 symbols
#      the SDK declares that libpilot@HEAD does not export (koffi resolves all
#      symbols eagerly at load; our app never calls these three).
#
# BUILD CONTEXT = the project root (so docker/patches is reachable):
#   docker build -f docker/libpilot.Dockerfile -t pilot-protocol/libpilot:dev .
# Override the upstream pin with --build-arg PILOT_REF=<branch|tag|sha>.
FROM golang:1.25-bookworm AS build

ARG PILOT_REF=main
ENV CGO_ENABLED=1 \
    GOFLAGS=-buildvcs=false \
    GOTOOLCHAIN=local

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Monorepo becomes the ../web4 sibling.
RUN git clone --depth 1 --branch "${PILOT_REF}" https://github.com/TeoSlayer/pilotprotocol web4 \
    || git clone --depth 1 https://github.com/TeoSlayer/pilotprotocol web4

# Every org module libpilot's go.mod replaces => ../<name>, plus libpilot itself.
RUN set -eu; for r in \
      common handshake policy runtime skillinject trustedagents rendezvous \
      beacon dataexchange eventstream gateway nameserver webhook updater \
      app-store libpilot; do \
      git clone --depth 1 "https://github.com/pilot-protocol/$r" "$r"; \
    done

# PATCH 1 — PolicySet 2-arg -> 3-arg (adminToken ""), call is unused by our app.
RUN sed -i 's#d.PolicySet(uint16(networkID), \[\]byte(C.GoString(policyJSON)))#d.PolicySet(uint16(networkID), []byte(C.GoString(policyJSON)), "")#' \
      libpilot/bindings.go

# PATCH 2 — no-op //export stubs for the 3 symbols the SDK needs but libpilot lacks.
COPY docker/patches/libpilot-stubs.go /src/libpilot/zz_pp_stubs.go

WORKDIR /src/libpilot
# -mod=mod lets go reconcile go.mod/go.sum for the sibling-replace layout.
RUN go build -mod=mod -tags no_skillinject -buildmode=c-shared -o /out/libpilot.so . \
 && ls -la /out/libpilot.so

# Tiny carrier stage so callers can `docker create` + `docker cp /libpilot.so`.
FROM debian:bookworm-slim
COPY --from=build /out/libpilot.so /libpilot.so
