# `manifest.json` — field-by-field reference

`io.telepat.ideon-article`. This file documents every field of the sibling
`manifest.json`. The manifest itself is **pure JSON** (no comments): the
supervisor parses it with `json.Unmarshal`, which rejects JSONC, so the
annotations live here instead.

Schema source: `org/app-store/pkg/manifest/manifest.go` (struct) +
`validate.go` (rules). The supervisor re-parses, re-`Validate()`s and
re-`VerifySignature()`s on **every** scan and the binary sha256 is re-checked
on **every** spawn (`org/app-store/plugin/appstore/supervisor.go:261,267,717`).

---

## Top-level

| Field | Value | Why |
|-------|-------|-----|
| `id` | `io.telepat.ideon-article` | Reverse-DNS, `^seg(\.seg)+$`, lowercase only (`validate.go:73-75`). Also the install-dir name under `<home>/.pilot/apps/<id>/` (`supervisor.go:249`). |
| `app_version` | `0.1.0` | Simplified semver `MAJOR.MINOR.PATCH` (`validate.go:78`). Bumps freely on bug/feature work; silent binary swap (`manifest.go:28-30`). |
| `manifest_version` | `1` | Monotonic int `>= 1` (`validate.go:111`). Increments **only** when grants / affiliates / security-affecting fields change → forces explicit user re-consent (`manifest.go:33-36`). |
| `protection` | `guarded` | One of `""`/`shareable`/`guarded` (`validate.go:62-67`). `guarded` = encrypted volume + restricted process namespace (`manifest.go:41-43`). We hold a `state.db` of paid/delivered records, so we opt into the stricter mode. |
| `exposes` | `[]` | The broker-dispatched IPC method list. **Empty by design**: peers reach this app over **dataexchange** (overlay port 1001, see `INTERFACES.md` §3), not via the app-store broker. We are a *server over the overlay*, not a *callee over the IPC broker*. Empty is legal (`validate.go` only checks each `Extends.Method` is in `exposes` *when* `exposes` is non-empty, `:160-163`). |

## `binary`

| Field | Value | Why |
|-------|-------|-----|
| `runtime` | `node` | One of `go`/`bun`/`node`/`python` (`validate.go:36-41`). **Metadata only** for our case — see the exec note below. |
| `path` | `bin/main.js` | Built by `tsup src/main.ts … --out-dir bin` (`app/package.json` build script). Must resolve **under** the install dir — any `..` is rejected (`supervisor.go:276`), and a symlink at this path is refused (`supervisor.go:288`). |
| `sha256` | `0000…0000` (placeholder) | 64 lowercase hex (`validate.go:80`). Filled at bundle time by `scripts/sign-bundle.sh`; the supervisor sha256-checks the file at `path` against this on **every** spawn and suspends the app on mismatch (`supervisor.go:717-731`). |

> **Exec note (load-bearing).** The supervisor execs the binary **directly**:
> `exec.CommandContext(ctx, a.BinaryPath, args...)` (`supervisor.go:763`) — it
> does **not** prepend the `node` interpreter. Therefore `bin/main.js` must be a
> self-executing script: a `#!/usr/bin/env node` shebang **and** the executable
> bit. The build/bundle step (`scripts/sign-bundle.sh`) is responsible for
> prepending the shebang and `chmod +x`-ing `bin/main.js` before hashing it.
> The `runtime:"node"` field is descriptive/cap-policy metadata, not the launcher.
>
> The spawn always passes six flags: `--addr --db --socket --identity
> --manifest --cap-state` (`supervisor.go:752-759`). `--db` points at
> `<dir>/data.db`; we treat that as our `state.db` (the `fs.write $APP/state.db`
> grant covers our own writes; the supervisor itself owns `data.db`).

## `grants` (>= 1 required, `validate.go:114-117`)

`cap` must be in `KnownCaps`; `target` must be non-empty (`validate.go:191-201`).
`$APP` is the per-app state root; `*.pilot` is an overlay host pattern; an
`ipc.call` target is `<app>.<method>` (`manifest.go:80-82`).

