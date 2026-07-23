# flow-yield-distribution

Validates the cross-chain yield-distribution path end-to-end against a
fresh cluster:

```
MockYieldEmitter.sol::emitYield          (ETH outpost — Solidity fake)
liqsol_core::dev_seed_staker_yield       (SOL outpost — seed yield state, dev build)
liqsol_core::flush_staking_yield         (SOL outpost — program packs the reward)
  → STAKING_REWARD into the outbound buffer
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

## Solana side note

The SOL side drives the folded `liqsol_core` outpost's REAL yield pipeline
rather than hand-injecting a synthetic attestation: `SolanaYieldEmitterTool`
seeds a staker's on-chain yield state via the dev-only
`liqsol_core::dev_seed_staker_yield` (compiled under `--features development`),
then cranks `liqsol_core::flush_staking_yield` so the program itself packs the
`StakingReward` into the outbound buffer — the exact path a production
yield-aware Solana contract exercises. Both instructions are signed by the SOL
outpost deployer keypair (`global_config.admin`, which is also the flush
`cranker`). Because the program derives its own reward ref, the depot row is
matched by the staker's native SOL address (not a fixed `external_epoch_ref`).

Requires the `--features development` `liqsol_core` build (wired into the e2e
gate by wire-solana's `BUILD.bazel`), since a plain `anchor build` omits
`dev_seed_staker_yield` from both the `.so` and the IDL.

The ETH side still stands up `MockYieldEmitter.sol` as a separate fake because
StakingManager.sol is currently a rename-only placeholder with no
STAKING_REWARD path.

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
