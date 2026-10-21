# flow-lco-import

Exercises the launch-data (LCO) import: the bootstrap replays each outpost's frozen
pre-launch export during epoch zero, and the flow proves every imported value reaches its
holder. Every write is a Report Step; depot confirmations wait for irreversibility.

1. Verify the import landed: each holder's export rows name the flow's own keys, the
   record (`lco-import-bootstrap-platform-config.json`) matches the plan, every staker
   position is parked under its pubkey, every claim is unmapped under its native address,
   and each LCO pool holds its seeds at its fee with its shadow as the yield leg.
2. Create each holder's WIRE account, persist the Solana holders' seeded keys, and link
   each holder's key with `createlink`. Verify the link delivered each staker's position as
   liquid LIQ and moved every claim to pending.
3. Each holder claims its WIRE through `sysio.dclaim::claim`. Verify it holds exactly its
   claim.
4. The Solana staker sells one WIRE into the LIQSOL pool with an exchange-memo transfer.
   Verify the WIRE went into the pool, the LIQSOL came out of it, and the product grew.
5. Verify the emergency cord is clear and `sysio.synd` records no custody mismatch.

## Bootstrap defaults

The scenario sets `ethereumBootstrapJsonFile` / `solanaBootstrapJsonFile` to the committed
exports under `resources/` and sets every `lcoImport` value (prices, pool tuning, claim
funding account), so the import takes no placeholder. The highest tranche price rides each
export. The import runs inside the bootstrap; nothing seeds from `plan()`.

## Fixture holders

| Holder | Chain | Key | In the export |
|---|---|---|---|
| `lcoethstaker` | Ethereum | anvil HD wallet `AccountCount + 1` | 2 liqETH staked, 0.5 pretoken yield, 1.5 pretokens bought |
| `lcoethbuyer1` | Ethereum | anvil HD wallet `AccountCount + 2` | 4 pretokens bought with 1 liqETH |
| `lcosolstaker` | Solana | seed `flow-lco-import:solana-staker` | 4 liqSOL syndicated, 2.5 pretoken yield |
| `lcosolbuyer1` | Solana | seed `flow-lco-import:solana-purchaser` | 10 pretokens bought with 2 liqSOL |

The Ethereum booked custody is 3.1 liqETH and the Solana backing 6.5 liqSOL, so the pools
seed 1.1 liqETH and 2.5 liqSOL. Changing a holder's key derivation requires regenerating
its rows in `resources/`; the first verify step fails otherwise.

## Single-shot per cluster

Run the flow against a new cluster path: the import and its seals are epoch-zero only.