| Grant | Purpose |
|-------|---------|
| `fs.write $APP/state.db` | Persist the dedupe/quote/delivery ledger (paid → delivered, idempotency keys). |
| `fs.read  $APP/state.db` | Re-read that ledger on restart to resume idempotency. |
| `audit.log *` | Emit audit lines for request / quote / pay-verify / deliver events. Mirrors the wallet manifest's `audit.log *` grant. |
| `net.dial *.pilot` (rate 60/min) | Talk to peers / rendezvous over the Pilot overlay. Rate-limited via the `rate` condition kind (`validate.go:26`). Same shape as the wallet's `net.dial *.pilot` grant. |
| `net.dial ideon-mcp` (rate 30/min) | Reach the Ideon MCP HTTP server (`http://ideon-mcp:3001/mcp`) on the private compose network. Separate, tighter budget so a runaway generation loop is contained. |
| `ipc.call io.pilot.wallet.wallet.evm.verify` | We are the **payee**: verify the caller's payment authorization receipt (`INTERFACES.md` §5, `wallet.evm.verify`). |
| `ipc.call io.pilot.wallet.wallet.evm.address` | Fetch **our own** EVM recipient address to populate `Contract.recipient_addr` for the on-chain/x402 path (`INTERFACES.md` §5, `wallet.evm.address`). |

> **Mock-vs-EVM caveat (smoke test).** The pinned mock smoke flow does **not**
> route through `wallet.evm.*` — the mock method `io.pilot.wallet-mock/v1` is
> reached via `wallet.request`/`wallet.pay`/`wallet.verify`
> (`INTERFACES.md` §5, OPEN QUESTION 3). If/when the mock path is wired through
> app-store IPC rather than a direct sibling-socket dial, add matching
> `ipc.call io.pilot.wallet.wallet.request` / `.wallet.verify` grants and a
> bumped `manifest_version`. v1 keeps the declared IPC surface to the two EVM
> methods we actually broker-call; the mock dance in the smoke test goes over
> the **sibling app.sock** directly (`INTERFACES.md` §2(b)), which the daemon's
> broker does not gate by these grants.

## `depends` (`manifest.go:144-147`, `validate.go:141-149`)

```json
[{"app": "io.pilot.wallet", "methods": ["wallet.evm.verify", "wallet.evm.address"]}]
```

Declares, for install-time user review, which methods of which other app we
invoke. `app` must be reverse-DNS; `methods` must be non-empty. Pairs with the
two `ipc.call` grants above.

## `store` (`manifest.go:117-123`, signed at bundle time)

| Field | Value | Why |
|-------|-------|-----|
| `publisher` | `ed25519:AAAA…` (placeholder) | `ed25519:<base64>`, >= 40 base64 chars (`validate.go:84`). **Overwritten** by `pilotctl appstore sign` to match the signing key (`appstore_sign.go:131`). |
| `signature` | `sig:placeholder…` | Non-empty (`validate.go:128`). Overwritten by `sign` with a real ed25519 signature over `publisher:id:manifest_version:binary.sha256:sha256(grants)` (`manifest.go:185`, `appstore_sign.go:135-146`). |

> **Trust anchor.** `VerifySignature` only proves the manifest was signed by
> whoever the `publisher` claims to be. `VerifyTrustAnchor` (separate) checks
> the publisher is on the daemon's compile-time `TrustedPublishers` allowlist
> (`manifest.go:225-258`) — empty list = fail-closed. The supervisor's scan
> calls `VerifySignature` (`supervisor.go:267`); putting our publisher key on
> the daemon's trust anchor (or running with auto-approve) is part of the
> catalogue go-live, **deferred** to a manual maintainer step (see
> `scripts/sign-bundle.sh`).

## Fields intentionally omitted

`affiliates`, `extends`, `dynamic_extends` — not used by v1. All are
`omitempty` in the struct (`manifest.go:48,56,63`) and unvalidated when absent.
We register no daemon hook points and have no co-trusted settlement notary.
