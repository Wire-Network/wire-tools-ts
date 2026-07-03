import Assert from "node:assert"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { ChainKind, TokenAmount } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  FlowScenario,
  containsSwapRevert,
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
import { SwapPrivateReservesScenarioArtifacts as Artifacts } from "./SwapPrivateReservesScenarioArtifacts.js"
import { SwapPrivateReservesScenarioConstants as Constants } from "./SwapPrivateReservesScenarioConstants.js"
import { SwapPrivateReservesScenarioOutputs as Outputs } from "./SwapPrivateReservesScenarioOutputs.js"
import { SwapPrivateReservesScenarioOwnerSteps as OwnerSteps } from "./steps/SwapPrivateReservesScenarioOwnerSteps.js"
import { SwapPrivateReservesScenarioReserveSteps as ReserveSteps } from "./steps/SwapPrivateReservesScenarioReserveSteps.js"
import { SwapPrivateReservesScenarioSwapSteps as SwapSteps } from "./steps/SwapPrivateReservesScenarioSwapSteps.js"

const {
  SysioContractName,
  SysioOpregOperatorstatus,
  SysioReservReservestatus,
  SysioUwritUnderwriterequeststatus
} = SysioContracts
const { Actor } = Report

const log = getLogger(__filename)

/** The scenario context — the shared swap-flow depot query surface. */
type Context = SwapScenarioContext

// ── Depot read helpers (reads execute freely inside verify runners) ─────────

/** The depot's PRIVATE reserve row for `(chainCode, tokenCode)`, or nothing yet. */
async function readPrivateReserveRow(
  ctx: Context,
  chainCode: number,
  tokenCode: number
): Promise<SysioContracts.SysioReservReserveRowType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.reserv)
    .tables.reserves.query()
  return rows.find(
    row =>
      slugValue(row.chain_code) === chainCode &&
      slugValue(row.token_code) === tokenCode &&
      slugValue(row.reserve_code) === Constants.Reserves.PrivateReserveCode
  )
}

/**
 * The UWREQ sourcing the PRIVATE reserve on `sourceChainCode` toward
 * `destinationChainCode`, or nothing yet (the `src_reserve_code` filter is the
 * old suite's triple match — the WIRE-probe negative depends on it excluding
 * the swap phases' requests by destination).
 */
async function readPrivatePairUwreq(
  ctx: Context,
  sourceChainCode: number,
  destinationChainCode: number
): Promise<SysioContracts.SysioUwritUwRequestTType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query()
  return rows.find(
    request =>
      slugValue(request.src_chain_code) === sourceChainCode &&
      slugValue(request.src_reserve_code) ===
        Constants.Reserves.PrivateReserveCode &&
      slugValue(request.dst_chain_code) === destinationChainCode
  )
}

/** True when the UWREQ row exists and reports CONFIRMED (either wire shape). */
function uwreqConfirmed(row: SysioContracts.SysioUwritUwRequestTType): boolean {
  return (
    row != null &&
    matchesProtoEnum(
      row.status,
      SysioUwritUnderwriterequeststatus,
      SysioUwritUnderwriterequeststatus.UNDERWRITE_REQUEST_STATUS_CONFIRMED
    )
  )
}

/** The user's USDCSOL ATA balance in base units (a read). */
async function readUserUsdcSolBalance(ctx: Context): Promise<bigint> {
  const swapUser = ctx.outputs.assert(swapUserOutputKey())
  return ctx.solana.getSplBalance(
    getAssociatedTokenAddressSync(
      Artifacts.loadUsdcSolMint(ctx),
      swapUser.solanaKeypair.publicKey
    )
  )
}

/**
 * Flow: bidirectional swaps through a same-owner PRIVATE reserve pair
 * (native × non-native) + private→WIRE exclusion.
 *
 * The FINAL verification flow for the gated-reserve feature: both private
 * reserves are stood up via the REAL handshake — outpost `create_reserve`
 * (ETH native / SOL USDCSOL SPL, `isPrivate=true`) → depot PENDING row →
 * `matchreserve` by the single authex-linked owner (`privowner`, linked on
 * BOTH chains) escrowing real WIRE → ACTIVE with `owner = privowner` →
 * RESERVE_READY flips both outpost-local records.
 *
 * Because both reserves share one non-empty owner, the depot's privacy gate
 * ADMITS the pair: Phase A swaps native ETH → USDCSOL (SPL payout to the
 * user's ATA) and Phase B swaps USDCSOL → native ETH, each through the
 * standard UWREQ race (two legs ⇒ two locks) with the emit-time four-leg
 * constant-product books asserted with exact integers. The WIRE-endpoint
 * exclusion still binds: a swap sourcing the private ETH reserve toward WIRE
 * draws a SWAP_REVERT and never creates a UWREQ.
 */
