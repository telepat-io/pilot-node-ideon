#
# docker/pilot.Dockerfile
# =======================
# Multi-stage image bundling the four Go binaries our topology needs:
#
#   pilot-daemon  — the Pilot node daemon            (monorepo ./cmd/daemon)
#   pilotctl      — the daemon/app-store CLI          (monorepo ./cmd/pilotctl)
#   wallet        — the reference payment app          (org/wallet)
#   rendezvous    — combined registry(TCP)+beacon(UDP)+http (org/rendezvous)
#
# ONE image, MANY roles. This same image backs every Go service in compose:
#   - the `rendezvous` service runs:  rendezvous -registry-addr :9000 -beacon-addr :9001 -http :3000 ...
#   - the `daemon`/`provider` services run:  pilot-daemon -registry rendezvous:9000 ...
# The differing ENTRYPOINT/CMD is supplied by compose, NOT baked here.
#
# The daemon is built with `-tags no_skillinject`. The final stage runs as a
# non-root `pilot` user with a container-local HOME=/home/pilot; no host path is
# mounted, bound, or pre-created. The app InstallRoot ($HOME/.pilot/apps) resolves
# to /home/pilot/.pilot/apps inside the container.
# ===========================================================================


# ---------------------------------------------------------------------------
# Stage 1: builder — golang:1.25-bookworm (matches monorepo go 1.25.10)
# ---------------------------------------------------------------------------
FROM golang:1.25-bookworm AS builder

# PILOT_REF pins the monorepo checkout (branch, tag, or commit SHA). The default
# is a pinned commit SHA so release builds are reproducible without extra args;
# override with --build-arg PILOT_REF=<ref> only for development. Keep this pin
# in lockstep with docker/libpilot.Dockerfile and docker/pilotctl.Dockerfile —
# bump procedure: docs/upgrading-pins.md.
ARG PILOT_REF=27e3039658bfa69a743ce8bd23ead240560a8dff

# git is needed both to clone the monorepo and for `go install ...@latest`
# (module-aware install uses VCS to resolve @latest).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# CGO is off for fully-static binaries that run on the slim Node final stage.
ENV CGO_ENABLED=0 \
    GOFLAGS=-buildvcs=false \
    GOTOOLCHAIN=local

WORKDIR /src

# --- monorepo: pilot-daemon + pilotctl -------------------------------------
# Clone the monorepo at PILOT_REF. module path: github.com/TeoSlayer/pilotprotocol
# (verified: the upstream monorepo/go.mod). No replace directives, so a plain
# clone + build resolves cleanly.
RUN git clone https://github.com/TeoSlayer/pilotprotocol /src/monorepo \
 && git -C /src/monorepo checkout "${PILOT_REF}"

WORKDIR /src/monorepo

# Pre-fetch modules in a cached layer (optional but speeds rebuilds).
RUN go mod download

# pilot-daemon — built with -tags no_skillinject.
# Flags exercised by compose live in cmd/daemon/main.go (-registry/-beacon/
# -socket/-identity/-public/-trust-auto-approve/-hostname/-no-dataexchange/
# -listen/-log-level).
RUN go build -tags no_skillinject -ldflags "-s -w" \
        -o /out/pilot-daemon ./cmd/daemon

# pilotctl — the appstore/daemon CLI (gen-key, sign, verify, install, list, call).
# Built with the same tag for consistency.
RUN go build -tags no_skillinject -ldflags "-s -w" \
        -o /out/pilotctl ./cmd/pilotctl

# --- wallet + rendezvous ----------------------------------------------------
# Built via module-aware `go install` against the published org module paths,
# verified in the upstream org/{wallet,rendezvous}/go.mod:
#     github.com/pilot-protocol/wallet      -> ./cmd/wallet
#     github.com/pilot-protocol/rendezvous  -> ./cmd/rendezvous   (combined registry+beacon+http)
# Neither module declares replace directives. Versions are PINNED (no @latest)
# so rebuilds are reproducible; bump procedure: docs/upgrading-pins.md.
# GOBIN=/out drops the binaries alongside the monorepo outputs.
ARG WALLET_VERSION=v0.3.0-rc1
ARG RENDEZVOUS_VERSION=v0.2.4

RUN GOBIN=/out go install -ldflags "-s -w" \
        "github.com/pilot-protocol/wallet/cmd/wallet@${WALLET_VERSION}"

RUN GOBIN=/out go install -ldflags "-s -w" \
        "github.com/pilot-protocol/rendezvous/cmd/rendezvous@${RENDEZVOUS_VERSION}"


# ---------------------------------------------------------------------------
# Stage 2: runtime — node:22-bookworm-slim
# ---------------------------------------------------------------------------
# Node base (not distroless/scratch) on purpose: the supervisor inside
# pilot-daemon exec()s our app's `node` binary.runtime wrapper, so a working
# Node 22 toolchain must be present in the SAME image that runs the daemon.
FROM node:22-bookworm-slim AS runtime

# ca-certificates only (TLS to the rendezvous http / any future outbound).
# Static Go binaries need no further runtime deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# All four binaries on PATH.
COPY --from=builder /out/pilot-daemon /usr/local/bin/pilot-daemon
COPY --from=builder /out/pilotctl     /usr/local/bin/pilotctl
COPY --from=builder /out/wallet       /usr/local/bin/wallet
COPY --from=builder /out/rendezvous   /usr/local/bin/rendezvous

# Non-root container-local user. HOME=/home/pilot is entirely inside the
# container; we deliberately do NOT mount or pre-create host paths (compose may
# attach named volumes for state, but not host paths).
RUN useradd --create-home --home-dir /home/pilot --shell /usr/sbin/nologin --uid 10001 pilot
ENV HOME=/home/pilot
USER pilot
WORKDIR /home/pilot

# ENTRYPOINT / CMD intentionally omitted — every compose service supplies its
# own command (rendezvous ... | pilot-daemon ... | wallet ...).
