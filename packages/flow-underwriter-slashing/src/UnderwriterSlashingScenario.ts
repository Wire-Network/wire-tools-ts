import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger, type Logger } from "@wireio/shared"
import {
  ClusterBuildPhase,
  Constants as ClusterConstants,
  FlowScenario,
  Report,
  Steps,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  verifyStep,
  type Books,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type OutputKey
} from "@wireio/cluster-tool"
import { UnderwriterSlashingScenarioConstants as Constants } from "./UnderwriterSlashingScenarioConstants.js"
import { UnderwriterSlashingScenarioOutputs as Outputs } from "./UnderwriterSlashingScenarioOutputs.js"
import {
  UnderwriterSlashingScenarioChallengeSteps as ChallengeSteps,
  UnderwriterSlashingScenarioSwapSteps as SwapSteps
} from "./steps/index.js"

const {
  SysioContractAccount,
  SysioContractName,
  SysioChalgUwchalBallot,
  SysioChalgUwchalVerdict,
  SysioOpregOperatorstatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts
const { Actor } = Report
const log = getLogger(__filename)

/**
 * Full-hop (token → WIRE → token) swap quote over a pre-request book
 * snapshot — the same thin {@link WireReserveTool.cpOutput} composition the
 * other swap flows quote with (both hops fee-less constant products; the fee
 * only appears in the settled books, inside the user's variance tolerance).
 */
function swapquote(books: Books, sourceAmount: bigint): bigint {
  const wireIntermediate = WireReserveTool.cpOutput(books.src.chain, books.src.wire, sourceAmount)
  if (wireIntermediate === 0n) return 0n
  return WireReserveTool.cpOutput(books.dst.wire, books.dst.chain, wireIntermediate)
}

/**
 * Flow: the bonded, council-adjudicated underwriter challenge (WIRE-297) —
 * end-to-end against a live cluster. The in-repo C++ suite covers the chalg
 * actions in isolation; this flow covers the trigger + slash economics on the
 * REAL pipeline: real swaps, a real underwriter daemon winning real races,
 * real locks, and the deferred-slash collateral debit.
 *
 * Substrate: two identical ETH→SOL swaps (flow-swap-with-underwriting's
 * Phase A, twice), yielding two CONFIRMED commitments by the same winning
 * underwriter — proving challenges are per-commitment, not per-underwriter.
 *
 * Order matters: BOTH swaps confirm before ANY challenge, because the upheld
 * challenge slashes the cluster's only underwriter (a SLASHED underwriter can
 * win no further races). The REJECTED challenge therefore runs first:
 *
 * 1. **ChallengeRejected (commitment B).** The challenger files + escrows the
 *    bond; all three Tier-1 voters ballot REJECT_FORFEIT; `chkuwchal` resolves
 *    REJECTED_FORFEIT — the bond is CREDITED to the wrongly-challenged
 *    underwriter, the lock holds clear, the operator stays ACTIVE, and the
 *    collateral is untouched. The underwriter then pulls the forfeit via
 *    `claimbond`.
 * 2. **ChallengeUpheld (commitment A).** Same filing; three UPHOLD ballots;
 *    `chkuwchal` resolves UPHELD — the underwriter flips SLASHED, the locks
 *    sweep through `releaselock`'s deferred-slash branch (locked collateral
 *    debited, outbound SLASH attestations queued), the uwreq completes, and the
 *    bond is credited back to the challenger, who pulls it via `claimbond`.
 *    Only then does `sysio.chalg` reach zero WIRE custody.
 *
 * Bonds are CREDITED at resolution and moved only by `claimbond`, so each
 * verdict is asserted twice: once that resolution moved no WIRE (the credit
 * exists, balances are unchanged), and once that the pull delivered it. That
 * split is the point — `chkuwchal` can run inline under the epoch tick, where
 * `sysio.token::transfer`'s `require_recipient(to)` would run the recipient's
 * own code and let it abort epoch advancement.
 */
export class UnderwriterSlashingScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-underwriter-slashing"
  readonly description =
    "Two underwritten swaps; a rejected challenge forfeits its bond to the underwriter, an upheld challenge slashes the winner via the Tier-1 vote"

  override readonly defaults: ClusterBuildOptions = {
    // The swaps ride the bootstrap-seeded mock PRIMARY reserves — `regreserve`
    // is epoch-0-gated by the depot, so seeding must ride the bootstrap.
    enableMockReserves: true,
    epochDurationSec: Constants.EpochDurationSec,
    // The depot's `meets_role_min` rejects non-bootstrapped underwriters when
    // the config is empty — the underwriter must flip ACTIVE for the races to
    // land commits (see flow-swap-with-underwriting for the full rationale).
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

  override createContext(config: ClusterConfig, log: Logger): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const config = cluster.context.config,
      firstUnderwriter = ClusterConstants.underwriterLabel(0),
      underwriterLabels = Array.from({ length: config.underwriterCount }, (_, index) =>
        ClusterConstants.underwriterLabel(index)
      ),
      requestStepOptions = { timeoutMs: Constants.RequestStepTimeoutMs },
      underwriterGateOptions = {
        timeoutMs: Constants.underwriterActiveDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      raceStepOptions = {
        timeoutMs: Constants.UwreqDeadlineMs + Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
      },
      resolveStepOptions = {
        timeoutMs: Constants.ResolveDeadlineMs + Constants.PollDeadlineBufferMs
      }

    // ── 1. Underwriter collateral on both outposts (flips the winner ACTIVE) ──
    WireUnderwriterTool.planCollateralDeposit(
      cluster,
      "UnderwriterCollateral",
      "Bond every underwriter's collateral on the Ethereum + Solana outposts",
      requestStepOptions,
      underwriterLabels,
      config.underwriterCollateral ?? WireUnderwriterTool.load(null, config.underwriterCount)
    )

    // ── 2. The swap end-user's paired ETH + SOL identity ──
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
          Assert.ok(Number(info.head_block_num) > 0, `head_block_num must be positive, got ${info.head_block_num}`)
        }
      ),
      verifyStep(
        Actor.Sysio,
        "reserves-seeded",
        "bootstrap seeded ETHEREUM/ETH/PRIMARY + SOLANA/SOL/PRIMARY reserves",
        async (ctx: SwapScenarioContext) => {
          // `reserveBook` throws when the row is absent — presence IS the check.
          await ctx.reserveBook(Constants.EthereumChainCode, Constants.EthereumTokenCode, Constants.PrimaryReserveCode)
          await ctx.reserveBook(Constants.SolanaChainCode, Constants.SolanaTokenCode, Constants.PrimaryReserveCode)
        }
      )
    )

    // ── 4. The challenge cast: Tier-1 electorate + funded challenger ──
    ClusterBuildPhase.create(
      cluster,
      "ProvisionChallengeCast",
      "Create + register the 3 Tier-1 voters; create + fund the challenger"
    ).push(
      ...Constants.Tier1VoterNames.flatMap(voter => [
        Steps.account.planCreateKeyed(
          Actor.User,
          `create-${voter}`,
          `create Tier-1 voter account ${voter} (shared dev key)`,
          {},
          voter,
          ClusterConstants.DEV_K1_PUBLIC_KEY
        ),
        ChallengeSteps.planForcereg(
          Actor.Sysio,
          `register-${voter}`,
          `register ${voter} Tier-1 via roa::forcereg (the challenge electorate)`,
          {},
          { owner: voter, tier: Constants.Tier1 }
        )
      ]),
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-challenger",
        `create the challenger account ${Constants.ChallengerAccount}`,
        {},
        Constants.ChallengerAccount,
        ClusterConstants.DEV_K1_PUBLIC_KEY
      ),
      Steps.contracts.sysio.token.planTransfer(
        Actor.Sysio,
        "fund-challenger",
        "treasury funds the challenger's bond budget",
        {},
        {
          from: Constants.TreasuryAccount,
          to: Constants.ChallengerAccount,
          quantity: Constants.ChallengerFundingQuantity,
          memo: "underwriter-challenge bond budget"
        }
      )
    )

    // ── 5. Swap A + capture its CONFIRMED commitment ──
    this.planSwap(
      cluster,
      "SwapA",
      underwriterGateOptions,
      raceStepOptions,
      requestStepOptions,
      firstUnderwriter,
      Outputs.swapATargetAmount,
      Outputs.commitmentA,
      []
    )

    // ── 6. Swap B + capture (excluding A's uwreq id) ──
    this.planSwap(
      cluster,
      "SwapB",
      underwriterGateOptions,
      raceStepOptions,
      requestStepOptions,
      firstUnderwriter,
      Outputs.swapBTargetAmount,
      Outputs.commitmentB,
      [Outputs.commitmentA]
    )

    // ── 7. The REJECTED challenge (commitment B) — runs FIRST so the
    //       underwriter is still healthy when it wins nothing further. ──
    const rejectKeys: ChallengeSteps.ChallengeKeys = {
      commitment: Outputs.commitmentB,
      chalId: Outputs.challengeBId,
      bond: Outputs.challengeBBond,
      challengerBalanceBefore: Outputs.challengerBalanceBeforeB
    }
    ClusterBuildPhase.create(
      cluster,
      "ChallengeRejected",
      "Commitment B is challenged; the council rejects with forfeit — bond to the underwriter, collateral untouched"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-underwriter-balance",
        "snapshot the winner's WIRE balance (the forfeit lands exactly on top)",
        async (ctx: SwapScenarioContext) => {
          const commitment = ctx.outputs.assert(Outputs.commitmentB)
          ctx.outputs.set(
            Outputs.underwriterBalanceBeforeB,
            await ctx.wire.getWireBalance(commitment.underwriterAccount)
          )
        }
      ),
      ChallengeSteps.planOpenuwchal(
        Actor.User,
        "open-challenge-b",
        "challenger files against commitment B and escrows the bond",
        requestStepOptions,
        rejectKeys,
        Constants.ChallengeReason,
        "flow: baseless allegation — the council rejects this one"
      ),
      ...Constants.Tier1VoterNames.map(voter =>
        ChallengeSteps.planVoteuwchal(
          Actor.User,
          `vote-reject-${voter}`,
          `${voter} ballots REJECT_FORFEIT (frivolous challenge)`,
          {},
          Outputs.challengeBId,
          voter,
          SysioChalgUwchalBallot.REJECT_FORFEIT
        )
      ),
      ChallengeSteps.planChkuwchal(
        Actor.User,
        "crank-challenge-b",
        "crank the tally — three REJECT_FORFEIT ballots clear the quorum",
        requestStepOptions,
        Outputs.challengeBId
      ),
      verifyStep(
        Actor.Sysio,
        "challenge-b-rejected",
        "verdict REJECTED_FORFEIT: bond CREDITED to the underwriter (no transfer); holds clear; operator ACTIVE; uwreq still CONFIRMED",
        async (ctx: SwapScenarioContext) => {
          const chalId = ctx.outputs.assert(Outputs.challengeBId)
          await ChallengeSteps.awaitVerdict(ctx, chalId, SysioChalgUwchalVerdict.REJECTED_FORFEIT)

          const commitment = ctx.outputs.assert(Outputs.commitmentB),
            bond = ctx.outputs.assert(Outputs.challengeBBond),
            underwriterBefore = ctx.outputs.assert(Outputs.underwriterBalanceBeforeB)
          // Forfeiture is explicit council judgment — the bond is credited to
          // the wrongly-challenged underwriter, to the unit. Resolution moves
          // no WIRE: the crank can run under the epoch tick, where a transfer
          // would execute the recipient's notification handler and let it
          // abort epoch advancement. Custody stays with chalg until the pull.
          Assert.strictEqual(
            await ChallengeSteps.readBondCredit(ctx, commitment.underwriterAccount),
            bond,
            "a rejected-with-forfeit challenge credits the underwriter the whole bond"
          )
          Assert.strictEqual(
            await ctx.wire.getWireBalance(commitment.underwriterAccount),
            underwriterBefore,
            "resolution alone must not move WIRE — the credit is claimed, not pushed"
          )
          // No fault: the operator stands, the locks persist unheld to their
          // natural expiry, the commitment stays CONFIRMED.
          const operator = await ChallengeSteps.readOperatorRow(ctx, commitment.underwriterAccount)
          Assert.ok(
            matchesProtoEnum(
              operator.status,
              SysioOpregOperatorstatus,
              SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
            ),
            "a rejected challenge must leave the underwriter ACTIVE"
          )
          const locks = await ctx.locksForUwreq(commitment.uwreqId)
          Assert.strictEqual(locks.length, 2, "both locks persist after a rejected challenge")
          locks.forEach(lock =>
            Assert.strictEqual(Number(lock.challenge_id), 0, "a rejected challenge clears the lock hold")
          )
          log.info(
            `[uwchal] challenge ${chalId} REJECTED_FORFEIT — bond ${bond} credited to ${commitment.underwriterAccount}`
          )
        },
        resolveStepOptions
      ),
      ChallengeSteps.planClaimbond(
        Actor.User,
        "claim-forfeited-bond",
        "the wrongly-challenged underwriter pulls its forfeited bond out of chalg custody",
        requestStepOptions,
        Outputs.commitmentB
      ),
      verifyStep(
        Actor.Sysio,
        "challenge-b-forfeit-paid",
        "the forfeited bond lands on the underwriter exactly, once claimed",
        async (ctx: SwapScenarioContext) => {
          const commitment = ctx.outputs.assert(Outputs.commitmentB),
            bond = ctx.outputs.assert(Outputs.challengeBBond),
            underwriterBefore = ctx.outputs.assert(Outputs.underwriterBalanceBeforeB)
          Assert.strictEqual(
            await ctx.wire.getWireBalance(commitment.underwriterAccount),
            underwriterBefore + bond,
            "the claimed forfeit lands on the wrongly-challenged underwriter exactly"
          )
        },
        resolveStepOptions
      )
    )

    // ── 8. The UPHELD challenge (commitment A) — slash, sweep, refund. ──
    const upholdKeys: ChallengeSteps.ChallengeKeys = {
      commitment: Outputs.commitmentA,
      chalId: Outputs.challengeAId,
      bond: Outputs.challengeABond,
      challengerBalanceBefore: Outputs.challengerBalanceBeforeA
    }
    ClusterBuildPhase.create(
      cluster,
      "ChallengeUpheld",
      "Commitment A is challenged; the council upholds — SLASHED, locked collateral debited, bond refunded"
    ).push(
      ChallengeSteps.planOpenuwchal(
        Actor.User,
        "open-challenge-a",
        "challenger files against commitment A and escrows the bond",
        requestStepOptions,
        upholdKeys,
        Constants.ChallengeReason,
        "flow: the committed source deposit does not exist"
      ),
      ...Constants.Tier1VoterNames.map(voter =>
        ChallengeSteps.planVoteuwchal(
          Actor.User,
          `vote-uphold-${voter}`,
          `${voter} ballots UPHOLD (fault proven)`,
          {},
          Outputs.challengeAId,
          voter,
          SysioChalgUwchalBallot.UPHOLD
        )
      ),
      ChallengeSteps.planChkuwchal(
        Actor.User,
        "crank-challenge-a",
        "crank the tally — three UPHOLD ballots clear the quorum",
        requestStepOptions,
        Outputs.challengeAId
      ),
      verifyStep(
        Actor.Sysio,
        "challenge-a-upheld",
        "verdict UPHELD: operator SLASHED; locks swept via deferred-slash; uwreq COMPLETED; bond refunded; chalg custody zero",
        async (ctx: SwapScenarioContext) => {
          const chalId = ctx.outputs.assert(Outputs.challengeAId)
          await ChallengeSteps.awaitVerdict(ctx, chalId, SysioChalgUwchalVerdict.UPHELD)

          const commitment = ctx.outputs.assert(Outputs.commitmentA),
            bond = ctx.outputs.assert(Outputs.challengeABond),
            challengerBefore = ctx.outputs.assert(Outputs.challengerBalanceBeforeA)
          // Slash: the verdict flips the winner's operator row SLASHED in the
          // same transaction that records it.
          const operator = await ChallengeSteps.readOperatorRow(ctx, commitment.underwriterAccount)
          Assert.ok(
            matchesProtoEnum(
              operator.status,
              SysioOpregOperatorstatus,
              SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
            ),
            "an upheld challenge must flip the underwriter SLASHED"
          )
          // Sweep: releaselock's deferred-slash branch consumes both held
          // locks (locked collateral debited, outbound SLASH attestations
          // queued) — no lock rows survive.
          const locks = await ctx.locksForUwreq(commitment.uwreqId)
          Assert.strictEqual(locks.length, 0, "the upheld challenge sweeps both locks via the deferred slash")
          // The commitment finalizes COMPLETED — never re-underwritable.
          const request = await ChallengeSteps.readUwreq(ctx, commitment.uwreqId)
          Assert.ok(request != null, "the challenged uwreq row must survive resolution")
          Assert.ok(
            matchesProtoEnum(
              request.status,
              SysioUwritUnderwriterequeststatus,
              SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_COMPLETED
            ),
            "an upheld challenge finalizes the uwreq COMPLETED"
          )
          // Refund: an upheld challenge credits the bond back. As with the
          // forfeit, resolution moves no WIRE — the challenger is still down
          // the escrow until it pulls.
          Assert.strictEqual(
            await ChallengeSteps.readBondCredit(ctx, Constants.ChallengerAccount),
            bond,
            "an upheld challenge credits the whole bond back to the challenger"
          )
          Assert.strictEqual(
            await ctx.wire.getWireBalance(Constants.ChallengerAccount),
            challengerBefore - bond,
            "resolution alone must not move WIRE — the refund is claimed, not pushed"
          )
          log.info(
            `[uwchal] challenge ${chalId} UPHELD — ${commitment.underwriterAccount} SLASHED, bond ${bond} credited back`
          )
        },
        resolveStepOptions
      ),
      ChallengeSteps.planClaimbond(
        Actor.User,
        "claim-refunded-bond",
        "the challenger pulls its refunded bond out of chalg custody",
        requestStepOptions,
        Constants.ChallengerAccount
      ),
      verifyStep(
        Actor.Sysio,
        "challenge-a-refund-paid",
        "the refund restores the challenger exactly; both bonds settled, chalg custody zero",
        async (ctx: SwapScenarioContext) => {
          const challengerBefore = ctx.outputs.assert(Outputs.challengerBalanceBeforeA)
          Assert.strictEqual(
            await ctx.wire.getWireBalance(Constants.ChallengerAccount),
            challengerBefore,
            "the claimed refund makes the challenger whole"
          )
          // Custody: both bonds resolved AND claimed (one forfeited, one
          // refunded) — sysio.chalg escrows nothing at rest.
          Assert.strictEqual(
            await ctx.wire.getWireBalance(SysioContractAccount[SysioContractName.chalg]),
            0n,
            "sysio.chalg ends the flow with zero WIRE custody"
          )
        },
        resolveStepOptions
      )
    )
  }

  /**
   * One ETH→SOL swap phase: gate on the underwriter being ACTIVE, quote the
   * live books, submit `ReserveManager.requestSwap`, then capture the
   * CONFIRMED commitment (uwreq id + winner) and assert its two persistent
   * locks. Commitments already captured under `excludeCommitmentKeys` are
   * excluded from the capture read, keeping the two same-direction swaps
   * distinguishable.
   */
  private planSwap(
    cluster: ClusterBuild<SwapScenarioContext>,
    phaseName: string,
    underwriterGateOptions: ClusterBuildStepOptions,
    raceStepOptions: ClusterBuildStepOptions,
    requestStepOptions: ClusterBuildStepOptions,
    underwriterLabel: string,
    targetAmountKey: OutputKey<bigint>,
    commitmentKey: OutputKey<Outputs.ChallengedCommitment>,
    excludeCommitmentKeys: ReadonlyArray<OutputKey<Outputs.ChallengedCommitment>>
  ): void {
    ClusterBuildPhase.create(
      cluster,
      phaseName,
      "ETH→SOL swap — request, underwriter race, and capture of the CONFIRMED commitment"
    ).push(
      // The collateral DEPOSIT_REQUESTs must complete their OPP round-trip
      // before the depot marks the underwriter ACTIVE; without it no commits
      // land and the race never resolves. (Already-ACTIVE resolves instantly.)
      verifyStep(
        Actor.Underwriter,
        "underwriter-active",
        `${underwriterLabel} is OPERATOR_STATUS_ACTIVE (deposits credited)`,
        async (ctx: SwapScenarioContext) => {
          const account = ctx.keyStore.assertOperator(underwriterLabel).account
          await pollUntil(
            `${underwriterLabel} ACTIVE`,
            async () => {
              const operator = await ChallengeSteps.readOperatorRow(ctx, account)
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
        "swapquote",
        "compute the ETH→SOL swapquote over the live books",
        async (ctx: SwapScenarioContext) => {
          const books: Books = {
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
          // Scale source wei (1e18) → depot 9-decimal units; for SOL the
          // depot unit IS the lamport, so the quote needs no outbound scaling.
          const quote = swapquote(books, Constants.SourceEthereumWei / Constants.WeiPerDepotUnit)
          Assert.ok(quote > 0n, `${phaseName} ETH→SOL swapquote returned no quote`)
          ctx.outputs.set(targetAmountKey, quote)
          log.info(`[${phaseName}] swapquote = ${quote} lamports`)
        }
      ),
      SwapSteps.planRequestSwapEthereum(
        Actor.User,
        "request-swap",
        `user calls ReserveManager.requestSwap (${Constants.SourceEthereumWei} wei ETH → SOL)`,
        requestStepOptions,
        targetAmountKey,
        {
          sourceAmountWei: Constants.SourceEthereumWei,
          targetToleranceBps: Constants.ToleranceBps
        }
      ),
      verifyStep(
        Actor.Underwriter,
        "capture-commitment",
        "the race resolves CONFIRMED — capture (uwreq id, winner) + assert both locks",
        async (ctx: SwapScenarioContext) => {
          const excludeUwreqIds = excludeCommitmentKeys.map(key => ctx.outputs.assert(key).uwreqId)
          await pollUntil(
            `${phaseName} commitment CONFIRMED`,
            async () => (await ChallengeSteps.findConfirmedCommitment(ctx, excludeUwreqIds)) != null,
            Constants.UwreqDeadlineMs + Constants.RaceDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const commitment = await ChallengeSteps.findConfirmedCommitment(ctx, excludeUwreqIds)
          ctx.outputs.set(commitmentKey, commitment)
          const locks = await ctx.locksForUwreq(commitment.uwreqId)
          Assert.strictEqual(locks.length, 2, "exactly two persistent locks back the CONFIRMED commitment")
          log.info(`[${phaseName}] CONFIRMED uwreq ${commitment.uwreqId} won by ${commitment.underwriterAccount}`)
        },
        raceStepOptions
      )
    )
  }
}
