# flow-emissions-soak

Multi-hour soak: emissions accrual + `sysio.dclaim` import → link → claim
end-to-end.

## What it verifies

1. **Stability** — chain stays synced across WIRE / Ethereum / Solana for
   the configured wall-clock duration, no panics or forks.
2. **Emissions accrual** — every `pay_cadence_epochs` boundary fires
   `payepoch`. Compute / capex / governance accounts receive their bps
   splits. `total_distributed` advances monotonically and stays bounded
   by `t5_distributable - t5_floor`.
3. **importseed → link → claim** — controlled ETH wallets receive additive
   bootstrap credits, complete AuthEx linking, explicitly call
   `sysio.dclaim::linkswept`, and then claim the exact final merged amount.

## What it does NOT verify

- **`sysio.system::fundclaim` cap semantics from PR 354.** That code path
  fires only on `sysio.dclaim::onreward`, which is driven by
  STAKING_REWARD attestations arriving from the outposts. As of writing,
  wire-ethereum `StakingManager.sol` is a rename-only placeholder
  (`revert()` bodies); outpost reward emission is on a separate
  developer track. A companion exhaust flow will be added in a follow-up
  PR once that emission track lands.

  `capital_shortfall_total` is asserted to stay at `0` in this soak —
  trivially true today because no `fundclaim` calls occur.

- **Pre-funding of `sysio.dclaim`.** At production launch the dclaim
  account is credited with the pre-launch capital allocation up-front.
  This soak replicates that with an in-test `sysio.token::transfer`
  from `sysio` to `sysio.dclaim` sized to cover the controlled-staker
  claim load. The bulk rows (and the SOL slice) sit in
  `unmapped_tokens` for the duration of the run; they're verified at
  import-time but never claimed.

## Prerequisites

Same as the other flow packages — see the repo-root README for the
`anvil`, `solana-test-validator`, and wire-sysio build dependencies.

## Test data

This flow never fetches the Wire Foundation index at run time and does not
commit production dumps. For each chain independently it consumes a supplied
bootstrap file when present; otherwise it generates a deterministic indexer
dump matching the shape returned by:

- `https://index.wire.foundation/opp/balances` (ETH)
- `https://index.wire.foundation/opp/solana/balances` (SOL)

The flow-owned contribution includes:

- Controlled ETH stakers (test holds the wallets), added atomically after
  configured/synthetic conversion and before the shared merge and batching.
  If a configured dump contains the same address, its amount is additive and
  all claim/prefund expectations derive from the final merged result.
- Bulk purchasers + stakers with overlapping addresses and partial
  `yieldClaimed` rows when Ethereum uses synthetic fallback.
- A Solana bulk slice — verifies `importseed` accepts CHAIN_KIND_SOLANA
  batches when Solana uses synthetic fallback. (No SVM link/claim today.)

Generation is deterministic given `SYNTHETIC_SEED` (default `1`). Bump
the seed via env to surface non-deterministic bugs across runs.

## Running

Like every flow, run it with the canonical runner + heartbeat monitor pair
(see the repo README's "Running flows" / "Monitoring a live flow run" and
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`):

```bash
# From the wire-tools-ts root — default soak window:
node scripts/run-flow.mjs flow-emissions-soak \
  --cluster-path    /tmp/wire-flow-soak \
  --wire-build-path ../wire-sysio/build/release \
  --ethereum-path   ../wire-ethereum \
  --solana-path     ../wire-solana \
  -- \
  --ethereum-bootstrap-json-file /secure/prelaunch/ethereum.json \
  --solana-bootstrap-json-file   /secure/prelaunch/solana.json

# In a second terminal — the mandatory six-probe heartbeat:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-soak

# Override the soak duration (flow-specific knob, env-only):
SOAK_DURATION_MS=$((30 * 60 * 1000)) node scripts/run-flow.mjs flow-emissions-soak …
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `SOAK_DURATION_MS` | `1800000` (30 min) | Soak duration in milliseconds. |
| `EPOCH_DURATION_SEC` | `60` | Epoch duration passed to sysio.epoch::setconfig. |
| `WIRE_CLUSTER_PATH` | (fresh temp dir per run) | Cluster data directory (the standard harness contract; seeds `--cluster-path`). |
| `WIRE_BUILD_PATH` | (required) | Path to the wire-sysio build directory (seeds `--wire-build-path`). |
| `SYNTHETIC_SEED` | `1` | Seed for the synthetic dump PRNG (deterministic). |
| `CONTROLLED_STAKER_COUNT` | `5` | Number of test-owned ETH wallets driving the link/claim path. |
| `BULK_ETH_PURCHASERS` / `BULK_ETH_STAKERS` / `BULK_ETH_OVERLAPPING` / `BULK_ETH_YIELD_CLAIMED` | `40`/`40`/`8`/`8` | Synthetic ETH bulk-row counts. |
| `BULK_SOL_PURCHASERS` / `BULK_SOL_STAKERS` | `20`/`20` | Synthetic SOL fallback bulk-row counts. |

## Status

Implemented as a live flow. Conversion, merge, batching, and runner forwarding
are covered by harness/script unit tests; end-to-end chain behavior is validated
by this flow under the canonical runner and heartbeat monitor.
