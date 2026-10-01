import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  ChainKind,
  DebugOutpostEndpointsType,
  DesyndicateLIQ
} from "@wireio/opp-typescript-models"
import { Asset, SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  SolanaOutpostBootstrapper,
  FlowScenario,
  ProtocolTiming,
  Report,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationUserSteps,
  WireClient,
  WireState,
  WireSyndicationTool,
  containsDesyndicateLIQ,
  containsLIQYield,
  containsSyndicateLIQ,
  outputKey,
  pollUntil,
  readEnvelopeAttestations,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { LIQYieldScenarioConstants as Constants } from "./LIQYieldScenarioConstants.js"

const { SysioContractName, SysioSyndChainkind, SysioSyndItemKind } =
  SysioContracts
const { Actor } = Report

// ── reads (execute freely inside verify steps) ──────────────────────────────

/** `sysio.epoch::epochstate.current_epoch_index` (a read — the depot-liveness metric). */
async function readCurrentEpochIndex(
  ctx: ClusterBuildContext
): Promise<number> {
  const { rows } = await ctx.wire.getEpochState()
  Assert.ok(
    rows.length >= 1,
    "sysio.epoch::epochstate has no row — did the bootstrap's EpochBootstrap run?"
  )
  return rows[0].current_epoch_index
}

/** The base units of an ABI asset string (`"2.000000000 LIQSOL"` → `2000000000n`). */
function assetUnits(quantity: string): bigint {
  return BigInt(Asset.from(quantity).units.toString())
}

/** The user's persisted Solana public key, as the 32 bytes `sysio.synd` parks against. */
function readUserPubkeyBytes(ctx: ClusterBuildContext): Uint8Array {
  return SolanaFundingTool.loadKeypair(
    ctx.config.dataPath,
    Constants.UserKeypairName
  ).publicKey.toBytes()
}

/**
 * The shadow `sysio.synd` has parked against the user's Solana key (base
 * units), `0n` when nothing is parked — the depot's ledger for a syndication
 * whose key is not yet AuthX-linked.
 */
async function readParkedShadow(ctx: ClusterBuildContext): Promise<bigint> {
  const pubkeyHex = Buffer.from(readUserPubkeyBytes(ctx)).toString("hex"),
    row = await WireSyndicationTool.readParked(
      ctx,
      Constants.LIQTokenCodename,
      SysioSyndChainkind.CHAIN_KIND_SVM,
      pubkeyHex
    )
  return row == null ? 0n : BigInt(row.balance)
}

/** The user's own shadow row (scope = the user, key = the shadow symbol), or nothing yet (a read). */
async function readHolding(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioLiqAccountType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.accounts.query({
      scope: Constants.UserAccount,
      limit: Constants.TableQueryLimit
    })
  return rows.find(
    row => Asset.from(row.balance).symbol.name === Constants.LIQTokenCodename
  )
}

/**
 * The shadow's distribution state — the cumulative index, the pot and the carry
 * (a read). The row exists only from the first distribution on; before that it
 * is the zero state the contract itself computes against.
 */
async function readYieldIndex(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioLiqYieldIndexType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.yieldidx.query({
      ...WireClient.symbolCodeKeyRange(
        Constants.SymbolKeyField,
        Constants.LIQTokenCodename
      ),
      limit: 1
    })
  return rows.length === 0 ? Constants.InitialYieldIndex : rows[0]
}

/** Reported yield the depot holds outside supply, not yet queued to the swap (base units; `0n` without a row). */
async function readPendingYield(ctx: ClusterBuildContext): Promise<bigint> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.liqpending.query({
      ...WireClient.symbolCodeKeyRange(
        Constants.SymbolKeyField,
        Constants.LIQTokenCodename
      ),
      limit: 1
    })
  return rows.length === 0 ? 0n : assetUnits(rows[0].quantity)
}

/** The shadow's circulating supply (base units). */
async function readShadowSupply(ctx: ClusterBuildContext): Promise<bigint> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.liq)
    .tables.stat.query({
      ...WireClient.symbolCodeKeyRange(
        Constants.SymbolKeyField,
        Constants.LIQTokenCodename
      ),
      limit: 1
    })
  Assert.ok(
    rows.length === 1,
    `sysio.liq::stat has no ${Constants.LIQTokenCodename} row — the shadow was never opened`
  )
  return assetUnits(rows[0].supply)
}

