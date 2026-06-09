#
# docker/pilotctl.Dockerfile — pilotctl ONLY, for CI release verification.
#
# The verify-release workflow needs `pilotctl appstore verify` (the faithful
# ed25519 + manifest check — we deliberately do NOT reimplement the signing
# payload in CI; canonicalization drift would silently weaken verification).
# Building docker/pilot.Dockerfile there would also compile the daemon, wallet
# and rendezvous; this image builds just ./cmd/pilotctl.
#
# PILOT_REF must stay in LOCKSTEP with docker/pilot.Dockerfile and
# docker/libpilot.Dockerfile — bump procedure: docs/upgrading-pins.md.
#
# Build (any context; nothing is copied from it):
#   docker build -f docker/pilotctl.Dockerfile -t pilotctl:ci .
FROM golang:1.25-bookworm AS builder

ARG PILOT_REF=27e3039658bfa69a743ce8bd23ead240560a8dff

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV CGO_ENABLED=0 \
    GOFLAGS=-buildvcs=false \
    GOTOOLCHAIN=local

# clone-then-checkout (NOT --branch) so a raw commit SHA pins; a bad ref
# aborts the build instead of silently falling back to the branch tip.
RUN git clone https://github.com/TeoSlayer/pilotprotocol /src/monorepo \
 && git -C /src/monorepo checkout --detach "${PILOT_REF}"

WORKDIR /src/monorepo
RUN go build -tags no_skillinject -ldflags "-s -w" \
        -o /out/pilotctl ./cmd/pilotctl

FROM debian:bookworm-slim
COPY --from=builder /out/pilotctl /usr/local/bin/pilotctl
ENTRYPOINT ["pilotctl"]
