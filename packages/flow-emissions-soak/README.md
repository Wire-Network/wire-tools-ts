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
3. **seed → link → claim** — the cluster bootstraps with
   `ethereumDeployment: ladder`, so `sysio.dclaim` is seeded from the
   frozen pre-launch Ethereum outpost through capital-index, as at launch.
   Each pre-launch buyer (the harness holds its key) links its Ethereum key
   to a new WIRE account → `sysio.authex` inline-calls
   `sysio.dclaim::linkswept` → its `unmapped_tokens` row sweeps into
   `pending_claims` → `claim` pays it exactly the WIRE the import seeded.

## What it does NOT verify

- **Pre-funding of `sysio.dclaim`.** At production launch the dclaim
  account is credited with the pre-launch capital allocation up-front.
  This soak replicates that with an in-flow `sysio.token::transfer`
  from `sysio` to `sysio.dclaim` of exactly the claimants' seeded credits.
- **Solana pretoken seeds.** The ladder import is Ethereum-only; no
  `CHAIN_KIND_SVM` batch is imported.

## Prerequisites

Same as the other flow packages — see the repo-root README for the
`anvil`, `solana-test-validator`, and wire-sysio build dependencies.

## Test data

No committed fixtures and no call to the Wire Foundation index. The seed
is whatever the pre-launch exercise did on the cluster's own anvil
(`EthereumPreLaunchSteps`: stakers stake liqETH, buyers buy pretokens),
replayed by `@wireio/opp-snapshot` exactly as the capital indexer replays
mainnet. The buyers' pretokens are the credits this flow claims.

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
  --solana-path     ../wire-solana

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

## Status

**Scaffold only.** The bootstrap wiring (`ClusterManager.ts` Phase 15b/c)
is in place; the seed + sample-claim test bodies are stubbed as `it.todo`
pending the regen of `@wireio/sdk-core` types against the
post-PR-354 wire-sysio ABIs (`sysio.system::setemitcfg`,
`sysio.dclaim::*`).

The `convertImportSeed` helper has full unit-test coverage in this file
that runs independently of the cluster.
