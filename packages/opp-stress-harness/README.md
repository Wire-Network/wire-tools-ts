# @wireio/opp-stress-harness

Standalone, **un-privileged** OPP stress-testing harness for a live WIRE testnet.

`@wireio/test-opp-stress` is the low-level engine (ramp control, saturation
metric projection, run-evidence + verifier) and defines the pluggable
`EnvelopeRecordSource` seam; this package composes it into a harness a plain
testnet user can run — no local cluster, no debug-artifact filesystem. Everything
signs client-side via `@wireio/sdk-core` / `ethers`: no `clio` binary, no `kiod`
wallet daemon.

## Two directions, two lenses

OPP envelopes flow in two directions, and they are measured differently. The
load commands and the observability commands pair up by direction:

| Load command | Swap direction | Envelope direction | Observe with |
|---|---|---|---|
| `wire-run` | WIRE→outpost (`swapfromwire`) | depot→outpost | `saturation` (envelope byte size) |
| `eth-run` | ETH→WIRE (`requestSwap`) | outpost→depot | `throughput` (envelope count/epoch) |

A **successful** ETH→WIRE swap produces no depot→outpost envelope (the depot pays
from reserves directly), so ETH-sourced load is invisible to `saturation` — use
`throughput`. Inbound bytes are cleared after consensus, so `throughput` reports
inbound *counts*, not sizes.

## Observability (un-privileged, read-only)

```bash
wire-opp-stress saturation --url http://<depot-rpc> [--epoch-start N] [--epoch-end N] [--json]
wire-opp-stress throughput --url http://<depot-rpc> [--json]
```

## Load generation

Two source directions. Pick by what you have to hand.

### Ethereum-sourced — trivial setup (recommended when you just have test ETH)

Ethereum EOAs are free, so this path needs **no privileged provisioning**: you
supply test ETH and one existing WIRE recipient account (any account — many
wallets share one; there is no per-recipient uniqueness). Value flows ETH→WIRE,
so the swapped value lands as WIRE at your recipient (already yours); `eth-sweep`
reclaims residual ETH from the sources.

```bash
export WIRE_ETH_FUNDER_KEY=<funder EOA private key holding ETH>
wire-opp-stress eth-provision \
  --eth-url http://<eth-rpc> --recipient <existing WIRE account> \
  --wallets 200 --wallet-file ./eth-wallets.json --fund-wei 200000000000000000

wire-opp-stress eth-run \
  --eth-url http://<eth-rpc> --wallet-file ./eth-wallets.json \
  --reserve-manager <ReserveManager address> \
  --swaps-per-wallet 10 --concurrency 16

wire-opp-stress eth-sweep --eth-url http://<eth-rpc> --wallet-file ./eth-wallets.json
```

The ReserveManager address is the deployed outpost contract on your network (the
harness's local deploys write it to `<ethereum>/.local/deployments/outpost-addrs.json`
under the `ReserveManager` key).

### WIRE-sourced — privileged setup, but directly saturation-measurable

WIRE replaced Antelope's `buyram`/`powerup` economy with **ROA**: there is no
un-privileged account-creation or RAM-purchase path. So `wire-provision` needs a
**tier-1 node owner account** (name + active key) holding WIRE and ROA
allocation — it creates the wallets (`sysio.roa::newuser`), grants each a policy
(`sysio.roa::addpolicy`), and funds them. `wire-run` and `wire-sweep` then need
only the wallet file.

```bash
export WIRE_NODE_OWNER_KEY=<node owner active key>
wire-opp-stress wire-provision \
  --url http://<depot-rpc> --node-owner <tier1-owner> \
  --wallets 200 --wallet-file ./wire-wallets.json

wire-opp-stress wire-run \
  --url http://<depot-rpc> --wallet-file ./wire-wallets.json \
  --swaps-per-wallet 10 --concurrency 16

wire-opp-stress wire-sweep --url http://<depot-rpc> --wallet-file ./wire-wallets.json
```

`wire-provision` is **idempotent and resumable**: nonces are derived
deterministically per wallet index and are unique per `(creator, nonce)` on
chain, so re-running with the same `--nonce-prefix` recovers existing accounts
(via `sysio.roa::sponsors`) rather than creating duplicates.

## Notes

- **Wallet files hold private keys.** `--wallet-file` is written owner-only
  (`0600`); treat it as a secret. `run`/`sweep` consume it.
- **Reverting swaps still count as load.** Both directions emit their envelope
  before any variance/settlement outcome, so a swap the depot later reverts still
  generated OPP traffic.
- **Provisioning keys come from the environment** (`WIRE_NODE_OWNER_KEY` /
  `WIRE_ETH_FUNDER_KEY`) by default, so a private key does not sit in `argv`/`ps`.
- **Sweeps.** `eth-sweep` retains exactly one transfer's gas and returns the rest
  (balances below gas cost are left as dust). `wire-sweep` returns the full
  balance — WIRE CPU/NET come from the ROA policy, not tokens.
