# flow-lco-import

Exercises the launch-data (LCO) import: the bootstrap replays each outpost's frozen
pre-launch export during epoch zero, and the flow proves every imported value reaches its
holder. Every write is a Report Step; depot confirmations wait for irreversibility.

0. Pre-bootstrap stage (`prepare`, before the cluster is composed): generate each holder's
   random key — an Ethereum wallet through the `KeyGenerator` facade, a Solana keypair — and
   persist it under the holder's durable handle in the cluster data directory; then write
   both exports under `<cluster>/data/lco-import/` from the committed templates
   (`WireLcoExportTool.writeExports`, the harness's template rewrite that
   `flow-batch-operator-prefunding` shares), with the persisted keys in place of the
   templates' placeholders, and point the bootstrap's import at them
   (`ethereumBootstrapJsonFile` / `solanaBootstrapJsonFile`).
1. Verify the import landed: the exports name the holders' persisted keys (read back by
   handle), the record (`lco-import-bootstrap-platform-config.json`) matches the plan, every
   staker position is parked under its pubkey, every claim is unmapped under its native
   address, and each LCO pool holds its seeds at its fee with its shadow as the yield leg.
2. Create each holder's WIRE account and link each holder's persisted key with
   `createlink`. Verify the link delivered each staker's position as liquid LIQ and moved
   every claim to pending.
3. Each holder claims its WIRE through `sysio.dclaim::claim`. Verify it holds exactly its
   claim.
4. The Solana staker sells one WIRE into the LIQSOL pool with an exchange-memo transfer.
   Verify the WIRE went into the pool, the LIQSOL came out of it, and the product grew.
5. Verify the emergency cord is clear and `sysio.synd` records no custody mismatch.

## Bootstrap defaults

The scenario sets every `lcoImport` value (prices, pool tuning, claim funding account), so
the import takes no placeholder; the highest tranche price rides each export. The export
files themselves are not defaults: `prepare` writes them per cluster and sets
`ethereumBootstrapJsonFile` / `solanaBootstrapJsonFile` on the options the bootstrap
composes with. The import runs inside the bootstrap; nothing seeds from `plan()`.

## Fixture holders

Every holder's key is RANDOM — nothing derives from a mnemonic, a seed or an index. The key
is generated once per cluster, persisted under the holder's handle
(`<cluster>/data/eth-<handle>-wallet.json` / `sol-<handle>-keypair.json`), and read back by
that handle wherever the flow needs it: the verify steps, the `createlink` steps.

| Holder | Chain | Key handle | In the export |
|---|---|---|---|
| `lcoethstaker` | Ethereum | wallet `lco-ethereum-staker` | 2 liqETH staked, 0.5 pretoken yield, 1.5 pretokens bought |
| `lcoethbuyer1` | Ethereum | wallet `lco-ethereum-purchaser` | 4 pretokens bought with 1 liqETH |
| `lcosolstaker` | Solana | keypair `lco-solana-staker` | 4 liqSOL syndicated, 2.5 pretoken yield |
| `lcosolbuyer1` | Solana | keypair `lco-solana-purchaser` | 10 pretokens bought with 2 liqSOL |

The Ethereum booked custody is 3.1 liqETH, so its pool seeds 1.1 liqETH. The Solana pool seeds
exactly the 2 liqSOL spent on pretokens; the 6.5 liqSOL backing also holds 0.5 of slack, which is
not minted. The holders only sign their links, so they hold no ETH or SOL.

## Export templates

The committed exports under `resources/` are templates. Each row carries a placeholder
identity, named per holder by `LcoImportScenarioConstants.<Holder>.templateAddress`;
`prepare` rewrites every row naming that placeholder — a staker's address and recovered
pubkey, a purchaser's address, a Solana balance's address — to the holder's persisted key,
recomputes the Solana export's `allocationHash` over the rewritten balances, and writes the
result. Amounts and metadata are the templates'. Changing a template row's placeholder
requires updating the matching `templateAddress`; a row no holder claims fails `prepare`.

## Single-shot per cluster

Run the flow against a new cluster path: the import and its seals are epoch-zero only.
