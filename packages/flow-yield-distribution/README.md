# flow-yield-distribution

Validates the cross-chain yield-distribution path end-to-end against a
fresh cluster:

```
MockYieldEmitter.sol::emitYield     (ETH outpost — Solidity fake)
  → STAKING_REWARD attestation
  → batch operator ferries via OPP envelope
  → sysio.msgch dispatches as
    sysio.dclaim::onreward
      → sysio.system::fundclaim
        → sysio.token::transfer (sysio → sysio.dclaim)
      → credit into sysio.dclaim::pclaims (if AuthEx-linked)
        OR sysio.dclaim::unmapped_tokens (if not yet linked)
```

Asserts:

1. **Reward arrives in pclaims/unmapped.** After a yield emission, a
   pclaim row appears for the linked staker, OR an unmapped row for the
   unlinked staker.
2. **Fundclaim caps fire correctly.** `sysio` balance decreases by
   `min(emission, accounting_available, balance_available)` — never
   over-spending. `t5_state.capital_shortfall_total` accrues when the
   accounting bucket can't cover the credit.
3. **Dedupe.** Re-emitting the same `external_epoch_ref` is a no-op on
   the depot (the dclaim reward-cursor row guards against replay).

## Ethereum only, for now

The flow drives the ETH outpost alone. `MockYieldEmitter.sol` stands in
for a real emitter because `StakingManager.sol` is a rename-only
placeholder with no STAKING_REWARD path.

There is no Solana leg: the SOL staking surface is a separate developer
track and `liqsol_core` emits no STAKING_REWARD, so a SOL leg could only
be a harness-side attestation injection — which the harness no longer
does. It returns when the outpost produces the attestation itself.

## Running

Like every flow, run it with the canonical runner + heartbeat monitor pair
(see the repo README's "Running flows" / "Monitoring a live flow run" and
`wire-platform-manifest/.claude/rules/run-flows-via-canonical-scripts.md`):

```bash
# From the wire-tools-ts root:
node scripts/run-flow.mjs flow-yield-distribution \
  --cluster-path    /tmp/wire-flow-yield \
  --wire-build-path $HOME/code/wire/wire-sysio/build \
  --ethereum-path   $HOME/code/wire/wire-ethereum \
  --solana-path     $HOME/code/wire/wire-solana

# In a second terminal — the mandatory six-probe heartbeat:
node scripts/flow-heartbeat-monitor.mjs --cluster-path /tmp/wire-flow-yield
```

Cluster data lands under `--cluster-path` (env `WIRE_CLUSTER_PATH`); omit it
and the harness generates a fresh temp dir per run.
