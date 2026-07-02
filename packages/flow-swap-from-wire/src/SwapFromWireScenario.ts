import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterConfig,
  type Logger
} from "@wireio/test-cluster-tool"
import { SwapFromWireScenarioConstants as Constants } from "./SwapFromWireScenarioConstants.js"
import { SwapFromWireScenarioOutputs as Outputs } from "./SwapFromWireScenarioOutputs.js"
import {
  SwapFromWireScenarioUserSteps,
  SwapFromWireScenarioUwritSteps
} from "./steps/index.js"

const {
  SysioContractName,
  SysioContractAccount,
  SysioOpregOperatorstatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts
const { Actor } = Report

const log = getLogger(__filename)

/** The account holding escrowed swap WIRE — `sysio.reserv`'s token balance. */
const ReserveCustodyAccount = SysioContractAccount[SysioContractName.reserv]

/**
 * The WIRE-leg fee split for `wireAmount` at the LIVE cluster fee rate — a
 * thin composition of {@link WireReserveTool.readFeeBps} (the live
 * `sysio.uwrit::uwconfig.fee_bps` the bootstrap's `setconfig` seeded) into
 * {@link WireReserveTool.splitWireFee}, so the flow's book math always matches
 * the depot's, whatever rate the harness configures (a read).
 *
 * @param ctx - The scenario context.
 * @param wireAmount - The gross WIRE leg to split.
 * @returns The {@link WireReserveTool.WireFee} decomposition at the live rate.
 */
async function readWireLegFee(
  ctx: SwapScenarioContext,
  wireAmount: bigint
): Promise<WireReserveTool.WireFee> {
  return WireReserveTool.splitWireFee(
    wireAmount,
    await WireReserveTool.readFeeBps(ctx.wire)
  )
}

/** The from-WIRE uwreq row (src=WIRE, dst=SOLANA), or nothing yet (a read). */
function readFromWireUwreq(ctx: SwapScenarioContext) {
  return ctx.uwreq(Constants.WireChainCode, Constants.SolanaChainCode)
}

/** Whether every `accounts` entry is `OPERATOR_STATUS_ACTIVE` on `sysio.opreg` (a read). */
async function readAllOperatorsActive(
  ctx: SwapScenarioContext,
  accounts: string[]
): Promise<boolean> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: 100 })
  return accounts.every(account => {
    const operator = rows.find(row => row.account === account)
    return (
      operator != null &&
      matchesProtoEnum(
        operator.status,
        SysioOpregOperatorstatus,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      )
    )
  })
}

/**
 * Swap FROM WIRE — the WIRE depot itself is the source chain, driven
 * end-to-end through OPP against the Solana outpost:
 *
 * 1. **SubstrateHealth** — the chain produces blocks; the bootstrap seeded the
 *    SOLANA/SOL/PRIMARY reserve.
 * 2. **UnderwriterCollateral** / **UnderwriterActivation** — the bootstrap
 *    underwriters bond the default collateral on both outposts and flip
 *    `OPERATOR_STATUS_ACTIVE` once the deposits credit.
 * 3. **ProvisionSwapUser** / **ProvisionDepositor** — the Solana recipient
 *    identity + the WIRE depositor (funded from the treasury).
 * 4. **QuoteAndEscrow** — quote `cp_output(dst.wire, dst.chain, wire_in)` off
 *    the destination reserve, snapshot balances, push
 *    `sysio.uwrit::swapfromwire`: the WIRE escrows NOW (depositor −, custody +,
 *    EXACT) and NO uwreq exists yet.
 * 5. **QueueDrain** — the next `sysio.epoch::advance` drains the queue into a
 *    PENDING uwreq with `src = WIRE`, the escrowed `src_amount`, and the
 *    depot-origin bit-63 id tag.
 * 6. **RaceTargetLeg** — underwriters race the TARGET leg only: CONFIRMED with
 *    exactly ONE lock (on SOLANA); at emit time the escrow became dst-reserve
 *    WIRE liquidity net of the WIRE-leg fee (#414) and the chain side was
 *    debited by the target.
 * 7. **RemitAndReceive** — a normal SWAP_REMIT pays the recipient on Solana.
 * 8. **DrainRewards** — custody settles at `before + source − fee` once
 *    `payepoch → sysio.reserv::drainrewards` drains the rewards bucket (#425);
 *    the target-leg lock persists through the challenge window.
 */
