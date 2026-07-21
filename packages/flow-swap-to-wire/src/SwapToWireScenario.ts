import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  contractView,
  ClusterBuildPhase,
  ClusterBuildStep,
  Constants as HarnessConstants,
  EthereumCollateralTool,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  getLogger,
  isNotEmpty,
  matchesProtoEnum,
  outputKey,
  pollUntil,
  provisionWireUser,
  requestEthereumSwap,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type Logger,
  type ReserveBook,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type WireUser,
  ClusterConfigProvider
} from "@wireio/cluster-tool"
import { SwapToWireScenarioConstants as Constants } from "./SwapToWireScenarioConstants.js"

const {
  SysioContractName,
  SysioMsgchAttestationtype,
  SysioOpregOperatorstatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts
const { Actor } = Report

const log = getLogger(__filename)

// ── Reads (execute freely inside verify-step runners) ───────────────────────

/**
 * Whether EVERY account in `accounts` has an `sysio.opreg::operators` row in
 * `OPERATOR_STATUS_ACTIVE` (a read).
 *
 * @param ctx - The scenario context.
 * @param accounts - The underwriter WIRE account names to check.
 * @returns Whether the whole roster is ACTIVE.
 */
async function underwritersActive(
  ctx: SwapScenarioContext,
  labels: string[]
): Promise<boolean> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorTableRowLimit })
  return labels.every(label => {
    const account = ctx.keyStore.assertOperator(label).account,
      operator = rows.find(row => row.account === account)
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
 * The to-WIRE uwreq row (src=ETHEREUM, dst=WIRE) — throws when the depot has
 * not created it (a read).
 *
 * @param ctx - The scenario context.
 * @returns The matching `sysio.uwrit::uwreqs` row.
 * @throws When no to-WIRE uwreq row exists yet.
 */
async function assertToWireUwreq(
  ctx: SwapScenarioContext
): Promise<SysioContracts.SysioUwritUwRequestTType> {
  const request = await ctx.uwreq(
    Constants.EthereumChainCode,
    Constants.WireChainCode
  )
  Assert.ok(
    request != null,
    "to-WIRE uwreq row (src=ETHEREUM, dst=WIRE) not found"
  )
  return request
}

// ── Flow-local write Steps (each on-chain WRITE is its own Step) ─────────────

/** Input for {@link planProvisionRecipient}. */
interface ProvisionRecipientInput extends StepInput {
  readonly kind: "SwapToWireScenario.ProvisionRecipientInput"
  /** WIRE account name to provision (unfunded — the payout is the flow's proof). */
  readonly account: string
}

/**
 * Step factory — provision the WIRE recipient account (create + resource
 * policy, via the shared WIRE-user tool). The recipient only needs to EXIST:
 * it starts at zero WIRE so the direct payout is unambiguous.
 *
 * @param actor - The narrative subject.
 * @param name - Step name (report row).
 * @param description - One-line description.
 * @param options - Per-step tuning.
 * @param account - The WIRE account name to provision.
 * @returns The definition step.
 */
function planProvisionRecipient(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  account: string
): ClusterBuildStep<SwapScenarioContext, ProvisionRecipientInput> {
  return ClusterBuildStep.create<SwapScenarioContext, ProvisionRecipientInput>(
    actor,
    name,
    description,
    options,
    { kind: "SwapToWireScenario.ProvisionRecipientInput", account },
    runProvisionRecipient
  )
}

/** Named runner — provision the recipient and store its {@link WireUser} output. */
async function runProvisionRecipient(
  ctx: SwapScenarioContext,
  input: ProvisionRecipientInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const recipient = await provisionWireUser(ctx.wire, input.account)
  ctx.outputs.set(SwapToWireScenario.Output.recipient, recipient)
}

/** Input for {@link planRequestSwap}. */
interface RequestSwapInput extends StepInput {
  readonly kind: "SwapToWireScenario.RequestSwapInput"
  /** Wei escrowed into the source reserve as the swap input. */
  readonly sourceAmountWei: bigint
  /** Acceptable variance (bps) on the WIRE target. */
  readonly toleranceBps: number
}

/**
 * Step factory — the ONE `ReserveManager.requestSwap` write with the WIRE
 * target: targetChain/Token = WIRE, the non-zero sentinel reserve code (the
 * outpost guards `reserveCode != 0`; the depot never quotes or debits a
 * WIRE-side reserve), and the recipient's account-name bytes.
 *
 * @param actor - The narrative subject.
 * @param name - Step name (report row).
 * @param description - One-line description.
 * @param options - Per-step tuning.
 * @param sourceAmountWei - Wei to escrow on the source outpost.
 * @param toleranceBps - Variance tolerance riding the request.
 * @returns The definition step.
 */
function planRequestSwap(
  actor: Report.Actor,
  name: string,
  description: string,
  options: ClusterBuildStepOptions,
  sourceAmountWei: bigint,
  toleranceBps: number
): ClusterBuildStep<SwapScenarioContext, RequestSwapInput> {
  return ClusterBuildStep.create<SwapScenarioContext, RequestSwapInput>(
    actor,
    name,
    description,
    options,
    {
      kind: "SwapToWireScenario.RequestSwapInput",
      sourceAmountWei,
      toleranceBps
    },
    runRequestSwap
  )
}

/**
 * Named runner — bind `ReserveManager` to the swap user's wallet and submit
 * the ONE `requestSwap` write carrying the curve target from `ctx.outputs`.
 */
async function runRequestSwap(
  ctx: SwapScenarioContext,
  input: RequestSwapInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const swapUser = ctx.outputs.assert(swapUserOutputKey()),
    recipient = ctx.outputs.assert(SwapToWireScenario.Output.recipient),
    target = ctx.outputs.assert(SwapToWireScenario.Output.target)
  const addresses = EthereumCollateralTool.loadOutpostAddresses(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    ),
    reserveManagerAddress = addresses[Constants.ReserveManagerContractName]
  Assert.ok(
    reserveManagerAddress != null,
    `SwapToWireScenario: ${Constants.ReserveManagerContractName} missing from outpost-addrs.json`
  )
  const reserveManager = contractView<ReserveManagerRequestSwapContract>(
    reserveManagerAddress,
    EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    ),
    swapUser.ethereumWallet
  )
  const result = await requestEthereumSwap(reserveManager, {
    sourceTokenCode: BigInt(Constants.EthereumTokenCode),
    sourceReserveCode: BigInt(Constants.EthereumReserveCode),
    sourceAmountWei: input.sourceAmountWei,
    targetChainCode: BigInt(Constants.WireChainCode),
    targetTokenCode: BigInt(Constants.WireTokenCode),
    targetReserveCode: BigInt(Constants.WireSentinelReserveCode),
    targetRecipient: recipient.accountBytes,
    targetAmount: target,
    targetToleranceBps: input.toleranceBps
  })
  Assert.ok(
    isNotEmpty(result.transactionHash),
    "SwapToWireScenario: requestSwap must return a mined transaction hash"
  )
  log.info(
    `[SwapToWire] requestSwap mined: ${result.transactionHash} (block ${result.blockNumber})`
  )
}

/**
 * Flow: Swap TO WIRE — Ethereum → the WIRE depot itself.
 *
 * The single-leg shape: the user deposits native ETH on the source outpost
 * exactly like a normal swap, but the target is the WIRE token on the depot.
 * Only the SOURCE leg is underwritten (one UIC, one bond, one lock); at race
 * resolution the depot books the source reserve (`chain += src, wire -= dst`)
 * and pays the recipient REAL WIRE from `sysio.reserv` custody in the same
 * transaction. No destination outpost, no SWAP_REMIT, no ack — and the
 * underwriter's collateral lock PERSISTS for its wall-clock challenge window
 * (it is never released by delivery).
 *
 * Scenario phases (on top of the bootstrap):
 * 1. **SubstrateHealth** — blocks produce; the ETHEREUM/ETH/PRIMARY reserve is
 *    seeded with real WIRE custody behind it.
 * 2. **SwapUser** / **Recipient** — the paired ETH+SOL swap identity and the
 *    (unfunded) WIRE recipient.
 * 3. **UnderwriterCollateral** / **UnderwriterActive** — default bonds on both
 *    outposts; the roster flips ACTIVE once the deposits credit over OPP.
 * 4. **QuoteAndRequest** — single-reserve `cp_output(src.chain, src.wire,
 *    amount)` target; the ONE `requestSwap` write with the WIRE target.
 * 5. **CreateUwreq** — the PENDING to-WIRE UWREQ appears (dst token = WIRE).
 * 6. **RaceSourceLeg** — CONFIRMED with exactly ONE lock, on the SOURCE chain.
 * 7. **PayWireDirectly** — recipient paid the EXACT target; source book moves
 *    `chain += src, wire -= target + fee`; custody drains to
 *    `before − target − fee`.
 * 8. **ChallengeWindow** — the lock persists (still CONFIRMED) and NO outbound
 *    SWAP_REMIT references the uwreq (the depot itself was the payer).
 */
export class SwapToWireScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-to-wire"
  readonly description =
    "Single-leg swap TO WIRE: ETH escrow on the source outpost, direct WIRE payout from sysio.reserv custody"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // The underwriter ACTIVE gate: minimums on BOTH outpost chains, matched
    // exactly by the default bond plan the scenario deposits.
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

  /** The swap flows share the {@link SwapScenarioContext} query surface. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const config = cluster.context.config,
      underwriterLabels = Array.from(
        { length: config.underwriterCount },
        (_, index) => HarnessConstants.underwriterLabel(index)
      ),
      writeOptions = { timeoutMs: Constants.WriteTimeoutMs },
      activeStepOptions = {
        timeoutMs: Constants.relayDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      uwreqStepOptions = {
        timeoutMs: Constants.UwreqDeadlineMs + Constants.PollDeadlineBufferMs
      },
      raceStepOptions = {
        timeoutMs: Constants.RaceDeadlineMs + Constants.PollDeadlineBufferMs
      },
      payoutStepOptions = {
        timeoutMs: Constants.PayoutDeadlineMs + Constants.PollDeadlineBufferMs
      }

    // ── 1. Substrate health — blocks + the seeded, custody-backed reserve ──
    ClusterBuildPhase.create(
      cluster,
      "SubstrateHealth",
      "The chain produces blocks and the source reserve is seeded"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "chain-producing",
        "WIRE chain is producing blocks",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            `head_block_num must be positive (got ${info.head_block_num})`
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "reserve-custody-seeded",
        "bootstrap seeded ETHEREUM/ETH/PRIMARY with real WIRE custody behind it",
        async ctx => {
          // Custody prerequisite for the direct payout: sysio.reserv's REAL
          // WIRE balance backs the reserve rows (regreserve treasury drain).
          const book = await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.EthereumReserveCode
          )
          const custody = await ctx.wire.getWireBalance(
            Constants.ReserveCustodyAccount
          )
          Assert.ok(
            custody >= book.wire,
            `sysio.reserv custody (${custody}) must back the reserve's WIRE book (${book.wire})`
          )
        }
      )
    )

    // ── 2. The swap user's paired ETH + SOL identity (+ SOL airdrop) ──
    SwapUserIdentities.planIdentityProvisioning<SwapScenarioContext>(
      cluster,
      "SwapUser",
      "Provision the swap user's paired Ethereum + Solana identity",
      {}
    )

    // ── 3. The WIRE recipient — exists, holds no WIRE until the payout ──
    ClusterBuildPhase.create(
      cluster,
      "Recipient",
      "Provision the (unfunded) WIRE recipient"
    ).push(
      planProvisionRecipient(
        Actor.User,
        "provision-recipient",
        `provision ${Constants.RecipientAccount} (zero WIRE until the payout)`,
        writeOptions,
        Constants.RecipientAccount
      )
    )

    // ── 4. Underwriter bonds on both outposts → roster flips ACTIVE ──
    // (The old harness bonded these during bootstrap; the scenario owns them now.)
    WireUnderwriterTool.planCollateralDeposit<SwapScenarioContext>(
      cluster,
      "UnderwriterCollateral",
      "Bond default underwriter collateral on both outpost chains",
      writeOptions,
      underwriterLabels,
      WireUnderwriterTool.load(null, config.underwriterCount)
    )
    ClusterBuildPhase.create(
      cluster,
      "UnderwriterActive",
      "Underwriter bonds credit over OPP; the roster flips ACTIVE"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "underwriters-active",
        "every underwriter reaches OPERATOR_STATUS_ACTIVE (deposits credit)",
        async ctx => {
          await pollUntil(
            "every underwriter OPERATOR_STATUS_ACTIVE",
            () => underwritersActive(ctx, underwriterLabels),
            Constants.relayDeadlineMs(),
            Constants.LongPollIntervalMs
          )
        },
        activeStepOptions
      )
    )

    // ── 5. QuoteAndRequest — curve target + the ONE requestSwap write ──
    ClusterBuildPhase.create(
      cluster,
      "QuoteAndRequest",
      "Compute the to-WIRE curve target and submit requestSwap"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.User,
        "compute-target",
        "compute the to-WIRE target from the source reserve curve (single-reserve cp_output)",
        async ctx => {
          // The public reserv::swapquote is two-reserve; a WIRE target has no
          // destination reserve, so the depot's variance check uses the
          // single-reserve branch `cp_output(src.chain, src.wire, amount)` —
          // mirrored here from the live row via WireReserveTool.cpOutput, with
          // the WIRE-leg fee split at the LIVE uwconfig rate
          // (WireReserveTool.readFeeBps). Baselines snapshot alongside.
          const book = await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.EthereumReserveCode
          )
          const custody = await ctx.wire.getWireBalance(
            Constants.ReserveCustodyAccount
          )
          const feeBps = await WireReserveTool.readFeeBps(ctx.wire)
          const target = WireReserveTool.cpOutput(
            book.chain,
            book.wire,
            Constants.SourceDepotUnits
          )
          Assert.ok(target > 0n, "curve target must be positive")
          ctx.outputs
            .set(SwapToWireScenario.Output.bookBefore, book)
            .set(SwapToWireScenario.Output.custodyBefore, custody)
            .set(SwapToWireScenario.Output.target, target)
            .set(
              SwapToWireScenario.Output.wireLegFee,
              WireReserveTool.splitWireFee(target, feeBps).fee
            )
          log.info(
            `[SwapToWire] curve target = ${target} WIRE base units (fee_bps=${feeBps})`
          )
        }
      ),
      planRequestSwap(
        Actor.User,
        "request-swap",
        `requestSwap: ${Constants.SourceEthereumWei} wei ETH → WIRE (sentinel reserve, recipient account bytes)`,
        writeOptions,
        Constants.SourceEthereumWei,
        Constants.ToleranceBps
      )
    )

    // ── 6. CreateUwreq — the PENDING to-WIRE UWREQ appears ──
    ClusterBuildPhase.create(
      cluster,
      "CreateUwreq",
      "The depot creates the PENDING to-WIRE UWREQ"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "uwreq-appears",
        "the to-WIRE UWREQ row appears with dst token = WIRE",
        async ctx => {
          await pollUntil(
            "to-WIRE UWREQ row appears",
            async () =>
              (await ctx.uwreq(
                Constants.EthereumChainCode,
                Constants.WireChainCode
              )) != null,
            Constants.UwreqDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const request = await assertToWireUwreq(ctx)
          Assert.ok(
            slugValue(request.dst_token_code) === Constants.WireTokenCode,
            `uwreq dst_token_code must be WIRE (got ${slugValue(request.dst_token_code)})`
          )
        },
        uwreqStepOptions
      )
    )

    // ── 7. RaceSourceLeg — CONFIRMED with exactly ONE lock (source leg) ──
    ClusterBuildPhase.create(
      cluster,
      "RaceSourceLeg",
      "The single-leg race resolves with one source-chain lock"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "race-confirms-single-lock",
        "uwreq flips CONFIRMED with exactly one lock, on the SOURCE chain",
        async ctx => {
          await pollUntil(
            "to-WIRE UWREQ status=CONFIRMED",
            async () => {
              const request = await ctx.uwreq(
                Constants.EthereumChainCode,
                Constants.WireChainCode
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
          // The WIRE leg carries no bond — only the ETH source leg is locked.
          const request = await assertToWireUwreq(ctx)
          const locks = await ctx.locksForUwreq(Number(request.id))
          Assert.ok(
            locks.length === 1,
            `the WIRE leg carries no bond — expected exactly 1 lock, got ${locks.length}`
          )
          Assert.ok(
            slugValue(locks[0].chain_code) === Constants.EthereumChainCode,
            `the single lock must sit on the SOURCE chain (got chain_code=${slugValue(locks[0].chain_code)})`
          )
        },
        raceStepOptions
      )
    )

    // ── 8. PayWireDirectly — exact payout, book movement, custody drain ──
    ClusterBuildPhase.create(
      cluster,
      "PayWireDirectly",
      "The depot pays the recipient REAL WIRE inline and books the source reserve"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "recipient-paid-exact",
        "recipient receives EXACTLY the target (the payout is not reduced by the fee)",
        async ctx => {
          const recipient = ctx.outputs.assert(
              SwapToWireScenario.Output.recipient
            ),
            target = ctx.outputs.assert(SwapToWireScenario.Output.target)
          await pollUntil(
            "recipient WIRE balance reaches the target",
            async () =>
              (await ctx.wire.getWireBalance(recipient.account)) >= target,
            Constants.PayoutDeadlineMs,
            Constants.LongPollIntervalMs
          )
          // paywire pays dst_amount exactly (the user's variance-gated target).
          const received = await ctx.wire.getWireBalance(recipient.account)
          Assert.ok(
            received === target,
            `paywire pays dst_amount exactly — expected ${target}, got ${received}`
          )
        },
        payoutStepOptions
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "source-book-moved",
        "source reserve books moved at emit: chain += src, wire -= target + fee",
        async ctx => {
          // Applied in the SAME transaction as the race resolution (emit-time
          // settlement). #414 charges the WIRE-leg fee on the gross
          // intermediate ON TOP of the recipient's payout, so the source
          // reserve's WIRE side gives up target + fee.
          const before = ctx.outputs.assert(
              SwapToWireScenario.Output.bookBefore
            ),
            target = ctx.outputs.assert(SwapToWireScenario.Output.target),
            fee = ctx.outputs.assert(SwapToWireScenario.Output.wireLegFee)
          const book = await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.EthereumReserveCode
          )
          Assert.ok(
            book.chain === before.chain + Constants.SourceDepotUnits,
            `source reserve chain side must gain the escrow — expected ${before.chain + Constants.SourceDepotUnits}, got ${book.chain}`
          )
          Assert.ok(
            book.wire === before.wire - target - fee,
            `source reserve WIRE side must give up target + fee — expected ${before.wire - target - fee}, got ${book.wire}`
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "custody-settled",
        "sysio.reserv custody drains to before − target − fee (rewards bucket drained)",
        async ctx => {
          // The recipient's payout leaves `sysio.reserv`, and so does the FULL
          // WIRE-leg fee — the emissions half at emit (#414) and, as of #425,
          // the rewards half drained each epoch by payepoch
          // (sysio.reserv::drainrewards). The drain can land just after emit,
          // so poll until custody settles at the fully-drained value.
          const custodyBefore = ctx.outputs.assert(
              SwapToWireScenario.Output.custodyBefore
            ),
            target = ctx.outputs.assert(SwapToWireScenario.Output.target),
            fee = ctx.outputs.assert(SwapToWireScenario.Output.wireLegFee),
            expectedCustody = custodyBefore - target - fee
          await pollUntil(
            "rewards bucket drained from sysio.reserv custody",
            async () =>
              (await ctx.wire.getWireBalance(
                Constants.ReserveCustodyAccount
              )) === expectedCustody,
            Constants.PayoutDeadlineMs,
            Constants.LongPollIntervalMs
          )
          const custody = await ctx.wire.getWireBalance(
            Constants.ReserveCustodyAccount
          )
          Assert.ok(
            custody === expectedCustody,
            `sysio.reserv custody must settle at ${expectedCustody}, got ${custody}`
          )
        },
        payoutStepOptions
      )
    )

    // ── 9. ChallengeWindow — the lock persists; nothing rides OPP outbound ──
    ClusterBuildPhase.create(
      cluster,
      "ChallengeWindow",
      "The source-leg lock persists and no SWAP_REMIT was queued"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "lock-persists",
        "the source-leg lock PERSISTS after payout (wall-clock challenge window)",
        async ctx => {
          // Locks are a wall-clock challenge window — delivery does NOT release
          // them (chklocks sweeps them after collateral_lock_duration_ms).
          const request = await assertToWireUwreq(ctx)
          const locks = await ctx.locksForUwreq(Number(request.id))
          Assert.ok(
            locks.length === 1,
            `the source-leg lock must persist through the challenge window — expected 1, got ${locks.length}`
          )
          // And the uwreq stays CONFIRMED until that window elapses.
          Assert.ok(
            matchesProtoEnum(
              request.status,
              SysioUwritUnderwriterequeststatus,
              SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
            ),
            `uwreq must stay CONFIRMED until the lock window elapses (status=${request.status})`
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "no-swap-remit",
        "no outbound SWAP_REMIT was queued for the to-WIRE uwreq (the depot itself is the payer)",
        async ctx => {
          const request = await assertToWireUwreq(ctx)
          const { rows } = await ctx.wire
            .getSysioContract(SysioContractName.msgch)
            .tables.attestations.query({
              limit: Constants.AttestationScanRowLimit
            })
          // SwapRemit.original_message_id low 8 bytes = uwreq id (LE) — the
          // id's low byte leads the hex-encoded attestation data.
          const requestIdHexLittleEndian = Number(request.id)
            .toString(16)
            .padStart(Constants.UwreqIdHexByteWidth, "0")
          const remitForRequest = rows.find(
            attestation =>
              matchesProtoEnum(
                attestation.type,
                SysioMsgchAttestationtype,
                SysioMsgchAttestationtype.ATTESTATION_TYPE_SWAP_REMIT
              ) &&
              typeof attestation.data === "string" &&
              attestation.data.length > 0 &&
              attestation.data.includes(requestIdHexLittleEndian)
          )
          Assert.ok(
            remitForRequest == null,
            `the depot pays the WIRE leg inline — no outbound SWAP_REMIT may reference uwreq ${request.id}`
          )
        }
      )
    )
  }
}

export namespace SwapToWireScenario {
  /** Typed cross-step outputs — no raw string keys, no shared mutable closures. */
  export namespace Output {
    /** The provisioned WIRE recipient (account + ChainAddress byte encoding). */
    export const recipient = outputKey<WireUser>(
      "swapToWire.recipient",
      "the provisioned WIRE recipient"
    )
    /** The curve-derived WIRE target the request carries (paid EXACTLY). */
    export const target = outputKey<bigint>(
      "swapToWire.target",
      "single-reserve cp_output WIRE target"
    )
    /** The predicted WIRE-leg fee on the target (from the live uwconfig fee_bps). */
    export const wireLegFee = outputKey<bigint>(
      "swapToWire.wireLegFee",
      "WIRE-leg fee charged on the gross target"
    )
    /** The ETHEREUM/ETH/PRIMARY book snapshot taken at quote time. */
    export const bookBefore = outputKey<ReserveBook>(
      "swapToWire.bookBefore",
      "source reserve (chain, wire) baseline"
    )
    /** The `sysio.reserv` custody balance snapshot taken at quote time. */
    export const custodyBefore = outputKey<bigint>(
      "swapToWire.custodyBefore",
      "sysio.reserv WIRE custody baseline"
    )
  }
}
