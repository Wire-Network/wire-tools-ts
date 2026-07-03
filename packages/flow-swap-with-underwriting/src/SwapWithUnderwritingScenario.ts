import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger, type Logger } from "@wireio/shared"
import {
  ClusterBuildPhase,
  Constants as ClusterConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  swapUserOutputKey,
  verifyStep,
  type Books,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type ClusterConfig
} from "@wireio/test-cluster-tool"
import { SwapWithUnderwritingScenarioConstants as Constants } from "./SwapWithUnderwritingScenarioConstants.js"
import { SwapWithUnderwritingScenarioSwapSteps as SwapSteps } from "./steps/index.js"

const {
  SysioContractName,
  SysioOpregOperatorstatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts
const { Actor } = Report
const log = getLogger(__filename)

/** An operator's row on `sysio.opreg::operators` by account name (a read). */
async function readUnderwriterRow(
  ctx: ClusterBuildContext,
  account: string
): Promise<SysioContracts.SysioOpregOperatorEntryType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: 100 })
  return rows.find(row => row.account === account)
}

/**
 * Full-hop (token → WIRE → token) swap quote over a pre-request book
 * snapshot — a thin composition of {@link WireReserveTool.cpOutput} over the
 * SAME `Books` the four-sided assertion later replays (the flow snapshots the
 * rows once so quote and book math share one baseline, rather than re-reading
 * the table via {@link WireReserveTool.swapquote}). Both hops are fee-less
 * constant products (the fee only appears in the settled books, inside the
 * user's variance tolerance).
 *
 * @param books - The source + destination reserve books (depot 9-decimal frame).
 * @param sourceAmount - Source amount in depot 9-decimal units.
 * @returns The destination amount in depot units, or `0n` when either hop has
 *   no liquidity — the on-chain "no quote available" convention.
 */
function swapquote(books: Books, sourceAmount: bigint): bigint {
  const wireIntermediate = WireReserveTool.cpOutput(
    books.src.chain,
    books.src.wire,
    sourceAmount
  )
  if (wireIntermediate === 0n) return 0n
  return WireReserveTool.cpOutput(
    books.dst.wire,
    books.dst.chain,
    wireIntermediate
  )
}

/**
 * Flow: SWAP_REQUEST → underwriter race → SWAP_REMIT (bidirectional
 * Ethereum ↔ Solana) — end-to-end through real outposts.
 *
 * On top of the bootstrap: bond every underwriter's collateral on both
 * outposts (the OPP DEPOSIT_REQUEST round-trip flips `uwrit.a` ACTIVE),
 * provision the swap end-user, then:
 *
 * **Phase A — Ethereum → Solana.** User calls `ReserveManager.requestSwap`
 * with native ETH; batch operators relay the SWAP_REQUEST envelope to the
 * depot; underwriter daemons commit on both outposts; depot resolves the race
 * + settles the four-sided reserve books + emits SWAP_REMIT; the SOL outpost's
 * `handle_swap_remit` drains lamports from the Reserve PDA to the user.
 *
 * **Phase B — Solana → Ethereum.** Same flow inverted via the SOL outpost's
 * `request_swap` ix; the ETH outpost's `_handleSwapRemit` settles ETH to the
 * user's address (depot-frame 9-decimal target × 1e9 → wei).
 *
 * The canonical proof in each direction is the **destination user balance
 * bump** — which only happens if every protocol surface (six per direction,
 * twelve total) works end-to-end.
 */
