# Upgrading the pinned upstream versions

Every upstream input to this node is pinned to an exact commit SHA or version,
so builds are reproducible and a release tarball re-signs to the same sha256.
This doc is the **bump procedure**: what is pinned where, how to resolve new
refs, and the mandatory verification before a bump lands.

## 1. Pin inventory

| Pin | Where | What it controls |
|-----|-------|------------------|
| `PILOT_REF` (commit SHA) | `docker/pilot.Dockerfile`, `docker/libpilot.Dockerfile`, `docker/pilotctl.Dockerfile` — **must move in lockstep** | The `TeoSlayer/pilotprotocol` monorepo checkout: daemon, `pilotctl`, the `../web4` sibling for libpilot |
| `WALLET_VERSION`, `RENDEZVOUS_VERSION` | `docker/pilot.Dockerfile` (build args) | `go install` of `github.com/pilot-protocol/{wallet,rendezvous}` |
| Sibling repo SHAs | `docker/upstream-pins.txt` (one `repo sha` per line) | The ~16 `github.com/pilot-protocol/*` modules libpilot's `replace => ../<name>` layout needs |
| `pilotprotocol` (sdk-node) | `app/package.json` (exact version) + `app/package-lock.json` | The Node FFI SDK vendored into the release bundle |

The three `PILOT_REF` defaults must always be the **same SHA**: the daemon that
runs the bundle, the `pilotctl` that signs it locally, and the `pilotctl` that
CI builds to verify a release must all agree on manifest semantics.

## 2. Resolving new refs

```sh
# Pilot monorepo tip:
git ls-remote https://github.com/TeoSlayer/pilotprotocol HEAD

# Sibling repo tips (paste into docker/upstream-pins.txt):
for r in $(grep -v '^#' docker/upstream-pins.txt | awk '{print $1}'); do
  printf '%s ' "$r"; git ls-remote "https://github.com/pilot-protocol/$r" HEAD | awk '{print $1}'
done

# wallet / rendezvous module versions (pseudo-versions are fine to pin):
docker run --rm golang:1.25-bookworm sh -c \
  'go list -m github.com/pilot-protocol/wallet@latest && go list -m github.com/pilot-protocol/rendezvous@latest'

# sdk-node version:
docker run --rm node:22-bookworm-slim npm view pilotprotocol version
```

Update the pins, then (only if `pilotprotocol` changed) regenerate the lockfile
**inside a container** — never run npm installs for this app on the host:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/app:/work" -w /work node:22-bookworm-slim \
  npm install --package-lock-only --no-audit --no-fund
```

## 3. Mandatory verification: `--no-cache` rebuild

Docker layer cache will happily mask a broken pin — `git clone` layers are
cached, so a normal rebuild proves nothing about the new refs. Rebuild from
scratch:

```sh
export DOCKER_BUILDKIT=0
docker build --no-cache -f docker/pilot.Dockerfile    -t pilot-protocol/pilot:dev    /tmp/pp-emptyctx
docker build --no-cache -f docker/libpilot.Dockerfile -t pilot-protocol/libpilot:dev .
docker build --no-cache -f docker/pilotctl.Dockerfile -t pilotctl:ci .
```

### What a patch failure looks like, and what to do

The libpilot build carries local reconciliation patches (the org repos are
versioned inconsistently); each is guarded so rot fails loudly:

- **`grep -qF 'C.GoString(adminToken)' libpilot/bindings.go` fails** — upstream
  libpilot regressed to the 2-arg `common/driver.PolicySet`. Re-add the old sed
  patch (see this file's git history / the Dockerfile comment) that appends a
  `""` adminToken argument.
- **Duplicate symbol error mentioning `PilotSetTaskExec`, `PilotManagedScore`
  or `PilotManagedRankings`** — upstream now exports a symbol we stub. Delete
  that stub from `docker/patches/libpilot-stubs.go`.
- **koffi load error at smoke time (`missing symbol …`)** — the new sdk-node
  declares a symbol libpilot doesn't export yet. Add a no-op stub for it to
  `docker/patches/libpilot-stubs.go` (same pattern as the existing three).
- **Go compile error in `libpilot/bindings.go` against a sibling** — a sibling
  API moved. Reconcile like the PolicySet case: prefer bumping the lagging
  repo's pin; sed-patch only when upstream is the laggard, and always guard the
  sed with a grep so it can't silently no-op.

## 4. Smoke test before committing the bump

```sh
scripts/build-all.sh
IDEON_MCP_API_KEY=changeme docker compose -f compose.smoke.yaml up -d
scripts/smoke-quote.sh        # caller -> provider quote round-trip
scripts/smoke-deliver.sh      # pay(mock) -> deliver; bogus + replay refused
docker compose -f compose.smoke.yaml down
```

Commit the pin changes only after both smoke scripts pass.

## 5. Re-release

A pin bump changes the shipped bundle (new sdk-node) and/or the runtime images.
If the **bundle contents** changed (sdk-node, app code), bump `app_version` in
`app/manifest.json` (+ `app/package.json` version), tag `v<app_version>`, and
cut a release — the maintainer signs locally and publishes (the publisher key
never lives on GitHub); the `verify-release` workflow re-verifies the published
artifacts. If only daemon-side images changed, redeploy without a new bundle
release.
