# flow-yield-distribution

Validates the cross-chain yield-distribution path end-to-end against a
fresh cluster:

```
MockYieldEmitter.sol::emitYield     (ETH outpost — Solidity fake)
opp_outpost::add_attestation        (SOL outpost — existing CPI target)
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

## Solana side note

Production-shaped Solana yield will eventually live in a separate
liqsol-side staking contract that CPI-calls
`opp_outpost::add_attestation`. We skip standing up a separate Anchor
program here because `add_attestation` is already the exact CPI target
— the test signs as the outpost's deployer authority (the
`OutpostConfig.authority` set during Phase 10b bootstrap) and routes
attestations through that path directly. The ETH side stands up
`MockYieldEmitter.sol` as a separate fake because StakingManager.sol is
currently a rename-only placeholder with no STAKING_REWARD path.

## Running

```bash
WIRE_BUILD_PATH=$HOME/code/wire/wire-sysio/build \
WIRE_ETH_PATH=$HOME/code/wire/wire-ethereum \
WIRE_SOLANA_PATH=$HOME/code/wire/wire-solana \
pnpm -F @wireio/test-flow-yield-distribution test
```

Chain data: `/mnt/data/wire-e2e-soak/flow-yield-distribution-<timestamp>/`.
