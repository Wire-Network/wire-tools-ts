import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { BootstrapPlatformConfig } from "@wireio/opp-typescript-models"
import { Asset, SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  FlowScenario,
  LcoImportPlanKey,
  Report,
  Steps,
  SyndicationUserSteps,
  WireLcoExportTool,
  WireLcoImportTool,
  WireSyndicationTool,
  eachSeries,
  assetUnits,
  formatWireAsset,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type ImportSeedChainKind
} from "@wireio/cluster-tool"
import { LcoImportScenarioConstants as Constants } from "./LcoImportScenarioConstants.js"
import { LcoImportScenarioExports as Exports } from "./LcoImportScenarioExports.js"

const {
  SysioContractAccount,
  SysioContractName,
  SysioDclaimChainkind,
  SysioSyndChainkind
} = SysioContracts
const { Actor } = Report

// ── reads (execute freely inside verify steps) ──────────────────────────────

/** The plan the bootstrap's `publish-lco-import-plan` published. */
function readPlan(ctx: ClusterBuildContext): WireLcoImportTool.Plan {
  return ctx.outputs.assert(LcoImportPlanKey)
}

/** A holder's persisted identity, read back by its handle from the cluster data directory. */
function identityOf(
  ctx: ClusterBuildContext,
  holder: Constants.Holder
): WireLcoExportTool.HolderIdentity {
  return Exports.holderIdentity(ctx.config.dataPath, holder)
}

/** The plan of `chain`; throws when the import has none. */
function chainPlanOf(
  plan: WireLcoImportTool.Plan,
  chain: ImportSeedChainKind
): WireLcoImportTool.ChainPlan {
  const chainPlan = WireLcoImportTool.chainPlans(plan).find(
    candidate => candidate.chain === chain
  )
  Assert.ok(chainPlan != null, `the import has no chain ${chain}`)
  return chainPlan
}

/** A holder's imported position, in its liq token's subunits; nothing imported is `0n`. */
function positionOf(
  plan: WireLcoImportTool.Plan,
  holder: Constants.Holder,
  identity: WireLcoExportTool.HolderIdentity
): bigint {
  const spec = chainPlanOf(plan, holder.chain).syndications.find(
    candidate => candidate.pubkey === identity.pubkey
  )
  return spec == null ? 0n : spec.amount
}

/** A holder's imported WIRE claim, in subunits; nothing imported is `0n`. */
function claimOf(
  plan: WireLcoImportTool.Plan,
  holder: Constants.Holder,
  identity: WireLcoExportTool.HolderIdentity
): bigint {
  const nativeAddress = WireLcoImportTool.nativeBytesHex(
    holder.chain,
    identity.address
  )
  const claim = chainPlanOf(plan, holder.chain).claims.find(
    candidate => candidate.native_address === nativeAddress
  )
  return claim == null ? 0n : BigInt(claim.wire_atomic)
}

/** The liq token code of a holder's chain. */
function tokenOf(plan: WireLcoImportTool.Plan, holder: Constants.Holder): string {
  return chainPlanOf(plan, holder.chain).pool.tokenCode
}

/**
 * The key a chain's holding is read back under: its chain code and the holder's native key
 * or address as raw-byte hex.
 */
function holdingKey(chainCode: string, nativeHex: string): string {
  return `${chainCode}/${nativeHex}`
}

/** A holder's {@link holdingKey} for its imported position. */
function positionKeyOf(
  plan: WireLcoImportTool.Plan,
  holder: Constants.Holder,
  identity: WireLcoExportTool.HolderIdentity
): string {
  return holdingKey(
    chainPlanOf(plan, holder.chain).pool.chainCode,
    WireLcoImportTool.nativeBytesHex(holder.chain, identity.pubkey)
  )
}

/** Every `sysio.synd` parked balance, by {@link holdingKey} — one paged read of the table. */
async function readParkedPositions(
  ctx: ClusterBuildContext,
  plan: WireLcoImportTool.Plan
): Promise<Map<string, bigint>> {
  const chainPlans = WireLcoImportTool.chainPlans(plan),
    rows = await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .tables.parked.queryAll({ limit: WireSyndicationTool.TableRowLimit })
  return new Map(
    rows.map(row => [
      holdingKey(
        WireLcoImportTool.chainCodeOf(
          chainPlans,
          row.chain_kind,
          SysioSyndChainkind
        ),
        row.pubkey
      ),
      BigInt(row.balance)
    ])
  )
}

