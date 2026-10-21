import Assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  ClusterBuildPhase,
  FlowScenario,
  Report,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  WireState,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { SolanaGenesisSnapshotConstants as Constants } from "./SolanaGenesisSnapshotConstants.js"
import { SolanaGenesisSteps as Steps } from "./SolanaGenesisSteps.js"

const { Actor } = Report

/** Live prelaunch accounting compared to the ACTUAL capital-index standalone exporter. */
export class SolanaGenesisSnapshotScenario extends FlowScenario {
  readonly name = "solana-genesis-snapshot"
  readonly description =
    "Real Solana principal, direct purchases, materialized yield, frozen tail and full exits reconcile with capital-index"
  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    solanaSlotsPerEpoch: Constants.SolanaSlotsPerEpoch,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  /** Plan actual outpost transactions before the freeze, then the immediate and later exports.
   * @param cluster - Bootstrap-composed cluster.
   */
  plan(cluster: ClusterBuild): void {
    const writeOptions = { timeoutMs: Constants.WriteTimeoutMs }
    const epochOptions = { timeoutMs: Constants.EpochTimeoutMs }
    ClusterBuildPhase.create(
      cluster,
      "SolanaGenesisPositions",
      "Real deposits, syndications and direct purchases"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "assert-prelaunch-prerequisites",
        "refuse a used cluster or an unbuilt capital-index checkout",
        SolanaGenesisSnapshotScenario.assertPrerequisites
      ),
      Steps.planWrite(
        Actor.SolanaOutpost,
        "initialize-tranche",
        Steps.Instruction.initTrancheState,
        SolanaFundingTool.DeployerKeypairName
      ),
      ...[Constants.ActiveUser, Constants.ExitedUser].flatMap(user => [
        SolanaFundingTool.planKeypairAirdrop(
          Actor.User,
          `fund-${user}`,
          "fund the real user's SOL wallet",
          writeOptions,
          user,
          Constants.UserFloorLamports
        ),
        SolanaLiqSyndicationTool.planDepositForLiqsol(
          Actor.User,
          `deposit-${user}`,
          "deposit native SOL for real liqSOL",
          writeOptions,
          user,
          Constants.DepositLamports
        )
      ]),
      Steps.planWrite(
        Actor.User,
        "syndicate-active",
        Steps.Instruction.synd,
        Constants.ActiveUser,
        Constants.ActiveStake
      ),
      Steps.planWrite(
        Actor.User,
        "syndicate-exited",
        Steps.Instruction.synd,
        Constants.ExitedUser,
        Constants.ExitedStake
      ),
      Steps.planWrite(
        Actor.User,
        "purchase-direct-pretokens",
        Steps.Instruction.purchase,
        Constants.ActiveUser,
        Constants.PurchaseAmount
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "record-fixture-positions",
        "observe controlled principal and directly purchased pretokens through the program IDL",
        SolanaGenesisSnapshotScenario.recordFixture
      ),
      Steps.planExport(
        Actor.User,
        "refuse-prelaunch-genesis",
        Constants.RefusedExportFile
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "SolanaGenesisYield",
      "Two actual pool purchases, one materialized epoch and one pending tail"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "await-stable-position-epoch",
        "the previous epoch contains both complete positions",
        SolanaGenesisSnapshotScenario.assertPositionEpochPassed,
        epochOptions
      ),
      SolanaLiqSyndicationTool.planInjectBonusSyndYield(
        Actor.User,
        "donate-first-yield",
        "fund real pool yield",
        writeOptions,
        SolanaFundingTool.DeployerKeypairName,
        Constants.BonusYieldLamports
      ),
      Steps.planWrite(
        Actor.User,
        "purchase-first-yield-pretokens",
        Steps.Instruction.purchaseFromYield,
        Constants.ActiveUser
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "record-first-pool-purchase",
        "observe the actual pool purchase delta and its attribution epoch",
        SolanaGenesisSnapshotScenario.recordRound
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "await-first-yield-finalization",
        "advance before the SECOND purchase, so one user's first-round yield is materialized",
        SolanaGenesisSnapshotScenario.assertFirstRoundEpochPassed,
        epochOptions
      ),
      Steps.planWrite(
        Actor.User,
        "materialize-active-yield",
        Steps.Instruction.finalizeOutpostAccount,
        Constants.ActiveUser
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "assert-materialized-first-round",
        "the program credited the active wallet's first round exactly once",
        SolanaGenesisSnapshotScenario.assertMaterialized
      ),
      SolanaLiqSyndicationTool.planInjectBonusSyndYield(
        Actor.User,
        "donate-second-yield",
        "fund the terminal pool purchase",
        writeOptions,
        SolanaFundingTool.DeployerKeypairName,
        Constants.BonusYieldLamports
      ),
      Steps.planWrite(
        Actor.User,
        "purchase-terminal-yield-pretokens",
        Steps.Instruction.purchaseFromYield,
        Constants.ActiveUser
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "record-terminal-pool-purchase",
        "observe the second actual purchase",
        SolanaGenesisSnapshotScenario.recordRound
      ),
      Steps.planWrite(
        Actor.User,
        "fully-exit-second-user",
        Steps.Instruction.desynd,
        Constants.ExitedUser,
        Constants.ExitedStake
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "SolanaGenesisFreeze",
      "Freeze, finalize the transaction, and immediately export with NO epoch wait"
    ).push(
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "enter-launching",
        "freeze the prelaunch books",
        writeOptions,
        WireState.launching
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "launching-transaction-finalized",
        "wait for transaction finality only",
        Steps.assertLaunchingFinalized,
        writeOptions
      ),
      Steps.planExport(
        Actor.User,
        "export-immediate-genesis",
        Constants.FirstExportFile,
        Steps.FirstSnapshotKey
      ),
      verifyStep(
        Actor.User,
        "assert-genesis-allocations",
        "controlled real positions and purchases match every wallet's unique allocation",
        SolanaGenesisSnapshotScenario.assertImmediateSnapshot
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "await-later-finalized-epoch",
        "AFTER the immediate export, advance an epoch to test determinism",
        SolanaGenesisSnapshotScenario.assertExportEpochPassed,
        epochOptions
      ),
      Steps.planExport(
        Actor.User,
        "export-later-genesis",
        Constants.LaterExportFile,
        Steps.LaterSnapshotKey
      ),
      verifyStep(
        Actor.User,
        "assert-frozen-determinism",
        "same wallet allocations and hash across finalized epochs",
        SolanaGenesisSnapshotScenario.assertDeterministic
      )
    )
  }

  /** Check the actual pre-state and exporter before this scenario spends anything.
   * @param ctx - Cluster context.
   */
  static async assertPrerequisites(ctx: ClusterBuildContext): Promise<void> {
    Steps.capitalIndexPath()
    Assert.equal(
      await SolanaLiqSyndicationTool.readWireState(ctx),
      WireState.preLaunch,
      "a fresh PreLaunch cluster is required"
    )
    const deployer = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      SolanaFundingTool.DeployerKeypairName
    )
    const pdas = Steps.addresses(ctx, deployer.publicKey)
    Assert.equal(
      await ctx.solana.connection.getAccountInfo(pdas.trancheState),
      null,
      "a fresh cluster must not already have a tranche state"
    )
    const totals = await Steps.readAccount<Steps.PreLaunchTotals>(
      ctx,
      pdas.globalState,
      "globalState"
    )
    Assert.ok(totals, "the bootstrap must initialize GlobalState")
    Assert.deepEqual(
      [
        totals.totalStakedLiqsol.toString(),
        totals.totalPurchasedLiqsol.toString(),
        totals.totalShares.toString()
      ],
      ["0", "0", "0"],
      "a fresh cluster must have an empty prelaunch book"
    )
  }

  /** Read a fixture wallet through the program's own IDL.
   * @param ctx - Cluster context.
   * @param userName - Persisted signer label.
   * @returns The actual user position and direct pretoken amount.
   */
  static async readFixtureUser(
    ctx: ClusterBuildContext,
    userName: string
  ): Promise<Steps.FixtureUser> {
    const user = SolanaFundingTool.loadKeypair(ctx.config.dataPath, userName)
    const pdas = Steps.addresses(ctx, user.publicKey)
    const position = await Steps.readAccount<Steps.Position>(
      ctx,
      pdas.outpostAccount,
      "outpostAccount"
    )
    Assert.ok(position, `missing real outpost position for ${userName}`)
    const record = await Steps.readAccount<Steps.PretokenRecord>(
      ctx,
      pdas.userPretokenRecord,
      "userPretokenRecord"
    )
    return {
      address: user.publicKey.toBase58(),
      principal: BigInt(position.stakedLiqsol.toString()),
      purchased: BigInt(position.purchasedLiqsol.toString()),
      directPretokens: BigInt(
        record?.totalPretokensPurchased.toString() ?? "0"
      ),
      stakedShares: BigInt(position.stakedShares.toString()),
      purchasedShares: BigInt(position.purchasedShares.toString())
    }
  }

  /** Capture independent controlled positions before reward activity.
   * @param ctx - Cluster context.
   */
  static async recordFixture(ctx: ClusterBuildContext): Promise<void> {
    const active = await SolanaGenesisSnapshotScenario.readFixtureUser(
      ctx,
      Constants.ActiveUser
    )
    const exited = await SolanaGenesisSnapshotScenario.readFixtureUser(
      ctx,
      Constants.ExitedUser
    )
    Assert.equal(active.principal, Constants.ActiveStake)
    Assert.equal(exited.principal, Constants.ExitedStake)
    Assert.ok(
      active.purchased > 0n && active.purchased <= Constants.PurchaseAmount
    )
    Assert.ok(active.directPretokens > 0n)
    Assert.equal(exited.purchased, 0n)
    Assert.equal(exited.directPretokens, 0n)
    ctx.outputs.set(Steps.FixtureKey, {
      active,
      exited,
      readyEpoch: (await ctx.solana.connection.getEpochInfo()).epoch
    })
  }

  /** Observe the real purchase delta, without using capital-index's offsets or replay algorithm.
   * @param ctx - Cluster context.
   */
  static async recordRound(ctx: ClusterBuildContext): Promise<void> {
    const fixture = ctx.outputs.assert(Steps.FixtureKey)
    const user = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      Constants.ActiveUser
    )
    const pdas = Steps.addresses(ctx, user.publicKey)
    const pool = await Steps.readAccount<Steps.PretokenRecord>(
      ctx,
      pdas.poolPretokenRecord,
      "userPretokenRecord"
    )
    const history = await Steps.readAccount<Steps.History>(
      ctx,
      pdas.pretokenPurchaseHistory,
      "pretokenPurchaseHistory"
    )
    Assert.ok(
      pool && history,
      "the real purchase must create/update pool and history records"
    )
    const previous = ctx.outputs.get(Steps.RoundsKey) ?? []
    const purchasedPretokens =
      BigInt(pool.totalPretokensPurchased.toString()) -
      previous.reduce((total, round) => total + round.purchasedPretokens, 0n)
    Assert.ok(
      purchasedPretokens > 0n,
      "the pool yield purchase must be nonzero"
    )
    const purchaseEpoch = history.latestEpoch.toNumber()
    const index = purchaseEpoch - 1 - history.startingEpoch.toNumber()
    Assert.equal(
      BigInt(history.syndPerEpoch[index].toString()),
      fixture.active.principal +
        fixture.active.purchased +
        fixture.exited.principal,
      "the real epoch denominator must contain the complete controlled positions"
    )
    if (previous.length)
      Assert.ok(
        purchaseEpoch > previous[0].purchaseEpoch,
        "the two rounds must occupy distinct epochs"
      )
    ctx.outputs.set(Steps.RoundsKey, [
      ...previous,
      { purchasedPretokens, purchaseEpoch }
    ])
  }

  /** Expected pro-rata pretokens for a controlled constant position, floored once per real purchase.
   * @param user - Position captured before either reward round.
   * @param fixture - The two controlled positions.
   * @param rounds - Independently observed actual pool purchases.
   * @returns The user's expected pretokens (8-decimal base units).
   */
  static expectedYield(
    user: Steps.FixtureUser,
    fixture: Steps.Fixture,
    rounds: Steps.YieldRound[]
  ): bigint {
    const denominator =
      fixture.active.principal +
      fixture.active.purchased +
      fixture.exited.principal
    Assert.ok(denominator > 0n, "fixture principal must be positive")
    return rounds.reduce(
      (total, round) =>
        total +
        ((user.principal + user.purchased) * round.purchasedPretokens) /
          denominator,
      0n
    )
  }

  /** Confirm real on-chain materialization, which the exporter must not double-count.
   * @param ctx - Cluster context.
   */
  static async assertMaterialized(ctx: ClusterBuildContext): Promise<void> {
    const fixture = ctx.outputs.assert(Steps.FixtureKey)
    const user = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      Constants.ActiveUser
    )
    const position = await Steps.readAccount<Steps.Position>(
      ctx,
      Steps.addresses(ctx, user.publicKey).outpostAccount,
      "outpostAccount"
    )
    const expected = SolanaGenesisSnapshotScenario.expectedYield(
      fixture.active,
      fixture,
      ctx.outputs.assert(Steps.RoundsKey)
    )
    Assert.ok(expected > 0n)
    Assert.equal(BigInt(position.accumulatedPretokenYield.toString()), expected)
  }

  /** Wait before the first purchase so both positions have a complete previous epoch.
   * @param ctx - Cluster context.
   */
  static async assertPositionEpochPassed(
    ctx: ClusterBuildContext
  ): Promise<void> {
    await SolanaGenesisSnapshotScenario.assertEpochAfter(
      ctx,
      ctx.outputs.assert(Steps.FixtureKey).readyEpoch
    )
  }

  /** Wait before materializing round one; this is a prelaunch fixture setup wait.
   * @param ctx - Cluster context.
   */
  static async assertFirstRoundEpochPassed(
    ctx: ClusterBuildContext
  ): Promise<void> {
    await SolanaGenesisSnapshotScenario.assertEpochAfter(
      ctx,
      ctx.outputs.assert(Steps.RoundsKey)[0].purchaseEpoch
    )
  }

  /** Wait after the immediate export, on finalized state, to exercise epoch-independent results.
   * @param ctx - Cluster context.
   */
  static async assertExportEpochPassed(
    ctx: ClusterBuildContext
  ): Promise<void> {
    await SolanaGenesisSnapshotScenario.assertEpochAfter(
      ctx,
      Number(ctx.outputs.assert(Steps.FirstSnapshotKey).accounting.epoch),
      true
    )
  }

  /** Poll a real Solana epoch boundary using the shared timing envelope.
   * @param ctx - Cluster context.
   * @param previous - The epoch to advance past.
   * @param finalized - Whether the exporter must already observe the boundary.
   */
  static async assertEpochAfter(
    ctx: ClusterBuildContext,
    previous: number,
    finalized = false
  ): Promise<void> {
    await pollUntil(
      `Solana epoch after ${previous}`,
      async () =>
        (
          await ctx.solana.connection.getEpochInfo(
            finalized ? "finalized" : "confirmed"
          )
        ).epoch > previous,
      Constants.EpochTimeoutMs,
      Constants.PollIntervalMs
    )
  }

  /** Compare every allocation, units, tail, unique address, pool exclusion and backing.
   * @param ctx - Cluster context.
   */
  static async assertImmediateSnapshot(
    ctx: ClusterBuildContext
  ): Promise<void> {
    const snapshot = ctx.outputs.assert(Steps.FirstSnapshotKey)
    const fixture = ctx.outputs.assert(Steps.FixtureKey)
    const rounds = ctx.outputs.assert(Steps.RoundsKey)
    Assert.equal(rounds.length, 2)
    Assert.equal(
      snapshot.accounting.epoch,
      rounds[1].purchaseEpoch.toString(),
      "the first finalized export must exercise the still-open terminal purchase epoch"
    )
    const user = SolanaFundingTool.loadKeypair(
      ctx.config.dataPath,
      Constants.ActiveUser
    )
    const pdas = Steps.addresses(ctx, user.publicKey)
    Assert.equal(snapshot.programId, pdas.liqsolCoreProgram.toBase58())
    const expected = [fixture.active, fixture.exited]
      .map((owner, index) => {
        const yieldAmount = SolanaGenesisSnapshotScenario.expectedYield(
          owner,
          fixture,
          rounds
        )
        const wallet = SolanaFundingTool.loadKeypair(
          ctx.config.dataPath,
          index === 0 ? Constants.ActiveUser : Constants.ExitedUser
        )
        const ownerPdas = Steps.addresses(ctx, wallet.publicKey)
        return {
          address: owner.address,
          outpostAccount: ownerPdas.outpostAccount.toBase58(),
          pretokenRecord:
            index === 0 ? ownerPdas.userPretokenRecord.toBase58() : null,
          syndicatedLiqsol: (index === 0 ? owner.principal : 0n).toString(),
          purchasedLiqsol: owner.purchased.toString(),
          stakedShares: (index === 0 ? owner.stakedShares : 0n).toString(),
          purchasedShares: owner.purchasedShares.toString(),
          directlyPurchasedPretokens: owner.directPretokens.toString(),
          pretokenYield: yieldAmount.toString(),
          totalPretokens: (owner.directPretokens + yieldAmount).toString()
        }
      })
      .sort((a, b) => (a.address < b.address ? -1 : 1))
    Assert.deepEqual(snapshot.balances, expected)
    Assert.equal(
      snapshot.allocationHash,
      createHash("sha256")
        .update(
          JSON.stringify({
            schemaVersion: 1,
            programId: snapshot.programId,
            balances: expected
          })
        )
        .digest("hex"),
      "artifact hash must authenticate the actual unique wallet allocations"
    )
    const activePosition = await Steps.readAccount<Steps.Position>(
      ctx,
      pdas.outpostAccount,
      "outpostAccount"
    )
    Assert.ok(
      SolanaGenesisSnapshotScenario.expectedYield(
        fixture.active,
        fixture,
        rounds
      ) > BigInt(activePosition.accumulatedPretokenYield.toString()),
      "the fixture must exercise actual unmaterialized tail yield, not merely copied stored values"
    )
    const poolPurchases = rounds.reduce(
      (total, round) => total + round.purchasedPretokens,
      0n
    )
    const allocated = expected.reduce(
      (total, wallet) => total + BigInt(wallet.pretokenYield),
      0n
    )
    Assert.equal(
      snapshot.accounting.poolAuthority,
      pdas.poolAuthority.toBase58()
    )
    Assert.equal(snapshot.accounting.poolPretokens, poolPurchases.toString())
    Assert.equal(
      snapshot.accounting.allocatedPretokenYield,
      allocated.toString()
    )
    Assert.equal(
      snapshot.accounting.unallocatedPoolPretokens,
      (poolPurchases - allocated).toString()
    )
    Assert.equal(
      snapshot.accounting.totalPretokensSold,
      (poolPurchases + fixture.active.directPretokens).toString()
    )
    Assert.equal(
      snapshot.accounting.poolBalance,
      (await SolanaLiqSyndicationTool.readPoolBalance(ctx)).toString()
    )
    const yieldState = await SolanaLiqSyndicationTool.readLiqYieldState(ctx)
    const backing =
      BigInt(snapshot.accounting.poolBalance) -
      yieldState.yieldAccumulatedLiqsol
    Assert.equal(snapshot.accounting.backingAvailable, backing.toString())
    Assert.equal(
      snapshot.accounting.maxInitialChainAmount,
      fixture.active.purchased.toString()
    )
    Assert.ok(
      BigInt(snapshot.accounting.ownerlessShares) > 0n,
      "full exit must leave ownerless accrued-yield shares"
    )
    Assert.deepEqual(snapshot.accounting.issues, [])
  }

  /** Changed clock/provenance must not change a frozen genesis allocation.
   * @param ctx - Cluster context.
   */
  static async assertDeterministic(ctx: ClusterBuildContext): Promise<void> {
    const first = ctx.outputs.assert(Steps.FirstSnapshotKey)
    const later = ctx.outputs.assert(Steps.LaterSnapshotKey)
    Assert.ok(BigInt(later.accounting.epoch) > BigInt(first.accounting.epoch))
    Assert.deepEqual(later.balances, first.balances)
    Assert.equal(later.allocationHash, first.allocationHash)
  }
}