export class SwapFromWireScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-from-wire"
  readonly description =
    "Swap FROM WIRE (WIRE depot → Solana): queued escrow, single-leg underwriting, SOL payout, rewards drain"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // ACTIVE gates on real bonds on EVERY registered outpost chain, so the
    // flow's underwriter-activation assertion is meaningful.
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Number(Constants.UnderwriterMinimumBond)
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Number(Constants.UnderwriterMinimumBond)
      }
    ]
  }

  /** The swap flows share the {@link SwapScenarioContext} query surface. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  build(cluster: ClusterBuild<SwapScenarioContext>): void {
    const config = cluster.context.config,
      underwriterAccounts = Array.from(
        { length: config.underwriterCount },
        (_, index) => HarnessConstants.underwriterAccountName(index)
      ),
      writeStepOptions = { timeoutMs: 60_000 },
      relayStepOptions = {
        timeoutMs: Constants.relayDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      drainStepOptions = {
        timeoutMs: Constants.DrainDeadlineMs + Constants.PollDeadlineBufferMs
      },
      raceStepOptions = {
        timeoutMs: Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
      },
      remitStepOptions = {
        timeoutMs: Constants.RemitDeadlineMs + Constants.PollDeadlineBufferMs
      }

    // ── 1. Substrate health — blocks + the bootstrap-seeded reserve ──
    ClusterBuildPhase.create(
      cluster,
      "SubstrateHealth",
      "The chain produces blocks; the SOL reserve is seeded"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "chain-producing",
        "WIRE chain is producing blocks",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            "head_block_num must be positive on a live chain"
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "solana-reserve-seeded",
        "bootstrap seeded the SOLANA/SOL/PRIMARY reserve",
        async ctx => {
          // reserveBook asserts the row exists (throws when absent).
          await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
        }
      )
    )

    // ── 2. Underwriter bonds on both outposts → ACTIVE (deposits credit) ──
    WireUnderwriterTool.deposit(
      cluster,
      "UnderwriterCollateral",
      "Bond the default underwriter collateral on both outposts",
      writeStepOptions,
      underwriterAccounts,
      WireUnderwriterTool.load(null, config.underwriterCount)
    )
    ClusterBuildPhase.create(
      cluster,
      "UnderwriterActivation",
      "Underwriters flip ACTIVE once the bonds credit"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "underwriters-active",
        `underwriters (${underwriterAccounts.join(", ")}) become OPERATOR_STATUS_ACTIVE`,
        async ctx => {
          await pollUntil(
            "every underwriter ACTIVE on sysio.opreg",
            () => readAllOperatorsActive(ctx, underwriterAccounts),
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      )
    )

    // ── 3. The Solana recipient + the WIRE depositor ──
    SwapUserIdentities.ensure(
      cluster,
      "ProvisionSwapUser",
      "Provision the swap recipient's Ethereum + Solana identity",
      {}
    )
    ClusterBuildPhase.create(
      cluster,
      "ProvisionDepositor",
      "Provision the WIRE depositor, funded from the treasury"
    ).push(
      SwapFromWireScenarioUserSteps.provisionWire<SwapScenarioContext>(
        Actor.User,
        "provision-depositor",
        `provision ${Constants.DepositorAccount} + fund ${Constants.DepositorFunding} WIRE base units from the treasury`,
        writeStepOptions,
        Constants.DepositorAccount,
        Constants.DepositorFunding
      )
    )

    // ── 4. Quote off the destination curve; escrow is immediate and REAL ──
    ClusterBuildPhase.create(
      cluster,
      "QuoteAndEscrow",
      "Quote the from-WIRE target; swapfromwire escrows NOW — no uwreq yet"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.User,
        "quote-target",
        "compute the from-WIRE target from the destination reserve curve",
        async ctx => {
          // src == WIRE quotes against the DESTINATION reserve only:
          // cp_output(dst.wire, dst.chain, wire_in) — mirror the depot's math
          // via WireReserveTool.cpOutput.
          const book = await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
          const targetSolanaAmount = WireReserveTool.cpOutput(
            book.wire,
            book.chain,
            Constants.SourceWireUnits
          )
          Assert.ok(
            targetSolanaAmount > 0n,
            "constant-product target must be positive"
          )
          ctx.outputs
            .set(Outputs.solanaReserveBefore, book)
            .set(Outputs.targetSolanaAmount, targetSolanaAmount)
          log.info(`[FromWire] curve target = ${targetSolanaAmount} lamports`)
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.User,
        "snapshot-balances",
        "snapshot depositor WIRE / sysio.reserv custody / recipient lamports baselines",
        async ctx => {
          const depositorWireBefore = await ctx.wire.getWireBalance(
              Constants.DepositorAccount
            ),
            reserveCustodyBefore = await ctx.wire.getWireBalance(
              ReserveCustodyAccount
            ),
            swapUser = ctx.outputs.assert(swapUserOutputKey()),
            recipientLamportsBefore = await ctx.solana.getLamports(
              swapUser.solanaKeypair.publicKey
            )
          Assert.ok(
            depositorWireBefore >= Constants.SourceWireUnits,
            `depositor must hold at least ${Constants.SourceWireUnits} WIRE base units to escrow`
          )
          ctx.outputs
            .set(Outputs.depositorWireBefore, depositorWireBefore)
            .set(Outputs.reserveCustodyBefore, reserveCustodyBefore)
            .set(Outputs.recipientLamportsBefore, recipientLamportsBefore)
        }
      ),
      SwapFromWireScenarioUwritSteps.swapfromwire<SwapScenarioContext>(
        Actor.User,
        "push-swapfromwire",
        `${Constants.DepositorAccount} pushes sysio.uwrit::swapfromwire for ${Constants.SourceWireUnits} WIRE base units`,
        writeStepOptions,
        Constants.DepositorAccount,
        Constants.SourceWireUnits,
        Constants.SolanaChainCode,
        Constants.SolanaTokenCode,
        Constants.PrimaryReserveCode,
        Constants.VarianceToleranceBps
      ),
      verifyStep<SwapScenarioContext>(
        Actor.User,
        "escrow-exact",
        "escrow is immediate and REAL: depositor WIRE down, sysio.reserv custody up (EXACT)",
        async ctx => {
          const depositorWireBefore = ctx.outputs.assert(
              Outputs.depositorWireBefore
            ),
            reserveCustodyBefore = ctx.outputs.assert(
              Outputs.reserveCustodyBefore
            )
          Assert.strictEqual(
            await ctx.wire.getWireBalance(Constants.DepositorAccount),
            depositorWireBefore - Constants.SourceWireUnits,
            "depositor WIRE must decrement by exactly the escrowed source units"
          )
          Assert.strictEqual(
            await ctx.wire.getWireBalance(ReserveCustodyAccount),
            reserveCustodyBefore + Constants.SourceWireUnits,
            "sysio.reserv custody must increment by exactly the escrowed source units"
          )
        }
      )
    )

    // ── 5. Next epoch advance drains the queue into the PENDING uwreq ──
    ClusterBuildPhase.create(
      cluster,
      "QueueDrain",
      "The next epoch advance drains the from-WIRE queue into a PENDING uwreq"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "queue-drained",
        "a src=WIRE uwreq appears with the escrowed amount and the depot-origin id tag",
        async ctx => {
          await pollUntil(
            "from-WIRE UWREQ row appears",
            async () => (await readFromWireUwreq(ctx)) != null,
            Constants.DrainDeadlineMs,
            Constants.PollIntervalMs
          )
          const request = await readFromWireUwreq(ctx)
          Assert.strictEqual(
            slugValue(request.src_token_code),
            Constants.WireTokenCode,
            "the drained uwreq's source token must be WIRE"
          )
          Assert.strictEqual(
            Number(request.src_amount),
            Number(Constants.SourceWireUnits),
            "the drained uwreq must carry the escrowed source amount"
          )
          // Depot-origin id space: bit 63 tags queued from-WIRE requests.
          Assert.strictEqual(
            BigInt(request.id) & Constants.DepotOriginIdBit,
            Constants.DepotOriginIdBit,
            "the drained uwreq id must carry the depot-origin bit-63 tag"
          )
        },
        drainStepOptions
      )
    )

    // ── 6. Single-leg race: CONFIRMED, ONE lock on SOLANA, emit-time books ──
    ClusterBuildPhase.create(
      cluster,
      "RaceTargetLeg",
      "Underwriters race the target leg only; the depot applies the books at emit time"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "confirmed-single-lock",
        "uwreq flips CONFIRMED with exactly ONE lock, on the SOLANA target leg",
        async ctx => {
          await pollUntil(
            "from-WIRE UWREQ status=CONFIRMED",
            async () => {
              const request = await readFromWireUwreq(ctx)
              return (
                request != null &&
                matchesProtoEnum(
                  request.status,
                  SysioUwritUnderwriterequeststatus,
                  SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
                )
              )
            },
            Constants.RaceDeadlineMs,
            Constants.PollIntervalMs
          )
          // The WIRE source leg carries no bond — only the SOL target leg locks.
          const request = await readFromWireUwreq(ctx)
          const locks = await ctx.locksForUwreq(Number(request.id))
          Assert.strictEqual(
            locks.length,
            1,
            "the WIRE source leg carries no bond — exactly one lock expected"
          )
          Assert.strictEqual(
            slugValue(locks[0].chain_code),
            Constants.SolanaChainCode,
            "the single lock must sit on the SOLANA target leg"
          )
        },
        raceStepOptions
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "emit-time-books",
        "the escrow became dst-reserve WIRE liquidity (post-fee net) and the chain side was debited",
        async ctx => {
          // Emit-time books: #414's `applyfromwire` skims the WIRE-leg fee off
          // the escrowed input, so the reserve's WIRE side grows by the
          // post-fee NET, not the gross escrow.
          const booksBefore = ctx.outputs.assert(Outputs.solanaReserveBefore),
            targetSolanaAmount = ctx.outputs.assert(Outputs.targetSolanaAmount),
            fromWireFee = await readWireLegFee(ctx, Constants.SourceWireUnits),
            reserve = await ctx.reserveBook(
              Constants.SolanaChainCode,
              Constants.SolanaTokenCode,
              Constants.PrimaryReserveCode
            )
          Assert.strictEqual(
            reserve.wire,
            booksBefore.wire + fromWireFee.net,
            "the reserve's WIRE side must grow by the post-fee net escrow"
          )
          Assert.strictEqual(
            reserve.chain,
            booksBefore.chain - targetSolanaAmount,
            "the reserve's chain side must be debited by the target amount"
          )
        }
      )
    )

    // ── 7. SWAP_REMIT pays the recipient on Solana ──
    ClusterBuildPhase.create(
      cluster,
      "RemitAndReceive",
      "SWAP_REMIT lands on the SOL outpost; the recipient is paid"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.SolanaOutpost,
        "recipient-receives-solana",
        "recipient's SOL balance bumps by ~targetAmount (within variance tolerance)",
        async ctx => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey()),
            recipientLamportsBefore = ctx.outputs.assert(
              Outputs.recipientLamportsBefore
            ),
            targetSolanaAmount = ctx.outputs.assert(Outputs.targetSolanaAmount),
            drift = WireReserveTool.varianceDrift(
              targetSolanaAmount,
              Constants.VarianceToleranceBps
            )
          await pollUntil(
            "from-WIRE recipient receives SOL",
            async () => {
              const current = await ctx.solana.getLamports(
                swapUser.solanaKeypair.publicKey
              )
              return (
                current >=
                recipientLamportsBefore + Number(targetSolanaAmount - drift)
              )
            },
            Constants.RemitDeadlineMs,
            Constants.PollIntervalMs
          )
          const finalLamports = await ctx.solana.getLamports(
            swapUser.solanaKeypair.publicKey
          )
          log.info(
            `[FromWire] recipient received ${finalLamports - recipientLamportsBefore} lamports`
          )
          Assert.ok(
            finalLamports - recipientLamportsBefore > 0,
            "the recipient's lamport balance must have increased"
          )
        },
        remitStepOptions
      )
    )

    // ── 8. Custody settles post rewards drain; the lock persists ──
    ClusterBuildPhase.create(
      cluster,
      "DrainRewards",
      "Custody settles once payepoch drains the rewards bucket; the lock persists"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "custody-settled",
        "custody holds the escrow minus the FULL WIRE-leg fee; the target-leg lock persists",
        async ctx => {
          // FROM-WIRE never pays the escrow back out — it became reserve
          // liquidity. Custody holds the deposit MINUS the FULL WIRE-leg fee:
          // the emissions half goes to the treasury (#414), and as of #425 the
          // rewards half no longer lingers — payepoch drains the rewards bucket
          // each epoch (sysio.reserv::drainrewards). The drain can land just
          // after the SOL-recipient poll succeeds, so poll until custody
          // settles at the fully-drained value rather than snapshotting
          // mid-race.
          const reserveCustodyBefore = ctx.outputs.assert(
              Outputs.reserveCustodyBefore
            ),
            fromWireFee = await readWireLegFee(ctx, Constants.SourceWireUnits),
            expectedCustody =
              reserveCustodyBefore + Constants.SourceWireUnits - fromWireFee.fee
          await pollUntil(
            "rewards bucket drained from sysio.reserv custody",
            async () =>
              (await ctx.wire.getWireBalance(ReserveCustodyAccount)) ===
              expectedCustody,
            Constants.DrainDeadlineMs,
            Constants.PollIntervalMs
          )
          Assert.strictEqual(
            await ctx.wire.getWireBalance(ReserveCustodyAccount),
            expectedCustody,
            "custody must settle at baseline + escrow − full WIRE-leg fee"
          )
          // Challenge window: the target-leg lock persists after delivery.
          const request = await readFromWireUwreq(ctx)
          Assert.ok(request != null, "the from-WIRE uwreq must still exist")
          Assert.strictEqual(
            (await ctx.locksForUwreq(Number(request.id))).length,
            1,
            "the target-leg lock must persist through the challenge window"
          )
        },
        drainStepOptions
      )
    )
  }
}