/** Every `sysio.dclaim` unmapped claim, by {@link holdingKey} — one paged read of the table. */
async function readUnmappedClaims(
  ctx: ClusterBuildContext,
  plan: WireLcoImportTool.Plan
): Promise<Map<string, bigint>> {
  const chainPlans = WireLcoImportTool.chainPlans(plan),
    rows = await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .tables.unmapped.queryAll({ limit: WireSyndicationTool.TableRowLimit })
  return new Map(
    rows.map(row => [
      holdingKey(
        WireLcoImportTool.chainCodeOf(
          chainPlans,
          row.chain_kind,
          SysioDclaimChainkind
        ),
        row.native_pubkey
      ),
      assetUnits(row.balance)
    ])
  )
}

/** Every `sysio.dclaim` pending claim, by WIRE account — one paged read of the table. */
async function readPendingClaims(
  ctx: ClusterBuildContext
): Promise<Map<string, bigint>> {
  const rows = await ctx.wire
    .getSysioContract(SysioContractName.dclaim)
    .tables.pclaims.queryAll({ limit: WireSyndicationTool.TableRowLimit })
  return new Map(
    rows.map(row => [
      row.wire_account,
      assetUnits(row.balance)
    ])
  )
}

/** The `sysio.swap::stat` row of the pair whose token code is `pairCode`. */
async function readPool(
  ctx: ClusterBuildContext,
  pairCode: string
): Promise<SysioContracts.SysioSwapCurrencyStatsType> {
  const rows = await ctx.wire
    .getSysioContract(SysioContractName.swap)
    .tables.stat.queryAll({ limit: WireSyndicationTool.TableRowLimit })
  const row = rows.find(
    candidate =>
      Asset.from(candidate.supply).symbol.code.toString() === pairCode
  )
  Assert.ok(row != null, `sysio.swap has no ${pairCode} pair`)
  return row
}

/**
 * Launch-data import — the pre-bootstrap stage generates each holder's random key, persists
 * it under the holder's handle and writes both exports under the cluster path from the
 * committed templates; the bootstrap replays those exports during epoch zero
 * (`--ethereum-bootstrap-json-file` / `--solana-bootstrap-json-file`, set by `prepare`). The
 * flow then checks every imported position, claim and pool on the depot, has each holder
 * link its key (delivering its LIQ and moving its claim to pending), claim its WIRE, and
 * trades WIRE through the LIQSOL pool.
 */
export class LcoImportScenario extends FlowScenario {
  readonly name = "flow-lco-import"
  readonly description =
    "The bootstrap imports each outpost's frozen launch export; stakers link and hold their LIQ, purchasers claim their WIRE, and the LCO pool trades"

  readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    lcoImport: Constants.LcoImport
  }

  /**
   * The pre-bootstrap stage: generate (or read back) every holder's random key under its
   * durable handle, write both exports from the committed templates with those keys in
   * place of the placeholders, and point the bootstrap's import at the written files.
   *
   * @param options - The resolved build options.
   * @returns The options the bootstrap composes with — the import pointed at the exports.
   */
  async prepare(options: ClusterBuildOptions): Promise<ClusterBuildOptions> {
    const { clusterPath, buildPath } = options
    Assert.ok(
      clusterPath != null,
      "flow-lco-import: clusterPath must be resolved before the exports are written"
    )
    Assert.ok(
      buildPath != null,
      "flow-lco-import: buildPath must be resolved before the holder keys are generated"
    )
    const dataPath = Exports.dataPath(clusterPath)
    await Exports.createHolderKeys(dataPath, buildPath)
    const { ethereum, solana } = Exports.writeExports(dataPath)
    return {
      ...options,
      ethereumBootstrapJsonFile: ethereum,
      solanaBootstrapJsonFile: solana
    }
  }

  plan(cluster: ClusterBuild): void {
    // ── 1. The import landed: positions parked, claims unmapped, pools seeded ──
    ClusterBuildPhase.create(
      cluster,
      "LcoImportLanded",
      "Every imported position, claim and pool is on the depot"
    ).push(
      verifyStep(
        Actor.Sysio,
        "verify-lco-fixture-keys",
        "the exports name the holders' persisted keys: every holder has a claim, every staker a position",
        async ctx => {
          const plan = readPlan(ctx)
          Constants.Holders.forEach(holder => {
            const identity = identityOf(ctx, holder)
            Assert.ok(
              claimOf(plan, holder, identity) > 0n,
              `the ${holder.account} export rows carry no claim for ${identity.address}`
            )
          })
          Constants.Stakers.forEach(holder => {
            const identity = identityOf(ctx, holder)
            Assert.ok(
              positionOf(plan, holder, identity) > 0n,
              `the ${holder.account} export rows carry no position for ${identity.pubkey}`
            )
          })
          Assert.deepStrictEqual(plan.placeholders, [], "the import took placeholders")
        }
      ),
      verifyStep(
        Actor.Sysio,
        "verify-lco-record",
        "the import's record lists exactly the plan's pools and positions",
        async ctx => {
          const { clusterPath } = ctx.config,
            record = BootstrapPlatformConfig.fromJsonString(
              Fs.readFileSync(Steps.lcoImport.recordFile(clusterPath), "utf-8")
            )
          Assert.deepStrictEqual(
            record,
            WireLcoImportTool.toBootstrapPlatformConfig(
              readPlan(ctx),
              Path.basename(clusterPath)
            )
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "verify-lco-parked-positions",
        "each imported position is parked under its pubkey for exactly its amount",
        async ctx => {
          const plan = readPlan(ctx),
            parked = await readParkedPositions(ctx, plan)
          WireLcoImportTool.chainPlans(plan).forEach(chainPlan =>
            chainPlan.syndications.forEach(spec =>
              Assert.strictEqual(
                parked.get(
                  holdingKey(
                    chainPlan.pool.chainCode,
                    WireLcoImportTool.nativeBytesHex(
                      chainPlan.chain,
                      spec.pubkey
                    )
                  )
                ) ?? 0n,
                spec.amount,
                `${spec.tokenCode} parked under ${spec.pubkey}`
              )
            )
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "verify-lco-unmapped-claims",
        "each imported claim is unmapped under its native address for exactly its WIRE",
        async ctx => {
          const plan = readPlan(ctx),
            unmapped = await readUnmappedClaims(ctx, plan)
          WireLcoImportTool.chainPlans(plan).forEach(chainPlan =>
            chainPlan.claims.forEach(claim =>
              Assert.strictEqual(
                unmapped.get(
                  holdingKey(chainPlan.pool.chainCode, claim.native_address)
                ) ?? 0n,
                BigInt(claim.wire_atomic),
                `WIRE claim of ${claim.native_address}`
              )
            )
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "verify-lco-pools",
        "each LCO pool holds its seeds, at its fee, with its shadow as the yield leg",
        async ctx =>
          eachSeries(
            WireLcoImportTool.chainPlans(readPlan(ctx)),
            async ({ pool }) => {
              const stat = await readPool(ctx, pool.pairSymbol)
              Assert.deepStrictEqual(
                [
                  assetUnits(stat.pool1.quantity),
                  assetUnits(stat.pool2.quantity),
                  stat.fee,
                  stat.yield_leg?.sym
                ],
                [
                  pool.initialChainAmount,
                  pool.initialWireAmount,
                  pool.fee,
                  HarnessConstants.liqSymbol(pool.tokenCode)
                ],
                `the ${pool.pairSymbol} pool`
              )
            }
          )
      )
    )

    // ── 2. Holder accounts (their keys were persisted by the pre-bootstrap stage) ──
    ClusterBuildPhase.create(
      cluster,
      "LcoHolderAccounts",
      "Create each holder's WIRE account"
    ).push(
      ...Constants.Holders.map(holder =>
        Steps.user.planProvisionWire(
          Actor.User,
          `create-${holder.account}`,
          `create ${holder.account}, unfunded`,
          {},
          holder.account,
          0n
        )
      )
    )

    // ── 3. Each holder links its key: its LIQ is delivered, its claim moves to pending ──
    ClusterBuildPhase.create(
      cluster,
      "LcoHolderLinks",
      "Each holder links the persisted key its export names to its WIRE account"
    ).push(
      ...Constants.EthereumHolders.map(holder =>
        SyndicationUserSteps.planLinkEthereumKey(
          Actor.User,
          `link-${holder.account}`,
          `${holder.account} links its Ethereum key (${holder.walletName})`,
          {},
          holder.account,
          holder.walletName
        )
      ),
      ...Constants.SolanaHolders.map(holder =>
        SyndicationUserSteps.planLinkSolanaKey(
          Actor.User,
          `link-${holder.account}`,
          `${holder.account} links its Solana key (${holder.keypairName})`,
          {},
          holder.account,
          holder.keypairName
        )
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "LcoHoldingsDelivered",
      "Each link delivered the holder's LIQ and made its claim pending"
    ).push(
      verifyStep(
        Actor.User,
        "verify-lco-positions-delivered",
        "each holder holds exactly its imported position, and nothing stays parked",
        async ctx => {
          const plan = readPlan(ctx),
            parked = await readParkedPositions(ctx, plan)
          await eachSeries(Constants.Holders, async holder => {
            const tokenCode = tokenOf(plan, holder),
              identity = identityOf(ctx, holder)
            Assert.strictEqual(
              await WireSyndicationTool.readLiqBalance(ctx, holder.account, tokenCode),
              positionOf(plan, holder, identity),
              `${holder.account} ${tokenCode}`
            )
            Assert.strictEqual(
              parked.get(positionKeyOf(plan, holder, identity)) ?? 0n,
              0n,
              `${tokenCode} still parked under ${identity.pubkey}`
            )
          })
        }
      ),
      verifyStep(
        Actor.User,
        "verify-lco-claims-pending",
        "each holder's imported claim is pending under its account",
        async ctx => {
          const plan = readPlan(ctx),
            pending = await readPendingClaims(ctx)
          Constants.Holders.forEach(holder =>
            Assert.strictEqual(
              pending.get(holder.account) ?? 0n,
              claimOf(plan, holder, identityOf(ctx, holder)),
              `${holder.account} pending claim`
            )
          )
        }
      )
    )

    // ── 4. Each holder claims its WIRE ──
    ClusterBuildPhase.create(
      cluster,
      "LcoClaims",
      "Each holder claims its imported WIRE"
    ).push(
      ...Constants.Holders.map(holder =>
        Steps.contracts.sysio.dclaim.planClaim(
          Actor.User,
          `claim-${holder.account}`,
          `${holder.account} claims its WIRE`,
          {},
          { wire_account: holder.account }
        )
      ),
      verifyStep(
        Actor.User,
        "verify-lco-claims-paid",
        "each holder holds exactly its claim in WIRE and has nothing pending",
        async ctx => {
          const plan = readPlan(ctx),
            pending = await readPendingClaims(ctx)
          await eachSeries(Constants.Holders, async holder => {
            Assert.strictEqual(
              await ctx.wire.getWireBalance(holder.account),
              claimOf(plan, holder, identityOf(ctx, holder)),
              `${holder.account} WIRE`
            )
            Assert.strictEqual(
              pending.get(holder.account) ?? 0n,
              0n,
              `${holder.account} pending claim after claiming`
            )
          })
        }
      )
    )

    // ── 5. The LIQSOL pool trades ──
    const { SolanaStaker } = Constants
    ClusterBuildPhase.create(
      cluster,
      "LcoPoolTrade",
      "The Solana staker buys LIQSOL with WIRE from the LCO pool"
    ).push(
      Steps.contracts.sysio.token.planTransfer(
        Actor.User,
        "trade-lco-pool",
        `${SolanaStaker.account} sells ${formatWireAsset(Constants.TradeWireAmount)} into the ${Constants.TradePairCode} pool`,
        {},
        {
          from: SolanaStaker.account,
          to: SysioContractAccount[SysioContractName.swap],
          quantity: formatWireAsset(Constants.TradeWireAmount),
          memo: `${Constants.ExchangeMemoPrefix}${Constants.TradePairCode},${Asset.fromUnits(
            Constants.TradeMinimumOut,
            HarnessConstants.liqSymbol(HarnessConstants.LIQSOL_CODENAME)
          ).toString()},${Constants.TradeMemo}`
        }
      ),
      verifyStep(
        Actor.User,
        "verify-lco-pool-trade",
        "the WIRE in went to the pool, the LIQSOL out came from it, and the pool's product grew",
        async ctx => {
          const plan = readPlan(ctx),
            identity = identityOf(ctx, SolanaStaker),
            { pool } = chainPlanOf(plan, SolanaStaker.chain),
            stat = await readPool(ctx, pool.pairSymbol),
            bought =
              (await WireSyndicationTool.readLiqBalance(
                ctx,
                SolanaStaker.account,
                pool.tokenCode
              )) - positionOf(plan, SolanaStaker, identity),
            poolLiq = assetUnits(stat.pool1.quantity),
            poolWire = assetUnits(stat.pool2.quantity)
          Assert.strictEqual(
            await ctx.wire.getWireBalance(SolanaStaker.account),
            claimOf(plan, SolanaStaker, identity) - Constants.TradeWireAmount,
            "the trader's WIRE after the trade"
          )
          Assert.ok(bought > 0n, "the trade bought no LIQSOL")
          // The trade settles the pool's owed yield into its WIRE side before pricing.
          Assert.ok(
            poolWire >= pool.initialWireAmount + Constants.TradeWireAmount,
            `the pool's WIRE side ${poolWire} must hold at least its seed plus the trade`
          )
          Assert.strictEqual(
            poolLiq,
            pool.initialChainAmount - bought,
            "the pool's LIQSOL side after the trade"
          )
          Assert.ok(
            poolLiq * poolWire >= pool.initialChainAmount * pool.initialWireAmount,
            "the trade shrank the pool's product"
          )
        }
      )
    )

    // ── 6. Healthy: no cord pulled, no custody mismatch ──
    ClusterBuildPhase.create(
      cluster,
      "LcoHealthy",
      "No solvency check pulled the cord or recorded a mismatch"
    ).push(
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "verify-lco-healthy",
        "the emergency cord is clear and sysio.synd records no custody mismatch",
        {}
      )
    )
  }
}
