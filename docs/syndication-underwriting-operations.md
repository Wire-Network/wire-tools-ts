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
the `create` command. Either way, it adds the following to each batch operator's
full daemon configuration, including the generated `start.sh`:

```text
--batch-underwriter-account <that operator's WIRE account>
--batch-underwriter-max-exposure '10.000000000 LIQSOL'
--batch-underwriter-max-exposure '10.000000000 LIQETH'
```

With `--external-outpost-config`, the operator nodes started during `create` are
**sync-only**: neither the relay nor the underwriter runs, even when underwriting
is enabled in the saved configuration. After bootstrap and the deployment's
outpost setup are complete, launch the generated operator `start.sh` scripts
through the deployment's services, or relaunch the saved cluster with
`wire-cluster-tool run --cluster-path <cluster-path>`. Those launch paths load the
full daemon configuration. The enable flag alone does not start underwriting
against external outposts.

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

**Supply capital separately.** Enabling the role configures the daemon; supply
its LIQ separately.
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

## Production launch

The launch plan supplies underwriting capital in two stages: a funding party
syndicates real LIQ before launch, then transfers the resulting liquid shadow LIQ
to each batch operator shortly after the WIRE network comes online. The initial
capital comes from the launch import; subsequent user syndications use the normal
underwriting path.

Record the following in the approved launch allocation plan. Replace the example
caps above with the agreed production values; all shadow-LIQ amounts use nine
decimal places.

| Launch input | Value to fill in |
|---|---|
| Funding WIRE account and transfer permission | `<FUNDER_WIRE_ACCOUNT>@<FUNDER_PERMISSION>` |
| Funder's external identities used for pre-launch syndication | `<FUNDER_ETHEREUM_PUBKEY>`, `<FUNDER_SOLANA_PUBKEY>` |
| Recipient accounts | `<BATCH_OPERATOR_WIRE_ACCOUNT>` for every batch operator |
| Initial funding per operator, per enabled token | `<LIQSOL_ALLOCATION>`, `<LIQETH_ALLOCATION>` |
| Exposure caps per operator, per enabled token | `<LIQSOL_MAX_EXPOSURE>`, `<LIQETH_MAX_EXPOSURE>` |
| Funding owner and completion target after WIRE startup | `<FUNDING_OWNER>`, `<FUNDING_COMPLETION_TARGET>` |

Use the on-chain WIRE account names from the launch roster
([`wire-opreg-bootstrap.json`](outpost/README.md)). Inventory and exposure caps are
separate: an account can hold
more LIQ than its cap, but a request's whole remaining coverage must fit both its
available balance and its unused cap.

### Before WIRE goes online

1. **Include the seed capital in the frozen launch exports.** The funder
   syndicates the agreed LIQ on the production outposts before the export cutoff,
   using external identities they can link to their funding WIRE account. Verify
   those positions and amounts are present in the exports used for the launch.
   Reconcile the real outpost custody and booked-custody inputs through the
   production outpost handoff. External-outpost bootstrap validates its supplied
   configuration and import plan; it does not fund live outpost custody.
2. **Import and configure during depot bootstrap.** Follow
   [production bootstrap](production-bootstrap.md), including the frozen
   launch-data import and the production `sysio.bond` / `sysio.synd` pair rules.
   Complete `importsynd` and `importdone` in the epoch-zero import window. This
   path credits pre-launch positions without creating underwriting requests, so
   it can supply the first capital before any operator has bonded a request.
   A position whose external key is already linked is credited to that WIRE
   account; otherwise it is parked for delivery after linking.