/** The user's WIRE balance on `sysio.token` (base units; `0n` before any transfer reaches them). */
async function readWireBalance(ctx: ClusterBuildContext): Promise<bigint> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.token)
    .tables.accounts.query({
      scope: Constants.UserAccount,
      limit: Constants.TableQueryLimit
    })
  const row = rows.find(
    account => Asset.from(account.balance).symbol.name === WireSymbolCode
  )
  return row == null ? 0n : assetUnits(row.balance)
}

/** The symbol code of the WIRE token the yield is paid in. */
const WireSymbolCode = "WIRE"

/**
 * WIRE the user is owed on their shadow row at `index`, exactly as
 * `sysio.liq` computes it: the banked `owed_wire` plus the accrual since the
 * row's checkpoint, `balance × (index − checkpoint) / YIELD_INDEX_SCALE`.
 */
function owedWire(
  holding: SysioContracts.SysioLiqAccountType,
  index: bigint
): bigint {
  const accrued =
    (assetUnits(holding.balance) * (index - BigInt(holding.index_checkpoint))) /
    Constants.YieldIndexScale
  return BigInt(holding.owed_wire) + accrued
}

/**
 * Every `DesyndicateLIQ` the depot has queued into a DEPOT_OUTPOST_SOLANA
 * envelope, decoded by its OWN generated message class (a read over the
 * `data/opp-debugging/` artifacts).
 */
async function readCirculatedDesyndications(
  ctx: ClusterBuildContext
): Promise<DesyndicateLIQ[]> {
  return (
    await readEnvelopeAttestations(
      oppDebuggingPath(ctx.config.clusterPath),
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      AttestationType.DESYNDICATE_LIQ
    )
  ).map(payload => DesyndicateLIQ.fromBinary(payload))
}

/**
 * LIQ yield — the reward flow end to end, on the real `liqsol_core` paths and
 * the real depot contracts: with explicit underwriting and release Steps.
 *
 * 1. **SnapshotDepotEpoch** — record `current_epoch_index` BEFORE any write.
 * 2. **ProvisionUser** — the user's WIRE account and their Solana wallet.
 * 3. **Syndicate** — map the liq token, deposit for liqSOL, flip Launching →
 *    PostLaunch, `synd`; `SYNDICATE_LIQ` reaches the depot, which holds the
 *    shadow until its request is bonded; a crank then parks it against the unlinked key.
 * 4. **Link** — the user links that key through `sysio.authex::createlink`;
 *    its inline sweep delivers the parked shadow into the user's own row.
 * 5. **ReportLiqYield** — a bonus donation + the permissionless
 *    `report_liq_yield` crank queue `LIQ_YIELD`; the depot lands it in
 *    a held item, outside supply, until the flow bonds and cranks its envelope.
 * 6. **QueueYield** — the batch operators' `queueyield` crank mints the pending
 *    yield as protocol-owned shadow and hands it to the swap's reservoir.
 * 7. **SellYield** — their `tickyield` crank sells the reservoir into the pool;
 *    `addyield` bumps the cumulative index, and the reservoir empties.
 * 8. **Claim** — the user claims exactly what the index says they are owed,
 *    in WIRE; the pot falls by the same.
 * 9. **Desyndicate** — the user burns their shadow; `DESYNDICATE_LIQ` reaches
 *    a depot → Solana envelope, and the outpost pays their liqSOL ATA inline.
 * 10. **DepotKeepsAdvancing** — `current_epoch_index` advances past the
 *    snapshot, so consensus kept closing epochs across every attestation.
 */
export class LIQYieldScenario extends FlowScenario {
  readonly name = "flow-liq-yield"
  readonly description =
    "Syndicated liqSOL is credited on the depot, its reported yield is minted, sold through sysio.swap and claimed as WIRE, and the position is redeemed on the outpost"