export class SwapPrivateReservesScenario extends FlowScenario<Context> {
  readonly name = "flow-swap-private-reserves"
  readonly description =
    "Bidirectional swaps through a same-owner PRIVATE reserve pair (native × non-native) + private→WIRE exclusion"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.Timing.EpochDurationSec,
    // `createuwreq` re-checks `meets_role_min` for BOTH legs of every swap —
    // the per-(chain, token) minimums the underwriter's deposits must clear.
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.Reserves.Ethereum.ChainCode,
        tokenCode: Constants.Reserves.Ethereum.TokenCode,
        minimumBond: Constants.Underwriting.MinimumBond
      },
      {
        chainCode: Constants.Reserves.Solana.ChainCode,
        tokenCode: Constants.Reserves.Solana.NativeTokenCode,
        minimumBond: Constants.Underwriting.MinimumBond
      }
    ],
    // The underwriter bonds on every leg this flow's matrix touches: native
    // ETH, native SOL, and the non-native USDCSOL leg (the underwriter
    // plugin's `select_coverable` requires a credit line per (chain, token)).
    underwriterCollateral: [
      [
        {
          chain_code: Constants.Reserves.Ethereum.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
            amount: Constants.Underwriting.CollateralAmount
          })
        },
        {
          chain_code: Constants.Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Solana.NativeTokenCode),
            amount: Constants.Underwriting.CollateralAmount
          })
        },
        {
          chain_code: Constants.Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Solana.TokenCode),
            amount: Constants.Underwriting.CollateralAmount
          })
        }
      ]
    ]
  }

  override createContext(config: ClusterConfig, contextLog: Logger): Context {
    return new SwapScenarioContext(config, contextLog)
  }

  build(cluster: ClusterBuild<Context>): void {
    const relayOptions = {
        timeoutMs:
          Constants.Timing.RelayDeadlineMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      readyOptions = {
        timeoutMs:
          Constants.Timing.ReadyDeadlineMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      uwreqOptions = {
        timeoutMs:
          Constants.Timing.UwreqDeadlineMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      raceOptions = {
        timeoutMs:
          Constants.Timing.RaceDeadlineMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      remitOptions = {
        timeoutMs:
          Constants.Timing.RemitDeadlineMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      noUwreqOptions = {
        timeoutMs:
          Constants.Timing.NoUwreqWindowMs +
          Constants.Timing.PollDeadlineBufferMs
      },
      // Write / snapshot ceiling — covers the SOL confirm loop's own 60s
      // deadline plus tx build headroom (the old suite ran writes under a
      // 720s beforeAll umbrella with no per-write ceiling).
      writeOptions = { timeoutMs: 90_000 }

    // ── 1. Underwriter collateral (the old harness's bootstrap deposits) ──
    // One Phase per underwriter, one Step per (chain, token) bond, from the
    // resolved config plan (this scenario's defaults: ETH + SOL + USDCSOL).
    const underwriterAccounts = Array.from(
      { length: cluster.config.underwriterCount },
      (_, index) => HarnessConstants.underwriterAccountName(index)
    )
    WireUnderwriterTool.deposit(
      cluster,
      "UnderwriterCollateral",
      "Underwriters bond collateral on every leg the swap matrix touches",
      writeOptions,
      underwriterAccounts,
      cluster.config.underwriterCollateral ??
        WireUnderwriterTool.load(null, cluster.config.underwriterCount)
    )

    // ── 2. Substrate health (old Phase 0 tests) ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "SubstrateHealth",
      "The WIRE chain produces blocks and the underwriter's deposits credit"
    ).push(
      verifyStep<Context>(
        Actor.Sysio,
        "wire-chain-producing",
        "WIRE chain is producing blocks",
        runVerifyWireChainProducing,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.Underwriter,
        "underwriter-active",
        `${underwriterAccounts[0]} becomes ACTIVE (deposits credit)`,
        runVerifyUnderwriterActive,
        uwreqOptions
      )
    )

    // ── 3. The swap user's dual-chain identity (creator on BOTH chains) ──
    SwapUserIdentities.ensure<Context>(
      cluster,
      "SwapUserIdentity",
      "Provision the dual-chain swap user (reserve creator + swap actor)",
      writeOptions
    )

    // ── 4. The single owner — WIRE account + authex links + SPL funding ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "OwnerProvisioning",
      `Provision ${Constants.Accounts.Owner} (WIRE account, BOTH-chain authex links, creator USDCSOL funding)`
    ).push(
      OwnerSteps.provisionOwner<Context>(
        Actor.User,
        "provision-owner",
        `create + fund the ${Constants.Accounts.Owner} WIRE account`,
        writeOptions
      ),
      OwnerSteps.linkOwner<Context>(
        Actor.User,
        "link-owner-ethereum",
        `authex-link ${Constants.Accounts.Owner} to the ETH creator wallet's secp256k1 key`,
        writeOptions,
        ChainKind.EVM
      ),
      OwnerSteps.linkOwner<Context>(
        Actor.User,
        "link-owner-solana",
        `authex-link ${Constants.Accounts.Owner} to the SOL creator keypair's ed25519 key`,
        writeOptions,
        ChainKind.SVM
      ),
      OwnerSteps.mintCreatorUsdcSol<Context>(
        Actor.SolanaOutpost,
        "mint-creator-usdcsol",
        `mint ${Constants.SplFunding.CreatorMintAmount} USDCSOL base units to the creator's ATA`,
        writeOptions
      )
    )

    // ── 5. ETH-side gated handshake: create → PENDING → match → ACTIVE ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "CreateMatchEthereumPrivate",
      "ETH outpost create_reserve(isPrivate) → depot PENDING → matchreserve → ACTIVE + RESERVE_READY"
    ).push(
      ReserveSteps.createEthereumReserve<Context>(
        Actor.User,
        "create-ethereum-private-reserve",
        `create_reserve(ETH/PRIVATE) escrowing ${Constants.CreateParams.EthereumEscrowWei} wei`,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "ethereum-depot-row-pending",
        "the ETH-side private depot row appears with status=PENDING",
        runVerifyEthereumDepotRowPending,
        relayOptions
      ),
      ReserveSteps.matchReserve<Context>(
        Actor.User,
        "match-ethereum-private-reserve",
        `${Constants.Accounts.Owner} matches the ETH private reserve with ${Constants.CreateParams.EthereumRequestedWire} WIRE`,
        writeOptions,
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Ethereum.TokenCode,
        Constants.CreateParams.EthereumRequestedWire
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "ethereum-depot-row-active",
        `the ETH depot row is ACTIVE with owner=${Constants.Accounts.Owner}, is_private, and exact custody`,
        runVerifyEthereumDepotRowActive,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.EthereumOutpost,
        "ethereum-local-record-active",
        "RESERVE_READY flips the ETH outpost-local private record ACTIVE",
        runVerifyEthereumLocalReserveActive,
        readyOptions
      )
    )

    // ── 6. SOL-side gated handshake (mirror) ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "CreateMatchSolanaPrivate",
      "SOL outpost create_reserve(isPrivate, SPL) → depot PENDING → matchreserve → ACTIVE + RESERVE_READY"
    ).push(
      ReserveSteps.createSolanaReserve<Context>(
        Actor.User,
        "create-solana-private-reserve",
        `create_reserve(USDCSOL/PRIVATE) escrowing ${Constants.CreateParams.SolanaEscrowChainUnits} base units`,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "solana-depot-row-pending",
        "the SOL-side private depot row appears with status=PENDING",
        runVerifySolanaDepotRowPending,
        relayOptions
      ),
      ReserveSteps.matchReserve<Context>(
        Actor.User,
        "match-solana-private-reserve",
        `${Constants.Accounts.Owner} matches the SOL private reserve with ${Constants.CreateParams.SolanaRequestedWire} WIRE`,
        writeOptions,
        Constants.Reserves.Solana.ChainCode,
        Constants.Reserves.Solana.TokenCode,
        Constants.CreateParams.SolanaRequestedWire
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "solana-depot-row-active",
        `the SOL depot row is ACTIVE with owner=${Constants.Accounts.Owner}, is_private, and exact custody`,
        runVerifySolanaDepotRowActive,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.SolanaOutpost,
        "solana-local-record-active",
        "RESERVE_READY flips the SOL outpost's private Reserve PDA Active (gates Phase B's request_swap_spl)",
        runVerifySolanaLocalReserveActive,
        readyOptions
      )
    )

    // ── 7. Phase A: ETH (native) → USDCSOL (SPL) through the private pair ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "PhaseAEthereumToSolana",
      "ETH (native) → USDCSOL (SPL) through the private pair: quote → request → UWREQ race → books → payout"
    ).push(
      verifyStep<Context>(
        Actor.User,
        "phase-a-quote",
        "compute the private-pair quote (two-hop constant product) + snapshot baselines",
        runPhaseAQuote,
        writeOptions
      ),
      SwapSteps.requestSwapEthereumToSolana<Context>(
        Actor.User,
        "phase-a-request-swap",
        "user calls ReserveManager.requestSwap sourcing the private ETH reserve",
        writeOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "phase-a-uwreq-created",
        "depot creates the PENDING private-pair UWREQ (same-owner pairing admitted)",
        runPhaseAUwreqCreated,
        uwreqOptions
      ),
      verifyStep<Context>(
        Actor.Underwriter,
        "phase-a-uwreq-confirmed",
        "UWREQ resolves CONFIRMED with TWO locks (one per leg)",
        runPhaseAUwreqConfirmed,
        raceOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "phase-a-four-leg-books",
        "emit-time four-leg books move on the two private rows (Σwire drops by the WIRE-leg fee)",
        runPhaseAFourLegBooks,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.SolanaOutpost,
        "phase-a-user-payout",
        "user's USDCSOL ATA bumps by ~target",
        runPhaseAUserPayout,
        remitOptions
      )
    )

    // ── 8. Phase B: USDCSOL (SPL) → ETH (native) through the private pair ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "PhaseBSolanaToEthereum",
      "USDCSOL (SPL) → ETH (native) through the private pair: inverse quote → request → UWREQ race → books → payout"
    ).push(
      verifyStep<Context>(
        Actor.User,
        "phase-b-quote",
        "compute the inverse private-pair quote from the live (post-Phase-A) books",
        runPhaseBQuote,
        writeOptions
      ),
      SwapSteps.requestSwapSolanaToEthereum<Context>(
        Actor.User,
        "phase-b-request-swap",
        "user calls opp_outpost::request_swap_spl sourcing the private USDCSOL reserve",
        writeOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "phase-b-uwreq-created",
        "depot creates the PENDING inverse UWREQ (src_amount rescaled to the depot frame)",
        runPhaseBUwreqCreated,
        uwreqOptions
      ),
      verifyStep<Context>(
        Actor.Underwriter,
        "phase-b-uwreq-confirmed",
        "UWREQ resolves CONFIRMED with TWO locks (one per leg)",
        runPhaseBUwreqConfirmed,
        raceOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "phase-b-four-leg-books",
        "emit-time four-leg books move on the two private rows (inverted)",
        runPhaseBFourLegBooks,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.EthereumOutpost,
        "phase-b-user-payout",
        "user's ETH balance bumps by ~target",
        runPhaseBUserPayout,
        remitOptions
      )
    )

    // ── 9. WIRE-endpoint exclusion still binds for the owned private pair ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "PrivateToWireExcluded",
      "A swap sourcing the private ETH reserve toward WIRE draws a SWAP_REVERT and never creates a UWREQ"
    ).push(
      SwapSteps.requestSwapPrivateToWire<Context>(
        Actor.User,
        "request-private-to-wire",
        "user requests private-ETH → WIRE (the privacy gate must reject it)",
        writeOptions
      ),
      verifyStep<Context>(
        Actor.EthereumOutpost,
        "swap-revert-circulated",
        "a SWAP_REVERT attestation circulates back toward the ETH outpost",
        runVerifySwapRevertCirculated,
        // Remit-class budget: request → outpost outbound (up to 2 epochs) →
        // depot reject → SWAP_REVERT rides the NEXT depot outbound (~4-5
        // epochs total). The 3-epoch uwreq budget missed by seconds
        // (2026-07-02: E>D envelope 13 carried the request at t+176s).
        remitOptions
      ),
      verifyStep<Context>(
        Actor.Sysio,
        "no-private-to-wire-uwreq",
        `no (src=PRIVATE, dst=WIRE) UWREQ appears within ${Constants.Timing.NoUwreqWindowMs}ms`,
        runVerifyNoPrivateToWireUwreq,
        noUwreqOptions
      )
    )
  }
}