3. **Prepare the operators' underwriting role.** For a fresh depot against real
   outposts, use `--external-outpost-config` and explicitly enable
   `--enable-batch-operator-underwriting`. Encode the approved per-token caps in
   `batchOperatorUnderwriting.maxExposure` with the options-file codec above,
   and set `fundedOperatorCount: 0`; actual production funding follows the
   transfers below. Keep
   `--underwriter-count 0` and omit the mock-import and mock-pool flags. Configure
   each operator's signing permission, outpost clients and verification
   artifacts as described under [Existing testnet](#existing-testnet). Complete
   the external outposts' roster handoff using the depot's emitted launch roster
   before relaying production traffic. Use the bootstrap's existing first-epoch
   initialization; this funding procedure needs no second epoch bootstrap.

### Shortly after WIRE goes online

1. **Make the funder's imported LIQ liquid.** Provision the funding WIRE account
   and link the external identities that hold the pre-launch positions. If the
   import was parked, `sysio.authex::createlink` triggers delivery through
   `sysio.synd::linkswept`; `sysio.synd::sweep` can deliver remaining eligible
   parked credit. Verify the funding account's liquid `sysio.liq::accounts`
   balances before sending allocations. The initial inventory must be available
   independently of new post-launch syndications that need underwriting.
2. **Keep the relay services running during funding.** Launch the deployed
   operator services with their approved underwriting configuration. An enabled
   underwriter with no liquid inventory waits; the relay can still perform its
   scheduled deliveries. Confirm the Andon cord is clear for the planned LIQ
   transfers. Treat completion of operator funding as a prerequisite for opening
   normal public syndication.
3. **Transfer each allocation from the funder to the operator.** Use
   `sysio.liq::transfer`, signed by the funder's transfer permission. Repeat this
   template for every operator and every token it will underwrite, substituting
   the approved amount and either `LIQSOL` or `LIQETH`:

   ```bash
   clio -u "$WIRE_RPC" push action sysio.liq transfer \
     '{"from":"<FUNDER_WIRE_ACCOUNT>","to":"<BATCH_OPERATOR_WIRE_ACCOUNT>","quantity":"<AMOUNT_WITH_9_DECIMALS> <LIQ_TOKEN>","memo":"Production underwriting capital"}' \
     -p "<FUNDER_WIRE_ACCOUNT>@<FUNDER_PERMISSION>"
   ```

   These transfers move existing shadow LIQ into the operator's liquid account.
   Retain each transaction ID and reconcile its amount against the allocation
   plan. If the role and caps are already loaded, its next successful poll can
   use the received balance without a restart.

### Launch acceptance

Rehearse the handoff on staging before launch. On production, verify the planned
funding with read-only queries:

```bash
clio -u "$WIRE_RPC" get table sysio.liq accounts -S "<FUNDER_WIRE_ACCOUNT>"
clio -u "$WIRE_RPC" get table sysio.liq accounts -S "<BATCH_OPERATOR_WIRE_ACCOUNT>"
```

For every operator and enabled token, confirm its funding transaction and liquid
balance, deployed exposure cap and signing configuration. Once bonding
starts, reconcile received capital against both the remaining liquid balance and
capital committed to unclaimed bonds. Confirm the funder's total debit equals
the allocations sent, and reconcile its remaining LIQ against its starting
liquid balance. Keep native ETH/SOL relay fee balances and operator collateral
separately accounted for. After funding is confirmed, observe the first real
syndication requests using the
read-only checks below: requests bond, destination credits are released, and
approvals and claims follow after the configured challenge window.

If seed credit is missing, still parked, or insufficient, resolve the capital
handoff before declaring underwriting ready. Track any requests created during
the funding interval against the outpost record-retention window; late funding
cannot recreate an expired envelope record. Use the recovery guidance below for
unverifiable or challenged requests.

## Existing testnet

First inspect the saved `cluster-config.json`: `batchOperatorUnderwriting: null`
means relay-only. Inspect the actual deployed `start.sh`, service argv and
`config.ini` as well; the running process is authoritative. Check the operator
logs for underwriting startup or skip messages. An old package or startup script
does not acquire the role merely because newer source has been deployed elsewhere.

1. Give each intended underwriting account liquid `sysio.liq` inventory. OPP
   syndication requests are issued by privileged `sysio.synd`, so the
   issuer-based payer for their `bonds` rows is the `sysio` RAM pool. These
   underwriters need no extra bond-row RAM grant or node-owner resource policy.
   CPU/NET are billed to the contract.
2. Add these settings to each intended operator's deployed `config.ini`, or the
   equivalent flags to its service command:

   ```ini
   batch-underwriter-account = <operator WIRE account>
   batch-underwriter-max-exposure = 10.000000000 LIQSOL
   batch-underwriter-max-exposure = 10.000000000 LIQETH
   ```

   Include only the tokens the account is funded and authorized to cover. Keep
   its WIRE signature provider and an outpost RPC client for every active outpost
   chain configured. For Ethereum, the OPP ABI must declare `outboundEnvelopes`;
   for Solana, the `liqsol_core` IDL must declare `EnvelopeLog`. A relay-compatible
   artifact alone does not establish that the underwriter can read retained
   envelope digests. Verification trusts the configured outpost RPC reads. When
   underwriting runs on a separate node, use RPC endpoints independent of the
   batch operators' endpoints; when both roles share a node, they share its
   configured outpost clients. The signer must satisfy the named
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
   clio -u "$WIRE_RPC" get table sysio.bond requests -S sysio.bond
   clio -u "$WIRE_RPC" get table sysio.bond bonds -S sysio.bond
   clio -u "$WIRE_RPC" get table sysio.synd envelopes -S sysio.synd
   clio -u "$WIRE_RPC" get table sysio.liq accounts -S "$OPERATOR"
   ```

   Paginate when the response has more rows. For requests, inspect `issuer`,
   `token_code`, `covered`, `bonded` and `state`; the KV response may wrap rows in
   `value`. Verify final liquid or parked destination credit as appropriate,
   then actual wallet credit after linking a parked recipient.

## Timing and troubleshooting

The underwriter polls at `--batch-epoch-poll-ms` (15 seconds by default). It
pushes `sysio.synd::crank` each poll while an envelope request is in play or has
an outcome syndication has not acknowledged; otherwise, it cranks every five
minutes. A new syndication arriving while idle may therefore wait about that
idle crank interval, plus polling and processing time, for a request to be
issued. Approval waits for the challenge window by chain time, and claiming
follows on a later poll. Pruning and
forfeited-bond yield housekeeping run every ten minutes. These intervals do not
guarantee completion when transactions or outpost reads fail.

If an enabled, funded operator still waits beyond the expected cadence, inspect
its logs for a pulled Andon cord, cap exhaustion, signer
failure, or an unreadable/mismatched outpost envelope digest. Also check for the
log message
`underwriter stops bonding until the node is restarted`: if one of the node's
bonds is ruled `INVALID` while it runs, it stops new bonding until restart.
Approvals and claims for existing bonds continue when otherwise eligible; the
forfeited principal is not returned. Investigate the ruling and its cause before
restarting the underwriting service. A restart permits new bonding again; it
does not reverse the ruling or restore lost principal.

Verification uses the outpost's retained record:
Solana keeps only the last 10 envelope records, so an old request may already be
unverifiable by the time configuration is repaired. Missing records require
governance investigation and resolution; restarting does not recreate them.

## Before replacing an outpost deployment

Before governance calls `sysio.chains::setoutpost` to replace an active outpost's
deployment, let that chain's `sysio.synd` envelopes drain, including envelopes
still waiting for an underwriting request. Confirm there is no pending envelope
whose verification depends on the old deployment's retained records. The
underwriter follows the registry to the new deployment and reads its records;
it does not recover an old envelope digest from the previous deployment.
Changing addresses or restarting the node cannot make that old statement
verifiable against the new deployment. If pending envelopes cannot drain, resolve
them through governance before switching deployments.

The plugin's [underwriter documentation](https://github.com/Wire-Network/wire-sysio/blob/master/plugins/batch_operator_plugin/README.md#underwriter)
describes verification, permissions, timing and halt conditions in more detail.