  override readonly defaults: ClusterBuildOptions = {
    // The yield pool `queueyield` funds and `tickyield` sells through —
    // `regliqpool` is epoch-0-gated by the depot, so it rides the bootstrap.
    enableMockLiqPools: true,
    enableMockSyndicationImport: true,
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const outpostWriteStepOptions = {
        timeoutMs: Constants.OutpostWriteTimeoutMs
      },
      depotWriteStepOptions = { timeoutMs: Constants.DepotWriteTimeoutMs },
      circulationStepOptions = {
        timeoutMs:
          Constants.CirculationTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      },
      crankStepOptions = {
        timeoutMs:
          Constants.CrankTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      },
      epochAdvanceStepOptions = {
        timeoutMs:
          Constants.epochAdvanceDeadlineMs() +
          ProtocolTiming.PollDeadlineBufferMs
      }

    // ── 1. Snapshot the depot's epoch index BEFORE any write ──
    ClusterBuildPhase.create(
      cluster,
      "SnapshotDepotEpoch",
      "Record the depot's current_epoch_index before any liq attestation is produced"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-epoch-index",
        "record sysio.epoch::epochstate.current_epoch_index",
        async ctx => {
          ctx.outputs.set(
            LIQYieldScenario.EpochIndexBeforeKey,
            await readCurrentEpochIndex(ctx)
          )
        }
      )
    )

    // ── 2. The user: a WIRE account and a Solana wallet ──
    ClusterBuildPhase.create(
      cluster,
      "ProvisionUser",
      "Provision the user's WIRE account and fund their Solana wallet"
    ).push(
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-wire-account",
        "create the yield recipient",
        depotWriteStepOptions,
        Constants.UserAccount,
        HarnessConstants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "user-resource-policy",
        "allocate resources to the yield recipient",
        depotWriteStepOptions,
        Constants.resourcePolicy(Constants.UserAccount)
      ),
      SolanaFundingTool.planKeypairAirdrop(
        Actor.User,
        "airdrop-user",
        `top the user's Solana wallet up to ${Constants.UserFloorLamports} lamports`,
        outpostWriteStepOptions,
        Constants.UserKeypairName,
        Constants.UserFloorLamports
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "ProvisionBonder",
      "Link the opt-in imported position to the bonder"
    ).push(
      Steps.account.planCreateKeyed(
        Actor.Underwriter,
        "create-bonder-account",
        "create the imported position's bonder",
        depotWriteStepOptions,
        Constants.BonderAccount,
        HarnessConstants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.Underwriter,
        "bonder-resource-policy",
        "allocate resources to the bonder",
        depotWriteStepOptions,
        Constants.resourcePolicy(Constants.BonderAccount)
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.Underwriter,
        "link-bonder-solana-key",
        "sweep the bonder's parked import through createlink",
        depotWriteStepOptions,
        Constants.BonderAccount,
        Steps.registry.MockSyndicationBonderLabel
      ),
      verifyStep(
        Actor.Sysio,
        "import-delivered-to-bonder",
        "the imported shadow is liquid bonding capacity",
        async ctx => {
          Steps.registry.readMockSyndicationBonder(ctx)
          const { rows } = await ctx.wire
              .getSysioContract(SysioContractName.liq)
              .tables.accounts.query({
                scope: Constants.BonderAccount,
                limit: Constants.TableQueryLimit
              }),
            holding = rows.find(
              row =>
                Asset.from(row.balance).symbol.name ===
                Constants.LIQTokenCodename
            )
          Assert.ok(holding != null, "bonder import was not delivered")
          Assert.strictEqual(
            assetUnits(holding.balance),
            BigInt(Steps.registry.MockSyndicationImportAmount)
          )
        }
      )
    )