// ── Substrate-health verify runners ─────────────────────────────────────────

/** Old "WIRE chain is producing blocks" — `get_info` head block is past genesis. */
async function runVerifyWireChainProducing(ctx: Context): Promise<void> {
  const info = await ctx.wire.getInfo()
  Assert.ok(
    Number(info.head_block_num) > 0,
    `WIRE chain is not producing blocks (head_block_num=${info.head_block_num})`
  )
}

/** Old "uwrit.a becomes ACTIVE (deposits credit)" — poll the operator row. */
async function runVerifyUnderwriterActive(ctx: Context): Promise<void> {
  const account = HarnessConstants.underwriterAccountName(0)
  await pollUntil(
    `${account} ACTIVE`,
    async () => {
      const { rows } = await ctx.wire
        .getSysioContract(SysioContractName.opreg)
        .tables.operators.query()
      const underwriter = rows.find(row => row.account === account)
      return (
        underwriter != null &&
        matchesProtoEnum(
          underwriter.status,
          SysioOpregOperatorstatus,
          SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
        )
      )
    },
    Constants.Timing.UwreqDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
}

// ── Gated-handshake verify runners ──────────────────────────────────────────

/** Assert one depot row is ACTIVE with the owner, privacy flag, and EXACT custody. */
function assertPrivateRowActive(
  row: SysioContracts.SysioReservReserveRowType,
  label: string,
  requestedWireAmount: bigint,
  escrowDepotUnits: bigint
): void {
  Assert.ok(row != null, `${label}: private depot row not found`)
  Assert.ok(
    matchesProtoEnum(
      row.status,
      SysioReservReservestatus,
      SysioReservReservestatus.RESERVE_STATUS_ACTIVE
    ),
    `${label}: expected status ACTIVE, got ${row.status}`
  )
  Assert.ok(
    row.owner === Constants.Accounts.Owner,
    `${label}: expected owner ${Constants.Accounts.Owner}, got ${row.owner}`
  )
  Assert.ok(
    row.is_private === true || Number(row.is_private) === 1,
    `${label}: expected is_private=true, got ${row.is_private}`
  )
  // The match escrowed the requested WIRE verbatim; the chain side seeded at
  // the DEPOT-FRAME conversion of the escrow (`ReserveCreate.external_amount`
  // — toDepot(wei,18) / to_depot(·,6)), not the raw chain-native units.
  Assert.strictEqual(
    BigInt(row.reserve_wire_amount),
    requestedWireAmount,
    `${label}: reserve_wire_amount != requested WIRE`
  )
  Assert.strictEqual(
    BigInt(row.reserve_chain_amount),
    escrowDepotUnits,
    `${label}: reserve_chain_amount != depot-frame escrow`
  )
}

/** ETH-side depot row appears PENDING (RESERVE_CREATE relayed). */
async function runVerifyEthereumDepotRowPending(ctx: Context): Promise<void> {
  await pollUntil(
    "ETH private depot row status=PENDING",
    async () => {
      const row = await readPrivateReserveRow(
        ctx,
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Ethereum.TokenCode
      )
      return (
        row != null &&
        matchesProtoEnum(
          row.status,
          SysioReservReservestatus,
          SysioReservReservestatus.RESERVE_STATUS_PENDING
        )
      )
    },
    Constants.Timing.RelayDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
}

/** SOL-side depot row appears PENDING (RESERVE_CREATE relayed). */
async function runVerifySolanaDepotRowPending(ctx: Context): Promise<void> {
  await pollUntil(
    "SOL private depot row status=PENDING",
    async () => {
      const row = await readPrivateReserveRow(
        ctx,
        Constants.Reserves.Solana.ChainCode,
        Constants.Reserves.Solana.TokenCode
      )
      return (
        row != null &&
        matchesProtoEnum(
          row.status,
          SysioReservReservestatus,
          SysioReservReservestatus.RESERVE_STATUS_PENDING
        )
      )
    },
    Constants.Timing.RelayDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
}

/** ETH depot row ACTIVE + owner + is_private + exact custody (old test #4, ETH half). */
async function runVerifyEthereumDepotRowActive(ctx: Context): Promise<void> {
  assertPrivateRowActive(
    await readPrivateReserveRow(
      ctx,
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Ethereum.TokenCode
    ),
    "ETH private reserve",
    Constants.CreateParams.EthereumRequestedWire,
    Constants.CreateParams.EthereumEscrowDepotUnits
  )
}

/** SOL depot row ACTIVE + owner + is_private + exact custody (old test #4, SOL half). */
async function runVerifySolanaDepotRowActive(ctx: Context): Promise<void> {
  assertPrivateRowActive(
    await readPrivateReserveRow(
      ctx,
      Constants.Reserves.Solana.ChainCode,
      Constants.Reserves.Solana.TokenCode
    ),
    "SOL private reserve",
    Constants.CreateParams.SolanaRequestedWire,
    Constants.CreateParams.SolanaEscrowDepotUnits
  )
}

/** RESERVE_READY landed on the ETH outpost (local record ACTIVE). */
async function runVerifyEthereumLocalReserveActive(
  ctx: Context
): Promise<void> {
  await pollUntil(
    "ETH outpost-local private record ACTIVE",
    () => ReserveSteps.readEthereumLocalReserveActive(ctx),
    Constants.Timing.ReadyDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  log.info("[PrivatePair] ETH private reserve ACTIVE end-to-end")
}

/** RESERVE_READY landed on the SOL outpost (Reserve PDA `Active`). */
async function runVerifySolanaLocalReserveActive(ctx: Context): Promise<void> {
  await pollUntil(
    "SOL outpost-local private record ACTIVE",
    () => ReserveSteps.readSolanaLocalReserveActive(ctx),
    Constants.Timing.ReadyDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  log.info("[PrivatePair] SOL private reserve ACTIVE end-to-end")
}

// ── Phase A verify runners ──────────────────────────────────────────────────

/**
 * Mirror the depot's `swap_quote` / `applyswap` math exactly from the live
 * pre-swap rows: `w = cp(src.chain, src.wire, amount)` then
 * `target = cp(dst.wire, dst.chain, w)`. Same integers in == same integers
 * out, so the variance check sees only the fee-sized drift and the books
 * assertions below can demand exact equality.
 */
async function runPhaseAQuote(ctx: Context): Promise<void> {
  const ethereumBook = await ctx.reserveBook(
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Ethereum.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    solanaBook = await ctx.reserveBook(
      Constants.Reserves.Solana.ChainCode,
      Constants.Reserves.Solana.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    wireIntermediate = WireReserveTool.cpOutput(
      ethereumBook.chain,
      ethereumBook.wire,
      Constants.SwapAmounts.PhaseASourceDepotUnits
    ),
    target = WireReserveTool.cpOutput(
      solanaBook.wire,
      solanaBook.chain,
      wireIntermediate
    )
  Assert.ok(wireIntermediate > 0n, "PhaseA: WIRE intermediate must be positive")
  Assert.ok(target > 0n, "PhaseA: target must be positive")
  ctx.outputs
    .set(Outputs.phaseABooksBefore, { src: ethereumBook, dst: solanaBook })
    .set(Outputs.phaseAWireIntermediate, wireIntermediate)
    .set(Outputs.phaseATarget, target)
    .set(Outputs.phaseAUserAtaBefore, await readUserUsdcSolBalance(ctx))
  log.info(`[PhaseA] w=${wireIntermediate} target=${target} (depot units)`)
}

/** The PENDING private-pair UWREQ appears with the expected destination + source amount. */
async function runPhaseAUwreqCreated(ctx: Context): Promise<void> {
  await pollUntil(
    "PhaseA private-pair UWREQ row appears",
    async () =>
      (await readPrivatePairUwreq(
        ctx,
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Solana.ChainCode
      )) != null,
    Constants.Timing.UwreqDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const row = await readPrivatePairUwreq(
    ctx,
    Constants.Reserves.Ethereum.ChainCode,
    Constants.Reserves.Solana.ChainCode
  )
  // Same-owner pairing admitted: the privacy gate let the request through to
  // a real UWREQ instead of a SWAP_REVERT.
  Assert.strictEqual(
    slugValue(row.dst_token_code),
    Constants.Reserves.Solana.TokenCode,
    "PhaseA: UWREQ dst_token_code != USDCSOL"
  )
  Assert.strictEqual(
    BigInt(row.src_amount),
    Constants.SwapAmounts.PhaseASourceDepotUnits,
    "PhaseA: UWREQ src_amount != depot-frame source"
  )
}

/** The UWREQ resolves CONFIRMED backed by exactly TWO locks (one per leg). */
async function runPhaseAUwreqConfirmed(ctx: Context): Promise<void> {
  await pollUntil(
    "PhaseA UWREQ status=CONFIRMED",
    async () =>
      uwreqConfirmed(
        await readPrivatePairUwreq(
          ctx,
          Constants.Reserves.Ethereum.ChainCode,
          Constants.Reserves.Solana.ChainCode
        )
      ),
    Constants.Timing.RaceDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const row = await readPrivatePairUwreq(
    ctx,
    Constants.Reserves.Ethereum.ChainCode,
    Constants.Reserves.Solana.ChainCode
  )
  await assertTwoLegLocks(ctx, Number(row.id), "PhaseA")
}

/** Exactly two locks — one per swap leg chain. */
async function assertTwoLegLocks(
  ctx: Context,
  uwreqId: number,
  label: string
): Promise<void> {
  const locks = await ctx.locksForUwreq(uwreqId)
  Assert.strictEqual(
    locks.length,
    2,
    `${label}: expected TWO locks (one per leg)`
  )
  const lockChains = locks
      .map(lock => slugValue(lock.chain_code))
      .sort((a, b) => a - b),
    expectedChains = [
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Solana.ChainCode
    ].sort((a, b) => a - b)
  Assert.deepStrictEqual(
    lockChains,
    expectedChains,
    `${label}: lock chains != [ETHEREUM, SOLANA]`
  )
}

/**
 * `applyswap` fires inline with the race win: src.chain += src, src.wire -= w
 * (gross), dst.wire += net, dst.chain -= target. The WIRE-leg fee is skimmed
 * inside the hop, so the destination gains the post-fee net and the pair's
 * Σwire drops by exactly the fee (no longer conserved).
 */
async function runPhaseAFourLegBooks(ctx: Context): Promise<void> {
  const booksBefore = ctx.outputs.assert(Outputs.phaseABooksBefore),
    wireIntermediate = ctx.outputs.assert(Outputs.phaseAWireIntermediate),
    target = ctx.outputs.assert(Outputs.phaseATarget),
    fee = WireReserveTool.splitWireFee(
      wireIntermediate,
      await WireReserveTool.readFeeBps(ctx.wire)
    ).fee,
    ethereumBook = await ctx.reserveBook(
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Ethereum.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    solanaBook = await ctx.reserveBook(
      Constants.Reserves.Solana.ChainCode,
      Constants.Reserves.Solana.TokenCode,
      Constants.Reserves.PrivateReserveCode
    )
  Assert.strictEqual(
    ethereumBook.chain,
    booksBefore.src.chain + Constants.SwapAmounts.PhaseASourceDepotUnits,
    "PhaseA books: src.chain must gain the source deposit"
  )
  Assert.strictEqual(
    ethereumBook.wire,
    booksBefore.src.wire - wireIntermediate,
    "PhaseA books: src.wire must give up the gross WIRE intermediate"
  )
  Assert.strictEqual(
    solanaBook.wire,
    booksBefore.dst.wire + wireIntermediate - fee,
    "PhaseA books: dst.wire must gain the post-fee net"
  )
  Assert.strictEqual(
    solanaBook.chain,
    booksBefore.dst.chain - target,
    "PhaseA books: dst.chain must give up the target"
  )
  // Σ reserve_wire_amount over the pair drops by the WIRE-leg fee.
  Assert.strictEqual(
    ethereumBook.wire + solanaBook.wire,
    booksBefore.src.wire + booksBefore.dst.wire - fee,
    "PhaseA books: Σwire must drop by exactly the WIRE-leg fee"
  )
}

/**
 * The target rides the attestation in depot 9-dec units; the SOL outpost pays
 * the user's ATA `from_depot(target, 6)` SPL base units (÷1e3).
 */
async function runPhaseAUserPayout(ctx: Context): Promise<void> {
  const target = ctx.outputs.assert(Outputs.phaseATarget),
    balanceBefore = ctx.outputs.assert(Outputs.phaseAUserAtaBefore),
    drift = WireReserveTool.varianceDrift(
      target,
      Constants.Variance.ToleranceBps
    ),
    floor =
      balanceBefore +
      WireReserveTool.fromDepot(
        target - drift,
        Constants.SwapAmounts.UsdcSolDecimals
      )
  await pollUntil(
    "PhaseA user USDCSOL ATA bump",
    async () => (await readUserUsdcSolBalance(ctx)) >= floor,
    Constants.Timing.RemitDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const balanceAfter = await readUserUsdcSolBalance(ctx)
  log.info(
    `[PhaseA] user received ${balanceAfter - balanceBefore} USDCSOL base units`
  )
  Assert.ok(
    balanceAfter - balanceBefore > 0n,
    "PhaseA: user's USDCSOL ATA must increase"
  )
}

// ── Phase B verify runners ──────────────────────────────────────────────────

/**
 * Same two-hop math, inverted: the SOL reserve is the source leg. Rows are
 * read LIVE so Phase A's book movement is the new baseline.
 */
async function runPhaseBQuote(ctx: Context): Promise<void> {
  const swapUser = ctx.outputs.assert(swapUserOutputKey()),
    ethereumBook = await ctx.reserveBook(
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Ethereum.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    solanaBook = await ctx.reserveBook(
      Constants.Reserves.Solana.ChainCode,
      Constants.Reserves.Solana.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    wireIntermediate = WireReserveTool.cpOutput(
      solanaBook.chain,
      solanaBook.wire,
      Constants.SwapAmounts.PhaseBSourceDepotUnits
    ),
    target = WireReserveTool.cpOutput(
      ethereumBook.wire,
      ethereumBook.chain,
      wireIntermediate
    )
  Assert.ok(wireIntermediate > 0n, "PhaseB: WIRE intermediate must be positive")
  Assert.ok(target > 0n, "PhaseB: target must be positive")
  ctx.outputs
    .set(Outputs.phaseBBooksBefore, { src: solanaBook, dst: ethereumBook })
    .set(Outputs.phaseBWireIntermediate, wireIntermediate)
    .set(Outputs.phaseBTarget, target)
    .set(
      Outputs.phaseBEthereumBalanceBefore,
      await ctx.ethereum.getBalance(swapUser.ethereumWallet.address)
    )
  log.info(`[PhaseB] w=${wireIntermediate} target=${target} (depot units)`)
}

/** The PENDING inverse UWREQ appears carrying the depot-frame source amount. */
async function runPhaseBUwreqCreated(ctx: Context): Promise<void> {
  await pollUntil(
    "PhaseB private-pair UWREQ row appears",
    async () =>
      (await readPrivatePairUwreq(
        ctx,
        Constants.Reserves.Solana.ChainCode,
        Constants.Reserves.Ethereum.ChainCode
      )) != null,
    Constants.Timing.UwreqDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const row = await readPrivatePairUwreq(
    ctx,
    Constants.Reserves.Solana.ChainCode,
    Constants.Reserves.Ethereum.ChainCode
  )
  // `request_swap_spl` rescales the 6-dec source into the depot frame before
  // the attestation, so the UWREQ carries the depot units.
  Assert.strictEqual(
    BigInt(row.src_amount),
    Constants.SwapAmounts.PhaseBSourceDepotUnits,
    "PhaseB: UWREQ src_amount != depot-frame source"
  )
}

/** The inverse UWREQ resolves CONFIRMED backed by exactly TWO locks. */
async function runPhaseBUwreqConfirmed(ctx: Context): Promise<void> {
  await pollUntil(
    "PhaseB UWREQ status=CONFIRMED",
    async () =>
      uwreqConfirmed(
        await readPrivatePairUwreq(
          ctx,
          Constants.Reserves.Solana.ChainCode,
          Constants.Reserves.Ethereum.ChainCode
        )
      ),
    Constants.Timing.RaceDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const row = await readPrivatePairUwreq(
    ctx,
    Constants.Reserves.Solana.ChainCode,
    Constants.Reserves.Ethereum.ChainCode
  )
  await assertTwoLegLocks(ctx, Number(row.id), "PhaseB")
}

/**
 * Inverted hop: SOL is the source (gives up gross wireIntermediate), ETH the
 * destination (gains the post-fee net); Σwire drops by the fee.
 */
async function runPhaseBFourLegBooks(ctx: Context): Promise<void> {
  const booksBefore = ctx.outputs.assert(Outputs.phaseBBooksBefore),
    wireIntermediate = ctx.outputs.assert(Outputs.phaseBWireIntermediate),
    target = ctx.outputs.assert(Outputs.phaseBTarget),
    fee = WireReserveTool.splitWireFee(
      wireIntermediate,
      await WireReserveTool.readFeeBps(ctx.wire)
    ).fee,
    ethereumBook = await ctx.reserveBook(
      Constants.Reserves.Ethereum.ChainCode,
      Constants.Reserves.Ethereum.TokenCode,
      Constants.Reserves.PrivateReserveCode
    ),
    solanaBook = await ctx.reserveBook(
      Constants.Reserves.Solana.ChainCode,
      Constants.Reserves.Solana.TokenCode,
      Constants.Reserves.PrivateReserveCode
    )
  Assert.strictEqual(
    solanaBook.chain,
    booksBefore.src.chain + Constants.SwapAmounts.PhaseBSourceDepotUnits,
    "PhaseB books: src.chain must gain the source deposit"
  )
  Assert.strictEqual(
    solanaBook.wire,
    booksBefore.src.wire - wireIntermediate,
    "PhaseB books: src.wire must give up the gross WIRE intermediate"
  )
  Assert.strictEqual(
    ethereumBook.wire,
    booksBefore.dst.wire + wireIntermediate - fee,
    "PhaseB books: dst.wire must gain the post-fee net"
  )
  Assert.strictEqual(
    ethereumBook.chain,
    booksBefore.dst.chain - target,
    "PhaseB books: dst.chain must give up the target"
  )
  Assert.strictEqual(
    ethereumBook.wire + solanaBook.wire,
    booksBefore.src.wire + booksBefore.dst.wire - fee,
    "PhaseB books: Σwire must drop by exactly the WIRE-leg fee"
  )
}

/**
 * target is depot 9-dec; native ETH is 18-dec so the ETH outpost pays
 * `fromDepot(target, 18)` wei (×1e9) from its custody balance.
 */
async function runPhaseBUserPayout(ctx: Context): Promise<void> {
  const swapUser = ctx.outputs.assert(swapUserOutputKey()),
    target = ctx.outputs.assert(Outputs.phaseBTarget),
    balanceBefore = ctx.outputs.assert(Outputs.phaseBEthereumBalanceBefore),
    targetWei = WireReserveTool.fromDepot(
      target,
      Constants.SwapAmounts.EthereumNativeDecimals
    ),
    driftWei = WireReserveTool.varianceDrift(
      targetWei,
      Constants.Variance.ToleranceBps
    ),
    floor = balanceBefore + (targetWei - driftWei)
  await pollUntil(
    "PhaseB user receives ETH",
    async () =>
      (await ctx.ethereum.getBalance(swapUser.ethereumWallet.address)) >= floor,
    Constants.Timing.RemitDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
  const balanceAfter = await ctx.ethereum.getBalance(
    swapUser.ethereumWallet.address
  )
  log.info(
    `[PhaseB] user received ${balanceAfter - balanceBefore} wei (targetWei=${targetWei})`
  )
  Assert.ok(
    balanceAfter - balanceBefore > 0n,
    "PhaseB: user's ETH balance must increase"
  )
}

// ── Private→WIRE exclusion verify runners ───────────────────────────────────

/**
 * The privacy gate's WIRE-endpoint branch rejects the probe on the depot and
 * routes a SWAP_REVERT back toward the requesting (ETH) outpost — scan the
 * cluster's opp-debugging artifacts for the attestation-type byte tag.
 */
async function runVerifySwapRevertCirculated(ctx: Context): Promise<void> {
  const oppDebuggingDirectory = oppDebuggingPath(ctx.config.clusterPath)
  await pollUntil(
    "SWAP_REVERT attestation circulated toward the ETH outpost",
    async () => containsSwapRevert(oppDebuggingDirectory),
    // Remit-class round trip (see the step registration) — NOT the 3-epoch
    // uwreq budget.
    Constants.Timing.RemitDeadlineMs,
    Constants.Timing.LongPollIntervalMs
  )
}

/**
 * Inverted poll: the forbidden (src=PRIVATE, dst=WIRE) UWREQ must NEVER
 * appear — `pollUntil` throwing its deadline error IS the pass. The privacy
 * gate's WIRE-endpoint branch fires before the variance check ever sees the
 * sentinel target. (The Phase A uwreq — dst=SOLANA — is excluded by the
 * destination filter.)
 */
async function runVerifyNoPrivateToWireUwreq(ctx: Context): Promise<void> {
  await pollUntil(
    "forbidden private→WIRE UWREQ",
    async () =>
      (await readPrivatePairUwreq(
        ctx,
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Wire.ChainCode
      )) != null,
    Constants.Timing.NoUwreqWindowMs,
    Constants.Timing.LongPollIntervalMs
  ).then(
    () => {
      throw new Error(
        "forbidden private→WIRE UWREQ was created — the privacy gate failed to exclude the WIRE endpoint"
      )
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      Assert.ok(
        message.includes("Timed out"),
        `no-uwreq window failed for an unexpected reason: ${message}`
      )
    }
  )
}