export class SwapWithUnderwritingScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-with-underwriting"
  readonly description =
    "Bidirectional Ethereum ↔ Solana swap settled by an underwriter race (Phase A + inverse Phase B)"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // The depot's `meets_role_min` rejects non-bootstrapped underwriters when
    // the config is empty — `uwrit.a` must flip ACTIVE for the race to land
    // any commits. The UnderwriterCollateral phase bonds
    // `WireUnderwriterTool.DefaultAmount` on both chains, so configuring the
    // requirement at the same threshold lets `reevaluate_eligibility` call
    // `processuw` to set status=ACTIVE on the second deposit round-trip.
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const config = cluster.context.config,
      firstUnderwriter = ClusterConstants.underwriterAccountName(0),
      underwriterAccounts = Array.from(
        { length: config.underwriterCount },
        (_, index) => ClusterConstants.underwriterAccountName(index)
      ),
      requestStepOptions = { timeoutMs: Constants.RequestStepTimeoutMs },
      underwriterGateOptions = {
        timeoutMs:
          Constants.underwriterActiveDeadlineMs() +
          Constants.PollDeadlineBufferMs
      },
      uwreqStepOptions = {
        timeoutMs: Constants.UwreqDeadlineMs + Constants.PollDeadlineBufferMs
      },
      raceStepOptions = {
        timeoutMs: Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
      },
      remitStepOptions = {
        timeoutMs: Constants.RemitDeadlineMs + Constants.PollDeadlineBufferMs
      }

    // ── 1. Bond underwriter collateral on both outposts. The bootstrap
    //       provisions the underwriter accounts but leaves the bonds to the
    //       flow; each per-(chain, token) deposit is its own Step. ──
    WireUnderwriterTool.planCollateralDeposit(
      cluster,
      "UnderwriterCollateral",
      "Bond every underwriter's collateral on the Ethereum + Solana outposts",
      requestStepOptions,
      underwriterAccounts,
      config.underwriterCollateral ??
        WireUnderwriterTool.load(null, config.underwriterCount)
    )

    // ── 2. The swap end-user's paired ETH + SOL identity (+ SOL airdrop) ──
    SwapUserIdentities.planIdentityProvisioning(
      cluster,
      "SwapUser",
      "Provision the swap end-user's Ethereum + Solana identities",
      {}
    )

    // ── 3. Bootstrap state (chain health + seeded reserves) ──
    ClusterBuildPhase.create(
      cluster,
      "BootstrapState",
      "WIRE chain is live and the bootstrap seeded both PRIMARY reserves"
    ).push(
      verifyStep(
        Actor.Sysio,
        "wire-chain-producing",
        "WIRE chain is producing blocks",
        async (ctx: SwapScenarioContext) => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            `head_block_num must be positive, got ${info.head_block_num}`
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "reserves-seeded",
        "bootstrap seeded ETHEREUM/ETH/PRIMARY + SOLANA/SOL/PRIMARY reserves",
        async (ctx: SwapScenarioContext) => {
          // `reserveBook` throws when the row is absent — presence IS the check.
          await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrimaryReserveCode
          )
          await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
        }
      )
    )

    // ── Phase A: Ethereum → Solana ──
    ClusterBuildPhase.create(
      cluster,
      "PhaseA",
      "Ethereum → Solana swap settled by the underwriter race"
    ).push(
      // The collateral DEPOSIT_REQUESTs must complete their OPP round-trip
      // (outpost → depot `depositinle`) before the depot marks the underwriter
      // ACTIVE. Without an ACTIVE underwriter no commits land for SWAP_REQUEST
      // and the race never resolves.
      verifyStep(
        Actor.Underwriter,
        "underwriter-active",
        `${firstUnderwriter} flips OPERATOR_STATUS_ACTIVE once its deposits credit`,
        async (ctx: SwapScenarioContext) => {
          await pollUntil(
            `${firstUnderwriter} ACTIVE`,
            async () => {
              const operator = await readUnderwriterRow(ctx, firstUnderwriter)
              return (
                operator != null &&
                matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                )
              )
            },
            Constants.underwriterActiveDeadlineMs(),
            Constants.LongPollIntervalMs
          )
        },
        underwriterGateOptions
      ),
      verifyStep(
        Actor.Sysio,
        "swapquote-ethereum-to-solana",
        "compute the ETH→SOL swapquote + snapshot books and the user's SOL balance",
        async (ctx: SwapScenarioContext) => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey()),
            booksBefore: Books = {
              src: await ctx.reserveBook(
                Constants.EthereumChainCode,
                Constants.EthereumTokenCode,
                Constants.PrimaryReserveCode
              ),
              dst: await ctx.reserveBook(
                Constants.SolanaChainCode,
                Constants.SolanaTokenCode,
                Constants.PrimaryReserveCode
              )
            }
          // Scale source wei (1e18) → depot 9-decimal units so the
          // constant-product math operates on the reserve books' magnitude;
          // for SOL the depot unit IS the lamport, so the quote needs no
          // outbound scaling.
          const quote = swapquote(
            booksBefore,
            Constants.SourceEthereumWei / Constants.WeiPerDepotUnit
          )
          Assert.ok(quote > 0n, "ETH→SOL swapquote returned no quote")
          ctx.outputs
            .set(Constants.PhaseATargetAmountKey, quote)
            .set(Constants.PhaseABooksBeforeKey, booksBefore)
            .set(
              Constants.PhaseASolanaBalanceBeforeKey,
              await ctx.solana.getLamports(swapUser.solanaKeypair.publicKey)
            )
          log.info(
            `[PhaseA] swapquote = ${quote} → targetAmount = ${quote} lamports`
          )
        }
      ),
      SwapSteps.planRequestSwapEthereum(
        Actor.User,
        "request-swap-ethereum",
        `user calls ReserveManager.requestSwap (${Constants.SourceEthereumWei} wei ETH → SOL)`,
        requestStepOptions,
        {
          sourceTokenCode: BigInt(Constants.EthereumTokenCode),
          sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
          sourceAmountWei: Constants.SourceEthereumWei,
          targetChainCode: BigInt(Constants.SolanaChainCode),
          targetTokenCode: BigInt(Constants.SolanaTokenCode),
          targetReserveCode: BigInt(Constants.PrimaryReserveCode),
          targetToleranceBps: Constants.ToleranceBps
        }
      ),
      verifyStep(
        Actor.Sysio,
        "uwreq-pending",
        "depot creates the ETH→SOL UWREQ row",
        async (ctx: SwapScenarioContext) => {
          await pollUntil(
            "PhaseA UWREQ row appears",
            async () =>
              (await ctx.uwreq(
                Constants.EthereumChainCode,
                Constants.SolanaChainCode
              )) != null,
            Constants.UwreqDeadlineMs,
            Constants.LongPollIntervalMs
          )
        },
        uwreqStepOptions
      ),
      verifyStep(
        Actor.Underwriter,
        "uwreq-confirmed",
        "UWREQ transitions to CONFIRMED with a winning underwriter",
        async (ctx: SwapScenarioContext) => {
          await pollUntil(
            "PhaseA UWREQ status=CONFIRMED",
            async () => {
              const request = await ctx.uwreq(
                Constants.EthereumChainCode,
                Constants.SolanaChainCode
              )
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
            Constants.LongPollIntervalMs
          )
        },
        raceStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "four-sided-books",
        "emit-time four-sided reserve accounting + two persistent locks",
        async (ctx: SwapScenarioContext) => {
          // The reserve books move in the SAME transaction that resolves the
          // race — before the SWAP_REMIT ever leaves the depot — so they are
          // already final here, ahead of the destination payout:
          //   src: chain += src_amount, wire -= w
          //   dst: wire  += w − fee,    chain -= dst_amount
          // with w = cp_output(src.chain, src.wire, src_amount) on the
          // pre-swap source row, and the WIRE-leg fee skimmed in the hop
          // (routed to rewards custody + emissions out) at the LIVE
          // `sysio.uwrit::uwconfig.fee_bps` rate the bootstrap seeded.
          const booksBefore = ctx.outputs.assert(
              Constants.PhaseABooksBeforeKey
            ),
            targetAmount = ctx.outputs.assert(Constants.PhaseATargetAmountKey),
            sourceAmountDepot =
              Constants.SourceEthereumWei / Constants.WeiPerDepotUnit,
            wireIntermediate = WireReserveTool.cpOutput(
              booksBefore.src.chain,
              booksBefore.src.wire,
              sourceAmountDepot
            ),
            phaseAFee = WireReserveTool.splitWireFee(
              wireIntermediate,
              await WireReserveTool.readFeeBps(ctx.wire)
            )

          const src = await ctx.reserveBook(
              Constants.EthereumChainCode,
              Constants.EthereumTokenCode,
              Constants.PrimaryReserveCode
            ),
            dst = await ctx.reserveBook(
              Constants.SolanaChainCode,
              Constants.SolanaTokenCode,
              Constants.PrimaryReserveCode
            )
          Assert.strictEqual(
            src.chain,
            booksBefore.src.chain + sourceAmountDepot,
            "source reserve chain side gains the escrowed amount"
          )
          Assert.strictEqual(
            src.wire,
            booksBefore.src.wire - wireIntermediate,
            "source reserve wire side gives up the full gross intermediate"
          )
          Assert.strictEqual(
            dst.wire,
            booksBefore.dst.wire + phaseAFee.net,
            "destination reserve wire side gains the post-fee net"
          )
          Assert.strictEqual(
            dst.chain,
            booksBefore.dst.chain - targetAmount,
            "destination reserve chain side pays out the target amount"
          )
          // The w hop is internal, but the fee is skimmed inside it — so
          // Σ reserve_wire_amount across the pair drops by exactly the fee
          // (the emissions half leaves custody, the rewards half moves to
          // the bucket).
          Assert.strictEqual(
            src.wire + dst.wire,
            booksBefore.src.wire + booksBefore.dst.wire - phaseAFee.fee,
            "Σ wire across the pair drops by exactly the WIRE-leg fee"
          )

          // Both legs locked, and the locks PERSIST (wall-clock challenge
          // window — never released by delivery).
          const request = await ctx.uwreq(
            Constants.EthereumChainCode,
            Constants.SolanaChainCode
          )
          Assert.ok(request, "PhaseA UWREQ row must exist")
          const locks = await ctx.locksForUwreq(Number(request.id))
          Assert.strictEqual(
            locks.length,
            2,
            "exactly two persistent locks back the UWREQ"
          )
        }
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "solana-payout",
        "user's SOL balance bumps by ~targetAmount",
        async (ctx: SwapScenarioContext) => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey()),
            balanceBefore = ctx.outputs.assert(
              Constants.PhaseASolanaBalanceBeforeKey
            ),
            targetAmount = ctx.outputs.assert(Constants.PhaseATargetAmountKey)
          await pollUntil(
            "PhaseA user receives SOL",
            async () => {
              const current = await ctx.solana.getLamports(
                  swapUser.solanaKeypair.publicKey
                ),
                drift = WireReserveTool.varianceDrift(
                  targetAmount,
                  Constants.ToleranceBps
                )
              return current >= balanceBefore + Number(targetAmount - drift)
            },
            Constants.RemitDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const finalBalance = await ctx.solana.getLamports(
              swapUser.solanaKeypair.publicKey
            ),
            received = BigInt(finalBalance - balanceBefore)
          Assert.ok(
            received > 0n,
            `expected a positive SOL payout, received ${received}`
          )
          log.info(
            `[PhaseA] user received ${received} lamports (target=${targetAmount})`
          )
        },
        remitStepOptions
      )
    )

    // ── Phase B: Solana → Ethereum (inverse) ──
    ClusterBuildPhase.create(
      cluster,
      "PhaseB",
      "Solana → Ethereum swap (inverse direction)"
    ).push(
      verifyStep(
        Actor.Sysio,
        "swapquote-solana-to-ethereum",
        "compute the SOL→ETH swapquote + snapshot the user's ETH balance",
        async (ctx: SwapScenarioContext) => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey()),
            books: Books = {
              src: await ctx.reserveBook(
                Constants.SolanaChainCode,
                Constants.SolanaTokenCode,
                Constants.PrimaryReserveCode
              ),
              dst: await ctx.reserveBook(
                Constants.EthereumChainCode,
                Constants.EthereumTokenCode,
                Constants.PrimaryReserveCode
              )
            }
          // Lamports are already depot 9-decimal units — no inbound scaling.
          // The quote is the depot-frame target riding the OPP envelope; the
          // ETH outpost scales it × 1e9 → wei when settling the SWAP_REMIT.
          const quote = swapquote(books, Constants.SourceSolanaLamports)
          Assert.ok(quote > 0n, "SOL→ETH swapquote returned no quote")
          ctx.outputs
            .set(Constants.PhaseBTargetAmountDepotKey, quote)
            .set(
              Constants.PhaseBEthereumBalanceBeforeKey,
              await ctx.ethereum.provider.getBalance(
                swapUser.ethereumWallet.address
              )
            )
          log.info(
            `[PhaseB] swapquote = ${quote} → depotUnits=${quote} wei=${quote * Constants.WeiPerDepotUnit}`
          )
        }
      ),
      SwapSteps.planRequestSwapSolana(
        Actor.User,
        "request-swap-solana",
        `user calls opp_outpost::request_swap (${Constants.SourceSolanaLamports} lamports SOL → ETH)`,
        requestStepOptions,
        {
          sourceTokenCode: BigInt(Constants.SolanaTokenCode),
          sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
          sourceAmount: Constants.SourceSolanaLamports,
          targetChainCode: BigInt(Constants.EthereumChainCode),
          targetTokenCode: BigInt(Constants.EthereumTokenCode),
          targetReserveCode: BigInt(Constants.PrimaryReserveCode),
          targetToleranceBps: Constants.ToleranceBps
        }
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "ethereum-payout",
        "user's ETH balance bumps by ~targetAmount",
        async (ctx: SwapScenarioContext) => {
          const swapUser = ctx.outputs.assert(swapUserOutputKey()),
            balanceBefore = ctx.outputs.assert(
              Constants.PhaseBEthereumBalanceBeforeKey
            ),
            targetAmountWei =
              ctx.outputs.assert(Constants.PhaseBTargetAmountDepotKey) *
              Constants.WeiPerDepotUnit
          await pollUntil(
            "PhaseB user receives ETH",
            async () => {
              const current = await ctx.ethereum.provider.getBalance(
                  swapUser.ethereumWallet.address
                ),
                drift = WireReserveTool.varianceDrift(
                  targetAmountWei,
                  Constants.ToleranceBps
                )
              return current >= balanceBefore + (targetAmountWei - drift)
            },
            Constants.RemitDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const finalBalance = await ctx.ethereum.provider.getBalance(
              swapUser.ethereumWallet.address
            ),
            received = finalBalance - balanceBefore
          Assert.ok(
            received > 0n,
            `expected a positive ETH payout, received ${received}`
          )
          log.info(
            `[PhaseB] user received ${received} wei (targetWei=${targetAmountWei})`
          )
        },
        remitStepOptions
      )
    )
  }
}
