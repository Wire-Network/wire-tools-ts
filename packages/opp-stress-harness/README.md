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
| `duplex-run` | both, concurrently | both | built in (ramps until both saturate) |

A **successful** ETH→WIRE swap produces no depot→outpost envelope (the depot pays
from reserves directly), so ETH-sourced load is invisible to `saturation` — use
`throughput`. Inbound bytes are cleared after consensus, so `throughput` reports
inbound *counts*, not sizes.

## Loading level

Every load command that ramps takes `--load-level`, a named preset that sets
**both** the envelope-size target and the ramp aggressiveness. The two are
coupled on purpose: a byte target is only reachable at a matching account count
(~300-byte attestations need ~210 landing in one epoch per direction to fill the
64KB cap), so raising one without the other yields a ramp that can never satisfy
its own criterion.

| Level | Byte target | Ramp (initial ×mult → max) | Phase timeout | Swaps/wallet | Concurrency |
|---|---|---|---|---|---|
| `light` | 25% of cap (16,384 B) | 12 ×2 → 96 | 240s | 1 | 4 |
| `moderate` *(default)* | 50% (32,768 B) | 24 ×2 → 192 | 360s | 1 | 8 |
| `heavy` | 75% (49,152 B) | 48 ×2 → 384 | 480s | 1 | 12 |
| `saturating` | 95% (62,259 B) | 48 ×2 → 512 | 480s | 2 | 16 |

`saturating` deliberately reproduces the in-cluster `flow-swap-stress-saturation`
campaign's calibrated gate and curve, so a CLI run and the flow judge saturation
identically.

Every derived knob is individually overridable on top of the preset:

```bash
wire-opp-stress duplex-run --load-level heavy \
  --ramp-max 1024 --byte-target-ratio 0.85 --concurrency 24
```

`--byte-target-ratio` (0, 1] · `--ramp-initial` · `--ramp-multiplier` ·
`--ramp-max` · `--ramp-phase-timeout-ms` · `--swaps-per-wallet` ·
`--concurrency`. Unset flags keep the preset's value; invalid combinations
(a ceiling below the starting count, a multiplier of 1, a ratio outside the
range) fail before any chain call.

The presets live in `@wireio/test-opp-stress` (`LoadProfile`), not in this
package, because the in-cluster `flow-swap-stress-saturation` campaign resolves
its ramp and byte gate from the SAME table — so a CLI run and the flow are
tunable by one vocabulary. The flow selects its level from the uniform
`WIRE_STRESS_LOAD_LEVEL` environment variable (defaulting to `saturating`, its
calibrated soak); this CLI selects with `--load-level` (defaulting to
`moderate`).

`saturation` also accepts `--load-level` / `--byte-target-ratio` so its
`saturated` flag is judged against the same gate the ramp uses.

## Bidirectional load — `duplex-run`

`wire-run` and `eth-run` each load one direction. `duplex-run` ramps **both at
once**, so a fully loaded inbound epoch meets a fully loaded outbound queue
inside a single transaction — the condition `OPPInbound.epochIn` actually faces,
since it dispatches the inbound envelope and then drains the outbound queue via
its inline `emitOutboundEnvelope`.

```bash
wire-opp-stress duplex-run \
  --url http://<depot-rpc> --eth-url http://<eth-rpc> \
  --wallet-file ./wire-wallets.json \
  --eth-wallet-file ./eth-wallets.json \
  --reserve-manager <ReserveManager address> \
  --load-level heavy
```

Both wallet sets come from the existing provisioning commands (`wire-provision`
and `eth-provision`); the ramp drives the first N wallets of each per iteration
and doubles N until both directions saturate, one breaks, or the ceiling is hit.

### The two halves are measured differently

Only one direction's envelope size is observable un-privileged, and the report
labels them accordingly:

- **depot→outpost — MEASURED.** `outenvelopes` is polled every 2s *during* each
  burst and distinct envelopes accumulate by storage key. Sampling is required,
  not incidental: the table is one-deep per outpost, so a single read after the
  burst would miss every envelope the depot already rotated past. Saturation is
  the peak sampled size crossing the level's byte gate.
- **outpost→depot — INFERRED.** The depot clears an inbound envelope's bytes
  once consensus is reached, so its size can never be read back over RPC.
  Saturation is inferred from accepted swaps per epoch against a ~300-byte
  mean attestation size. Load spread thin across several epochs correctly fails
  the gate — filling *one* `epochIn` is the point.

### Expect the ETH-241 wedge at higher levels

Driving both halves to saturation is precisely the case that wedged the r7 soak:
a packed inbound envelope plus a backlogged outbound queue needed ~93.6M gas in
one `epochIn` against a 30M block limit (`OPP.emitOutboundEnvelope` does an
O(remaining) storage shift plus a full-envelope SSTORE). Against an unpatched
Ethereum outpost, `heavy`/`saturating` duplex runs are expected to stall the
epoch rather than report saturation — that is the defect reproducing, not a
harness fault. Use `light`/`moderate` to exercise the path below the cliff.

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