    // ── 3. A real syndication, parked on the depot against the unlinked key ──
    ClusterBuildPhase.create(
      cluster,
      "Syndicate",
      "The user syndicates liqSOL PostLaunch; the depot holds the item until its request is bonded"
    ).push(
      // FIRST, and a read: the phase's writes are all one-way, so a cluster
      // this scenario has already run against must be refused before it
      // spends one — PostLaunch is TERMINAL, so the scenario is single-shot
      // per cluster (use a fresh --cluster-path).
      verifyStep(
        Actor.SolanaOutpost,
        "outpost-is-pre-launch",
        "the outpost GlobalState is still PreLaunch — the state this scenario transitions from",
        async ctx => {
          const current = await SolanaLiqSyndicationTool.readWireState(ctx)
          Assert.strictEqual(
            current,
            WireState.preLaunch,
            `the outpost is in ${current}, not ${WireState.preLaunch}`
          )
        }
      ),
      SolanaLiqSyndicationTool.planSetLiqTokenAddress(
        Actor.SolanaOutpost,
        "map-liq-token",
        `bind the liqSOL mint to depot token code ${Constants.LIQTokenCode} on the outpost config`,
        outpostWriteStepOptions,
        Constants.LIQTokenCode
      ),
      SolanaLiqSyndicationTool.planDepositForLiqsol(
        Actor.User,
        "deposit-for-liqsol",
        `deposit ${Constants.DepositLamports} lamports for liqSOL 1:1`,
        outpostWriteStepOptions,
        Constants.UserKeypairName,
        Constants.DepositLamports
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "set-wire-state-launching",
        "move the outpost GlobalState to Launching",
        outpostWriteStepOptions,
        WireState.launching
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "set-wire-state-post-launch",
        "move the outpost GlobalState to PostLaunch (the depot becomes the syndication ledger)",
        outpostWriteStepOptions,
        WireState.postLaunch
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "syndicate-liqsol",
        `syndicate ${Constants.SyndicateAmount} liqSOL base units into the outpost-owned pool`,
        outpostWriteStepOptions,
        Constants.UserKeypairName,
        Constants.SyndicateAmount
      ),
      verifyStep(
        Actor.BatchOperator,
        "syndicate-liq-circulates",
        "SYNDICATE_LIQ appears in an OUTPOST_SOLANA_DEPOT envelope artifact",
        async ctx => {
          await pollUntil(
            "SYNDICATE_LIQ in an OUTPOST_SOLANA_DEPOT envelope",
            async () =>
              containsSyndicateLIQ(oppDebuggingPath(ctx.config.clusterPath)),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "syndication-held-before-bond",
        "the closed envelope holds the user's full item before bonding",
        async ctx => {
          await pollUntil(
            "held syndication envelope",
            async () => {
              const envelope = await WireSyndicationTool.readHeldEnvelope(
                ctx,
                SolanaOutpostBootstrapper.SolanaChainCodename,
                Constants.LIQTokenCodename,
                SysioSyndItemKind.SYNDICATION,
                Constants.SyndicateAmount,
                Buffer.from(readUserPubkeyBytes(ctx)).toString("hex")
              )
              if (!WireSyndicationTool.isRequestIssued(envelope)) return false
              ctx.outputs.set(
                LIQYieldScenario.SyndicationEpochKey,
                envelope.epoch_index
              )
              ctx.outputs.set(
                LIQYieldScenario.SyndicationRequestKey,
                envelope.request_id
              )
              return true
            },
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
          Assert.strictEqual(await readParkedShadow(ctx), 0n)
          Assert.strictEqual(await readHolding(ctx), undefined)
        },
        circulationStepOptions
      )
    )

    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondSyndication",
      "Bond the held syndication envelope",
      circulationStepOptions,
      Constants.BonderAccount,
      SolanaOutpostBootstrapper.SolanaChainCodename,
      Constants.LIQTokenCodename,
      LIQYieldScenario.SyndicationEpochKey
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseSyndication",
      "Release bonded shadow to the unlinked user"
    ).push(
      Steps.contracts.sysio.synd.planCrank(
        Actor.User,
        "release-syndication",
        "crank the bonded envelope",
        depotWriteStepOptions,
        { limit: Constants.CrankLimit },
        Constants.UserAccount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-parks-the-syndication",
        "sysio.synd parks exactly the syndicated amount against the user's unlinked Solana key",
        async ctx => {
          await pollUntil(
            `${Constants.SyndicateAmount} shadow parked against the user's key`,
            async () =>
              (await readParkedShadow(ctx)) === Constants.SyndicateAmount,
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
          Assert.strictEqual(
            await readHolding(ctx),
            undefined,
            "the user must hold no shadow before linking — the credit is parked, not delivered"
          )
        },
        circulationStepOptions
      )
    )

    // ── 4. The link delivers the parked shadow ──
    ClusterBuildPhase.create(
      cluster,
      "Link",
      "The user links their Solana key; createlink's inline sweep delivers the parked shadow"
    ).push(
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link-solana-key",
        `link the user's Solana key to ${Constants.UserAccount} through sysio.authex::createlink`,
        depotWriteStepOptions,
        Constants.UserAccount,
        Constants.UserKeypairName
      ),
      verifyStep(
        Actor.Sysio,
        "parked-shadow-delivered",
        "the user's own shadow row holds the syndicated amount and nothing stays parked",
        async ctx => {
          const holding = await readHolding(ctx)
          Assert.ok(
            holding != null,
            "createlink's sweep opened no shadow row for the user"
          )
          Assert.strictEqual(
            assetUnits(holding.balance),
            Constants.SyndicateAmount
          )
          Assert.strictEqual(await readParkedShadow(ctx), 0n)
        }
      )
    )

    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveSyndication",
      "Wait out the window and return the syndication bond",
      circulationStepOptions,
      Constants.BonderAccount,
      LIQYieldScenario.SyndicationRequestKey
    )

    // ── 5. Reported yield lands on the depot, outside supply ──
    ClusterBuildPhase.create(
      cluster,
      "ReportLiqYield",
      "Bonus pool yield is donated and LIQ_YIELD remains held until the envelope is bonded"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "snapshot-liq-yield-state",
        "record GlobalState's liq-yield watermark + sequence before the donation",
        async ctx => {
          ctx.outputs.set(
            LIQYieldScenario.LiqYieldStateBeforeKey,
            await SolanaLiqSyndicationTool.readLiqYieldState(ctx)
          )
        }
      ),
      SolanaLiqSyndicationTool.planInjectBonusSyndYield(
        Actor.SolanaOutpost,
        "inject-bonus-synd-yield",
        `donate ${Constants.BonusYieldLamports} lamports of bonus yield to the syndicated pool`,
        outpostWriteStepOptions,
        SolanaFundingTool.DeployerKeypairName,
        Constants.BonusYieldLamports
      ),
      SolanaLiqSyndicationTool.planReportLiqYield(
        Actor.User,
        "report-liq-yield",
        "crank report_liq_yield as a non-admin signer",
        outpostWriteStepOptions,
        Constants.UserKeypairName
      ),
      verifyStep(
        Actor.Sysio,
        "yield-held-before-bond",
        "LIQ_YIELD circulates but its item stays held outside liqpending and supply",
        async ctx => {
          const before = ctx.outputs.assert(
              LIQYieldScenario.LiqYieldStateBeforeKey
            ),
            after = await SolanaLiqSyndicationTool.readLiqYieldState(ctx),
            reportedAmount = after.liqYieldReported - before.liqYieldReported
          Assert.ok(
            reportedAmount >= Constants.BonusYieldLamports,
            `report_liq_yield advanced the watermark by ${reportedAmount}, less than the ` +
              `${Constants.BonusYieldLamports} lamports donated — the donation was not claimed`
          )
          ctx.outputs.set(LIQYieldScenario.ReportedYieldKey, reportedAmount)
          ctx.outputs.set(
            LIQYieldScenario.SupplyBeforeYieldKey,
            await readShadowSupply(ctx)
          )
          await pollUntil(
            `LIQ_YIELD held for ${reportedAmount}`,
            async () => {
              if (!containsLIQYield(oppDebuggingPath(ctx.config.clusterPath)))
                return false
              const envelope = await WireSyndicationTool.readHeldEnvelope(
                ctx,
                SolanaOutpostBootstrapper.SolanaChainCodename,
                Constants.LIQTokenCodename,
                SysioSyndItemKind.YIELD,
                reportedAmount
              )
              if (!WireSyndicationTool.isRequestIssued(envelope)) return false
              ctx.outputs.set(
                LIQYieldScenario.YieldEpochKey,
                envelope.epoch_index
              )
              ctx.outputs.set(
                LIQYieldScenario.YieldRequestKey,
                envelope.request_id
              )
              Assert.strictEqual(await readPendingYield(ctx), 0n)
              Assert.strictEqual(
                await readShadowSupply(ctx),
                ctx.outputs.assert(LIQYieldScenario.SupplyBeforeYieldKey)
              )
              return true
            },
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      )
    )

    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondYield",
      "Bond the held yield envelope",
      circulationStepOptions,
      Constants.BonderAccount,
      SolanaOutpostBootstrapper.SolanaChainCodename,
      Constants.LIQTokenCodename,
      LIQYieldScenario.YieldEpochKey
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseYield",
      "Release bonded yield to sysio.liq"
    ).push(
      Steps.contracts.sysio.synd.planCrank(
        Actor.User,
        "release-yield",
        "crank the bonded yield envelope",
        depotWriteStepOptions,
        { limit: Constants.CrankLimit },
        Constants.UserAccount
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveYield",
      "Wait out the window and return the yield bond",
      circulationStepOptions,
      Constants.BonderAccount,
      LIQYieldScenario.YieldRequestKey
    )

    // ── 6. The operators' queueyield crank mints the yield into the reservoir ──
    ClusterBuildPhase.create(
      cluster,
      "QueueYield",
      "The batch operators' queueyield crank mints the pending yield as protocol-owned shadow and funds the swap's reservoir"
    ).push(
      verifyStep(
        Actor.BatchOperator,
        "pending-yield-queued",
        "liqpending empties and the shadow supply grows by exactly the reported yield",
        async ctx => {
          const reported = ctx.outputs.assert(
              LIQYieldScenario.ReportedYieldKey
            ),
            supplyBefore = ctx.outputs.assert(
              LIQYieldScenario.SupplyBeforeYieldKey
            )
          await pollUntil(
            "queueyield moved the pending yield into supply",
            async () =>
              (await readPendingYield(ctx)) === 0n &&
              (await readShadowSupply(ctx)) === supplyBefore + reported,
            Constants.CrankTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        crankStepOptions
      )
    )

    // ── 7. The operators' tickyield crank sells it; addyield bumps the index ──
    ClusterBuildPhase.create(
      cluster,
      "SellYield",
      "The batch operators' tickyield crank sells the reservoir through the pool; addyield distributes the WIRE to every holder"
    ).push(
      verifyStep(
        Actor.BatchOperator,
        "yield-index-advances",
        "the cumulative index moves off zero and the reservoir sells out, so the ledger is stable for an exact claim",
        async ctx => {
          await pollUntil(
            "yieldidx.index > 0 and the reservoir empty",
            async () =>
              BigInt((await readYieldIndex(ctx)).index) > 0n &&
              (await readReservoirQueued(ctx)) === 0n,
            Constants.CrankTimeoutMs,
            Constants.CirculationPollMs
          )
          const index = await readYieldIndex(ctx),
            holding = await readHolding(ctx),
            owed = owedWire(holding, BigInt(index.index))
          Assert.ok(
            owed > 0n,
            "the user holds shadow through a distribution, so they must be owed WIRE"
          )
          ctx.outputs.set(LIQYieldScenario.OwedWireKey, owed)
          ctx.outputs.set(LIQYieldScenario.PotBeforeClaimKey, BigInt(index.pot))
        },
        crankStepOptions
      )
    )

    // ── 8. The claim pays exactly what the index says ──
    ClusterBuildPhase.create(
      cluster,
      "Claim",
      "The user claims their yield: exactly the pre-computed owed WIRE, and the pot falls by the same"
    ).push(
      Steps.contracts.sysio.liq.planClaim(
        Actor.User,
        "claim-yield",
        `claim the WIRE owed to ${Constants.UserAccount}'s ${Constants.LIQTokenCodename} row`,
        depotWriteStepOptions,
        { holder: Constants.UserAccount, sym: Constants.LIQTokenCodename }
      ),
      verifyStep(
        Actor.Sysio,
        "claim-is-exact",
        "the user's WIRE balance is exactly the owed amount, the row is settled, and the pot fell by the payout",
        async ctx => {
          const owed = ctx.outputs.assert(LIQYieldScenario.OwedWireKey),
            potBefore = ctx.outputs.assert(LIQYieldScenario.PotBeforeClaimKey),
            index = await readYieldIndex(ctx),
            holding = await readHolding(ctx)
          Assert.strictEqual(await readWireBalance(ctx), owed)
          Assert.strictEqual(BigInt(holding.owed_wire), 0n)
          Assert.strictEqual(
            BigInt(holding.index_checkpoint),
            BigInt(index.index)
          )
          Assert.strictEqual(BigInt(index.pot), potBefore - owed)
        }
      )
    )

    // ── 9. The redemption: burn on the depot, paid inline on the outpost ──
    ClusterBuildPhase.create(
      cluster,
      "Desyndicate",
      "The user burns their shadow; DESYNDICATE_LIQ reaches the Solana outpost, which pays their liqSOL ATA inline"
    ).push(
      verifyStep(
        Actor.User,
        "snapshot-liqsol-balance",
        "record the user's liqSOL ATA balance before the redemption",
        async ctx => {
          const config = await WireSyndicationTool.readSyndicationConfig(
            ctx,
            SolanaOutpostBootstrapper.SolanaChainCodename,
            Constants.LIQTokenCodename
          )
          Assert.ok(config != null, "missing syndication configuration")
          ctx.outputs.set(
            LIQYieldScenario.RedemptionAmountKey,
            Constants.SyndicateAmount -
              (Constants.SyndicateAmount * BigInt(config.desynd_fee_bps)) /
                Constants.FeeDenominator
          )
          ctx.outputs.set(
            LIQYieldScenario.LiqsolBalanceBeforeKey,
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.UserKeypairName
            )
          )
        }
      ),
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "desyndicate",
        `burn ${Constants.SyndicateAmount} shadow base units and queue DESYNDICATE_LIQ`,
        depotWriteStepOptions,
        {
          holder: Constants.UserAccount,
          quantity: Asset.fromUnits(
            Constants.SyndicateAmount.toString(),
            Constants.ShadowSymbol
          ).toString()
        }
      ),
      verifyStep(
        Actor.Sysio,
        "shadow-burned",
        "the user's shadow row is empty and the supply fell by the burned amount",
        async ctx => {
          const holding = await readHolding(ctx)
          Assert.strictEqual(assetUnits(holding.balance), 0n)
        }
      ),
      verifyStep(
        Actor.BatchOperator,
        "desyndicate-liq-circulates",
        "DESYNDICATE_LIQ appears in a DEPOT_OUTPOST_SOLANA envelope with the user's key, the amount and a request id",
        async ctx => {
          const pubkey = readUserPubkeyBytes(ctx)
          await pollUntil(
            "DESYNDICATE_LIQ in a DEPOT_OUTPOST_SOLANA envelope",
            async () =>
              containsDesyndicateLIQ(
                oppDebuggingPath(ctx.config.clusterPath)
              ) &&
              (await readCirculatedDesyndications(ctx)).some(
                redemption =>
                  redemption.chainCode === Constants.SolanaChainCode &&
                  redemption.amount?.tokenCode === Constants.LIQTokenCode &&
                  redemption.amount?.amount ===
                    ctx.outputs.assert(LIQYieldScenario.RedemptionAmountKey) &&
                  redemption.user?.kind === ChainKind.SVM &&
                  Buffer.from(redemption.user.address).equals(
                    Buffer.from(pubkey)
                  ) &&
                  redemption.requestId > 0n
              ),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "outpost-pays-the-redemption",
        "the user's liqSOL ATA grows by the burned amount less the configured fee",
        async ctx => {
          const before = ctx.outputs.assert(
            LIQYieldScenario.LiqsolBalanceBeforeKey
          )
          await pollUntil(
            `the user's liqSOL balance reaches ${before + ctx.outputs.assert(LIQYieldScenario.RedemptionAmountKey)}`,
            async () =>
              (await SolanaLiqSyndicationTool.readLiqsolBalance(
                ctx,
                Constants.UserKeypairName
              )) ===
              before + ctx.outputs.assert(LIQYieldScenario.RedemptionAmountKey),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      )
    )

    // ── 10. The depot kept advancing throughout ──
    ClusterBuildPhase.create(
      cluster,
      "DepotKeepsAdvancing",
      "The depot advances its epoch past the snapshot — consensus kept closing epochs across every liq attestation"
    ).push(
      verifyStep(
        Actor.Sysio,
        "epoch-index-advances",
        "sysio.epoch::epochstate.current_epoch_index advances past the pre-syndication snapshot",
        async ctx => {
          const before = ctx.outputs.assert(
            LIQYieldScenario.EpochIndexBeforeKey
          )
          await pollUntil(
            `current_epoch_index advances past ${before}`,
            async () => (await readCurrentEpochIndex(ctx)) > before,
            Constants.epochAdvanceDeadlineMs(),
            Constants.EpochAdvancePollMs
          )
        },
        epochAdvanceStepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "VerifySolvency",
      "The flow leaves the emergency cord clear and no mismatch"
    ).push(
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "cord-clear-no-mismatch",
        "cord clear and mismatch empty",
        {}
      )
    )
  }
}

/** The shadow queued in the pool's reservoir, waiting to be sold (base units; `0n` once sold out). */
async function readReservoirQueued(ctx: ClusterBuildContext): Promise<bigint> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.swap)
    .tables.reservoirs.query({ limit: Constants.TableQueryLimit })
  return rows
    .filter(
      reservoir =>
        Asset.from(reservoir.balance.quantity).symbol.name ===
        Constants.LIQTokenCodename
    )
    .reduce(
      (sum, reservoir) => sum + assetUnits(reservoir.balance.quantity),
      0n
    )
}

/** Typed cross-step output keys for the liq-yield scenario. */
export namespace LIQYieldScenario {
  /** Closed depot epoch containing the user's held syndication item. */
  export const SyndicationEpochKey = outputKey<number>(
    "LIQYieldScenario.syndicationEpoch",
    "held syndication epoch"
  )
  /** Closed depot epoch containing the held yield item. */
  export const YieldEpochKey = outputKey<number>(
    "LIQYieldScenario.yieldEpoch",
    "held yield epoch"
  )
  /** Underwriting request captured from the syndication envelope. */
  export const SyndicationRequestKey = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("LIQYieldScenario.syndicationRequest", "syndication request")
  /** Underwriting request captured from the yield envelope. */
  export const YieldRequestKey = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("LIQYieldScenario.yieldRequest", "yield request")
  /** Redemption after the configured, floor-rounded desyndication fee. */
  export const RedemptionAmountKey = outputKey<bigint>(
    "LIQYieldScenario.redemptionAmount",
    "net outpost redemption"
  )
  /** `epochstate.current_epoch_index` snapshotted before the syndication. */
  export const EpochIndexBeforeKey = outputKey<number>(
    "LIQYieldScenario.epochIndexBefore",
    "the depot's current_epoch_index before any liq attestation was produced"
  )
  /** `GlobalState`'s liq-yield accounting snapshotted before the bonus donation. */
  export const LiqYieldStateBeforeKey =
    outputKey<SolanaLiqSyndicationTool.LiqYieldState>(
      "LIQYieldScenario.liqYieldStateBefore",
      "the outpost's liq-yield watermark + sequence before the bonus-yield donation"
    )
  /** The yield `report_liq_yield` reported — the amount every depot stage must carry. */
  export const ReportedYieldKey = outputKey<bigint>(
    "LIQYieldScenario.reportedYield",
    "liqSOL base units report_liq_yield advanced the watermark by"
  )
  /** The shadow supply before the reported yield was minted into it. */
  export const SupplyBeforeYieldKey = outputKey<bigint>(
    "LIQYieldScenario.supplyBeforeYield",
    "sysio.liq's shadow supply before queueyield minted the reported yield"
  )
  /** The WIRE the index says the user is owed, computed once the ledger is stable. */
  export const OwedWireKey = outputKey<bigint>(
    "LIQYieldScenario.owedWire",
    "WIRE base units owed to the user's shadow row before the claim"
  )
  /** `yieldidx.pot` before the claim — the claim must draw exactly the owed amount from it. */
  export const PotBeforeClaimKey = outputKey<bigint>(
    "LIQYieldScenario.potBeforeClaim",
    "the shadow's undistributed WIRE pot before the user's claim"
  )
  /** The user's liqSOL ATA balance before the redemption. */
  export const LiqsolBalanceBeforeKey = outputKey<bigint>(
    "LIQYieldScenario.liqsolBalanceBefore",
    "the user's liqSOL balance before DESYNDICATE_LIQ paid them"
  )
}
