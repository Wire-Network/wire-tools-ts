# Enable automatic syndication underwriting

OPP delivery and syndication underwriting are separate roles. Successful delivery
does not mean a batch operator will bond the resulting `sysio.bond` request.
`create` configures the contracts. Against local outposts it also forces automatic
underwriting on; with `--external-outpost-config` the role defaults to **off**.
The role lives in `batch_operator_plugin`; `underwriter-count` is the retired swap
daemon count and must remain zero.

## New clusters

A local `create` (no `--external-outpost-config`) forces
`--enable-batch-operator-underwriting` on. Against external outposts, add the flag to
the `create` command. Either way, it grants each batch operator RAM for bond rows and
adds the following to its runtime arguments, including the generated `start.sh`:

```text
--batch-underwriter-account <that operator's WIRE account>
--batch-underwriter-max-exposure '10.000000000 LIQSOL'
--batch-underwriter-max-exposure '10.000000000 LIQETH'
```

The default caps cover **both LIQSOL and LIQETH**. For other caps, supply a
`--cluster-build-options-file` document. Generate the document from the tools repo
so token codes and bigint amounts use the same codec as the CLI:

```bash
node <<'NODE'
const fs = require('node:fs')
const { SlugName } = require('@wireio/sdk-core')
const { TokenAmount } = require('@wireio/opp-typescript-models')
const cap = token => TokenAmount.toJson(TokenAmount.create({
  tokenCode: BigInt(SlugName.from(token)), amount: 10_000_000_000n
}))
fs.writeFileSync('underwriting-options.json', JSON.stringify({
  enableBatchOperatorUnderwriting: true,
  batchOperatorUnderwriting: {
    fundedOperatorCount: 0,
    maxExposure: ['LIQSOL', 'LIQETH'].map(cap)
  }
}, null, 2) + '\n')
NODE
```

This example allows at most 10 tokens of outstanding coverage per token per
operator, both at the depot's **9-decimal shadow precision**. Choose caps for the
expected coverage across the challenge window and claim delay. The plugin must
be able to bond a request's whole remaining coverage within both its cap and its
spendable balance; a smaller cap leaves it waiting.

**Supply capital separately.** Enabling the role grants resources, not LIQ.
`fundedOperatorCount` controls only epoch-zero mock imports; it does not transfer
real capital. Each underwriting account needs liquid `sysio.liq` balances in every
token it covers. WIRE collateral, native SOL/ETH fee balances, parked credits, and
funds still held by a pending syndication are not that inventory. Fund operators
from already liquid shadow balances or reconciled launch imports. A first deposit
cannot supply the capital needed to underwrite itself.

A local `create` also forces `--enable-mock-syndication-import` on, which imports
100 LIQSOL and 100 LIQETH per funded operator and backs
the imported shadow in outpost custody. Omit the example's `fundedOperatorCount: 0`
to fund every operator this way. Each credit uses the operator's matching linked
ED or EM key, and both backing checkpoints run after all imports. Mock seeding
is not a funding procedure for an existing deployed network.

`wire-cluster-tool create` applies this policy itself, so the platform's cluster
Action passes no extra flags: a local-outpost build gets the role, the imports and
the yield pools, and an `--external-outpost-config` build gets none of them forced on
and refuses both mock flags. Both locally bootstrapped outposts must cover the entire
minted shadow supply before operator startup and the first epoch, with Ethereum
principal initialized to the same obligation. Deploy the backed outpost state with its
depot snapshot rather than replacing an outpost with an empty deployment. Andon checks
remain enabled.

## Existing testnet

First inspect the saved `cluster-config.json`: `batchOperatorUnderwriting: null`
means relay-only. Inspect the actual deployed `start.sh`, service argv and
`config.ini` as well; the running process is authoritative. Check the operator
logs for underwriting startup or skip messages. An old package or startup script
does not acquire the role merely because newer source has been deployed elsewhere.

1. Give each intended underwriting account enough RAM for bond rows and liquid
   `sysio.liq` inventory. Bootstrap grants an additional node-owner RAM policy
   with `ram_weight: "25.0000 SYS"`, zero NET/CPU weights, `time_block: 0` and
   `network_gen: 0` via `sysio.roa::addpolicy`, signed by the policy issuer. Use
   the deployment's resource issuer and confirm its available allocation.
2. Add these settings to each intended operator's deployed `config.ini`, or the
   equivalent flags to its service command:

   ```ini
   batch-underwriter-account = <operator WIRE account>
   batch-underwriter-max-exposure = 10.000000000 LIQSOL
   batch-underwriter-max-exposure = 10.000000000 LIQETH
   ```

   Include only the tokens the account is funded and authorized to cover. Keep
   its WIRE signature provider, both outpost RPC clients, Ethereum OPP ABI files,
   and Solana `liqsol_core` IDL configured. The signer must satisfy the named
   permission and be allowed to push `sysio.bond::{accept,approve,claim,prune}`
   and `sysio.synd::{crank,pruneenv}`. With the bootstrap's `active` permission,
   the same WIRE signer serves the relay and underwriting roles.
3. Restart those operator services to load the settings. Run one underwriting
   process per account. Editing only `cluster-config.json` does not change an
   already running process or an already packaged script; keep the persisted
   configuration and future packaging inputs consistent with the deployed caps.
4. Verify requests become bonded, syndication releases reach the destination,
   and approvals and claims follow after the challenge window. Read-only checks:

   ```bash
   clio -u "$WIRE_RPC" get table sysio.bond sysio.bond requests
   clio -u "$WIRE_RPC" get table sysio.bond sysio.bond bonds
   clio -u "$WIRE_RPC" get table sysio.synd sysio.synd envelopes
   clio -u "$WIRE_RPC" get table sysio.liq "$OPERATOR" accounts
   ```

   Paginate when the response has more rows. For requests, inspect `issuer`,
   `token_code`, `covered`, `bonded` and `state`; the KV response may wrap rows in
   `value`. Verify final liquid or parked destination credit as appropriate,
   then actual wallet credit after linking a parked recipient.

If an enabled, funded operator still waits, inspect its logs for a pulled Andon
cord, insufficient RAM, cap exhaustion, signer failure, or an unreadable/mismatched
outpost envelope digest. Verification uses the outpost's retained record:
Solana keeps only the last 10 envelope records, so an old request may already be
unverifiable by the time configuration is repaired. Missing records require
governance investigation and resolution; restarting does not recreate them.
