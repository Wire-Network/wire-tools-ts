# flow-batch-operator-prefunding

Proves the pre-funded launch end to end on a local cluster under KEY custody: the
bootstrap batch operators' keys exist BEFORE the cluster, the outposts' frozen launch-data
exports carry each operator's positions under those keys, the bootstrap ADOPTS exactly
those keys instead of generating any, the import credits each operator, and a pre-funded
operator underwrites a user's Ethereum syndication from the first epochs. Every write is a
Report Step; depot confirmations wait for irreversibility.

0. Pre-bootstrap stage (`prepare`, before the cluster is composed):
   - pre-create the three bootstrap batch operators' identities
     (`BatchOperatorKeyTool.createPersisted`): a random WIRE K1, Ethereum EM and Solana ED
     key each, through the `KeyGenerator` facade, persisted under the operator's label handle
     in the cluster data directory (`<cluster>/data/wire-batchop.a-key.json`,
     `eth-batchop.a-wallet.json`, `sol-batchop.a-keypair.json`); a re-run reads them back;
   - write both exports under `<cluster>/data/lco-import/` from the committed templates
     (`WireLcoExportTool.writeExports`): each Ethereum staker row takes an operator's EM
     address and compressed pubkey, each Solana balance row an operator's ED key, and the
     Solana `allocationHash` is recomputed;
   - return the options with `ethereumBootstrapJsonFile` / `solanaBootstrapJsonFile` set and
     `signatureProvider.batchOperatorKeyPolicy: adoptOnly`.
1. The context (`createContext`) seeds the persisted identities into `ctx.keyStore`. The
   bootstrap's `OperatorKeys` phase adopts them whole
   (`WireOperatorProvisioningTool.runIdentityMaterialization`: an identity the context already
   holds is never regenerated), seats their Ethereum addresses in the outpost roster, parks
   each operator's imported positions under its keys (`LcoImport`), creates the accounts
   under the adopted K1s, links both outpost keys (which sweeps the parked positions into
   the operators' own LIQETH and LIQSOL), registers the operators, and verifies the credit
   (`LcoImportOperatorCredit`, composed only for `adoptOnly` with an import).
2. `PrefundedIdentities`: one verify Step per operator — the keys in `ctx.keyStore` after
   the bootstrap are the persisted ones (WIRE, Ethereum key and address, Solana), read back
   from disk by handle.
3. `PrefundedOperatorLinks`: one verify Step per operator — `sysio.authex::links` holds its
   Ethereum and its Solana key under its account.
4. `PrefundedOperatorCredits`: one verify Step per operator — its `sysio.liq` LIQETH and
   LIQSOL balances are positive (`WireSyndicationTool.readLiqBalance`).
5. `EthereumSyndication`: an independent user (`prefund.user`, a random persisted wallet)
   is created, funded through the anvil faucet, links its wallet, deposits ETH for liqETH,
   approves the syndication pool and syndicates 2 LIQETH to its linked account — the same
   stimulus `flow-syndication-plugin-underwriting` drives
   (`BatchOperatorUnderwritingSteps.planEthereumSyndication`).
6. `PrefundedUnderwriting`: the operators' crank issues the request; the pre-funded
   operators bond its whole coverage from their imported LIQETH within their caps; after the
   challenge window the request is APPROVED and every bond paid back. Budgets derive from
   `ProtocolTiming` (`UnderwriterRequestIssuedOptions`, `SyndicationScenario.VerifyOptions`).
7. `PrefundedHealthy`: the emergency cord is clear and `sysio.synd` records no custody
   mismatch.

## Bootstrap defaults

`enableBatchOperatorUnderwriting: true` with every operator funded under the default caps
(10 LIQSOL, 10 LIQETH); 3 producers, 3 batch operators, no standalone underwriters; 60 s
epochs; the import's pricing, pool tuning and claim funding set explicitly (the dev values
the import would otherwise take as placeholders). The mock syndication import and the mock
LIQ pools stay OFF: the launch-data import is the operators' only shadow credit, so the
bonds it funds are the pre-funding's. The export files are not defaults: `prepare` writes
them per cluster.

## How it maps to the real launch

| Real launch (`wire-cluster-tool`) | This flow |
|---|---|
| `create-batch-operator-keys` pre-creates each operator's K1/ED in SSM and EM in SSM or KMS | `prepare` → `BatchOperatorKeyTool.createPersisted` persists the same three curves by handle under KEY custody |
| the listed addresses are funded on each outpost and their positions frozen into the exports | `prepare` → `WireLcoExportTool.writeExports` rewrites the committed templates with the operators' keys (4 liqETH staked and 0.5 pretoken of yield each; 4 liqSOL syndicated and 1 liqSOL spent on 5 pretokens each) |
| `create … --signature-provider-batch-operator-key-policy adoptOnly --ethereum-bootstrap-json-file … --solana-bootstrap-json-file …` | `prepare` returns those options; `createContext` seeds the persisted identities the bootstrap adopts |
| the operators' daemons underwrite from the first epoch (`fund-batch-operators` funded their gas) | the bootstrap's fee-payer funding steps; the user's syndication is bonded by a pre-funded operator |

## Negative control

With `adoptOnly`, a batch operator whose identity was NOT pre-created fails the bootstrap
instead of being minted a replacement that the outposts never funded. This flow runs only
the positive path; the refusal is covered in two places, without a flow-level negative run:

- `KeySteps.assertKeyCreatable` — unit-tested in `packages/cluster-tool/tests/orchestration/steps/KeySteps.test.ts`:
  under `adoptOnly` a bootstrap batch operator with no adoptable key fails the step naming
  the id, while every other identity still creates.
- `BatchOperatorKeyTool.loadPersisted` — unit-tested in
  `packages/cluster-tool/tests/tools/wire/BatchOperatorKeyToolPersisted.test.ts`: a handle
  `prepare` did not persist throws, so this scenario's `createContext` fails before anything
  is composed.

## Export templates

The committed exports under `resources/` are templates. Each Ethereum staker row and each
Solana balance row names a placeholder identity, mapped per operator by
`BatchOperatorPrefundingScenarioConstants.OperatorTemplates`; `prepare` rewrites every row
naming a placeholder to the operator's persisted key and recomputes the Solana export's
`allocationHash`. Amounts and metadata are the templates'. The Ethereum booked custody is
13 liqETH (12 staked plus 1 of pool seed); the Solana pool seeds exactly the 3 liqSOL spent
on pretokens, and its 16 liqSOL backing holds 1 of slack, which is not minted. Changing a
template row's placeholder requires updating the matching `OperatorTemplates` entry; a row
no operator claims fails `prepare`.

## Running

Run the canonical pair (the runner in a background shell with a log, the monitor armed
alongside it; no `--expect-freeze`):

```sh
node scripts/run-flow.mjs flow-batch-operator-prefunding \
  --cluster-path <fresh-cluster-path> \
  --wire-build-path <wire-sysio>/build/release \
  --ethereum-path <wire-ethereum> \
  --solana-path <wire-solana>
node scripts/flow-heartbeat-monitor.mjs --cluster-path <same-cluster-path>
```

Run it against a new cluster path: the import and its seals are epoch-zero only. The run
requires a nodeop built with the `batch_operator_plugin` underwriter role. The Report under
`<cluster>/reports/` is the assertion record; this package has no test suite of its own —
the harness symbols it composes are unit-tested in `packages/cluster-tool/tests/`.
