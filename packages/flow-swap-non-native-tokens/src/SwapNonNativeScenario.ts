import Assert from "node:assert"
import { TokenAmount } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Constants as HarnessConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireUnderwriterTool,
  slugValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildStep,
  type ClusterBuildStepOptions,
  type ClusterConfig,
  type Logger
} from "@wireio/test-cluster-tool"
import { SwapNonNativeScenarioConstants as Constants } from "./SwapNonNativeScenarioConstants.js"
import {
  SwapDestinationKind,
  SwapNonNativeScenarioTokenSteps as TokenSteps,
  type SwapCell,
  type UnderwriterCollateralMatrix
} from "./steps/SwapNonNativeScenarioTokenSteps.js"

const { SysioContractName } = SysioContracts
const { Actor } = Report
const { Reserves, SwapAmounts, Timing, TokenDecimals } = Constants

// ── Step option presets (poll deadline + buffer per the timing budgets) ─────

/** On-chain write steps (mint / approve / permit / requestSwap transactions). */
const WriteStepOptions: ClusterBuildStepOptions = { timeoutMs: Timing.WriteTimeoutMs }
/** Verify steps polling to the UWREQ-creation / lock deadline. */
const UwreqStepOptions: ClusterBuildStepOptions = {
  timeoutMs: Timing.UwreqDeadlineMs + Timing.PollDeadlineBufferMs
}
/** Verify steps polling to the underwriter-race deadline. */
const RaceStepOptions: ClusterBuildStepOptions = {
  timeoutMs: Timing.RaceDeadlineMs + Timing.PollDeadlineBufferMs
}
/** Verify steps polling to the remit / relay deadline. */
const RemitStepOptions: ClusterBuildStepOptions = {
  timeoutMs: Timing.RemitDeadlineMs + Timing.PollDeadlineBufferMs
}

// ── The swap matrix (one SwapCell per old jest test) ────────────────────────

/** USDC (ETH) → native SOL: permit custody + cross-chain payout (old test 1). */
const UsdcPermitToSolanaNativeCell: SwapCell = {
  name: "usdc-permit-to-solana-native",
  sourceChainCode: Reserves.Ethereum.ChainCode,
  sourceTokenCode: Reserves.Ethereum.USDC,
  sourceAmount: SwapAmounts.SourceErc20Stable,
  sourceDecimals: TokenDecimals.Erc20Stable,
  targetChainCode: Reserves.Solana.ChainCode,
  targetTokenCode: Reserves.Solana.SOL,
  // Native SOL is 9-dec — the depot-frame target IS lamports.
  destinationDecimals: TokenDecimals.SolanaNative,
  destination: SwapDestinationKind.solanaNative
}

/** USDT (ETH) → native SOL: pre-set-allowance custody + payout (old test 2). */
const UsdtApprovalToSolanaNativeCell: SwapCell = {
  name: "usdt-approval-to-solana-native",
  sourceChainCode: Reserves.Ethereum.ChainCode,
  sourceTokenCode: Reserves.Ethereum.USDT,
  sourceAmount: SwapAmounts.SourceErc20Stable,
  sourceDecimals: TokenDecimals.Erc20Stable,
  targetChainCode: Reserves.Solana.ChainCode,
  targetTokenCode: Reserves.Solana.SOL,
  destinationDecimals: TokenDecimals.SolanaNative,
  destination: SwapDestinationKind.solanaNative
}

/** USDCSOL (SPL) → native ETH: signed `request_swap_spl` custody (old test 3). */
const UsdcSolanaToEthereumNativeCell: SwapCell = {
  name: "usdcsol-spl-to-ethereum-native",
  sourceChainCode: Reserves.Solana.ChainCode,
  sourceTokenCode: Reserves.Solana.USDCSOL,
  sourceAmount: SwapAmounts.SourceSplStable,
  sourceDecimals: TokenDecimals.SplStable,
  targetChainCode: Reserves.Ethereum.ChainCode,
  targetTokenCode: Reserves.Ethereum.ETH,
  // The target publishes in depot 9-dec units; the outpost pays wei (×1e9).
  destinationDecimals: TokenDecimals.EthereumNative,
  destination: SwapDestinationKind.ethereumNative
}

/** USDC (ETH) → USDT-on-SOL: cross-chain ERC-20 → SPL stablecoin swap (old test 4). */
const UsdcPermitToUsdtSolanaCell: SwapCell = {
  name: "usdc-permit-to-usdtsol",
  sourceChainCode: Reserves.Ethereum.ChainCode,
  sourceTokenCode: Reserves.Ethereum.USDC,
  sourceAmount: SwapAmounts.SourceErc20Stable,
  sourceDecimals: TokenDecimals.Erc20Stable,
  targetChainCode: Reserves.Solana.ChainCode,
  targetTokenCode: Reserves.Solana.USDTSOL,
  // 6-dec SPL destination — at/below the cap, `fromDepot(target)` is identity.
  destinationDecimals: TokenDecimals.SplStable,
  destination: SwapDestinationKind.solanaSplToken
}

/** USDC (ETH) → USDC-on-SOL: cross-chain same-asset bridging (old test 5). */
const UsdcPermitToUsdcSolanaCell: SwapCell = {
  name: "usdc-permit-to-usdcsol",
  sourceChainCode: Reserves.Ethereum.ChainCode,
  sourceTokenCode: Reserves.Ethereum.USDC,
  sourceAmount: SwapAmounts.SourceErc20Stable,
  sourceDecimals: TokenDecimals.Erc20Stable,
  targetChainCode: Reserves.Solana.ChainCode,
  targetTokenCode: Reserves.Solana.USDCSOL,
  destinationDecimals: TokenDecimals.SplStable,
  destination: SwapDestinationKind.solanaSplToken
}

// ── Flow-local composition helpers ──────────────────────────────────────────

/** The (chain, token) legs every underwriter bonds — the full swap matrix set. */
const UnderwriterCollateralLegPairs: ReadonlyArray<
  [chainCode: number, tokenCode: number]
> = [
  [Reserves.Ethereum.ChainCode, Reserves.Ethereum.ETH],
  [Reserves.Ethereum.ChainCode, Reserves.Ethereum.USDC],
  [Reserves.Ethereum.ChainCode, Reserves.Ethereum.USDT],
  [Reserves.Solana.ChainCode, Reserves.Solana.SOL],
  [Reserves.Solana.ChainCode, Reserves.Solana.USDCSOL],
  [Reserves.Solana.ChainCode, Reserves.Solana.USDTSOL]
]

/**
 * Build the single-underwriter collateral plan: one
 * {@link Constants.UnderwriterCollateralAmount} bond per swap-matrix leg.
 *
 * @returns The per-underwriter entry list (the defaults wrap it in the outer
 *   per-underwriter array).
 */
function underwriterCollateralLegs(): UnderwriterCollateralMatrix[number] {
  return UnderwriterCollateralLegPairs.map(([chainCode, tokenCode]) => ({
    chain_code: chainCode,
    amount: TokenAmount.create({
      tokenCode: BigInt(tokenCode),
      amount: Constants.UnderwriterCollateralAmount
    })
  }))
}

/** Reserve token codes the bootstrap must seed on the Ethereum side (old phase 0). */
const EthereumReserveTokenCodes = [
  Reserves.Ethereum.ETH,
  Reserves.Ethereum.LIQETH,
  Reserves.Ethereum.USDC,
  Reserves.Ethereum.USDT
]

/** Reserve token codes the bootstrap must seed on the Solana side (old phase 0). */
const SolanaReserveTokenCodes = [
  Reserves.Solana.SOL,
  Reserves.Solana.LIQSOL,
  Reserves.Solana.USDCSOL,
  Reserves.Solana.USDTSOL
]

/**
 * READ the seeded reserve token codes for `chainCode` from
 * `sysio.reserv::reserves` (typed table accessor).
 *
 * @param ctx - The scenario context.
 * @param chainCode - The chain slug value to filter on.
 * @returns The token slug values of every seeded reserve on the chain.
 */
async function readReserveTokenCodes(
  ctx: SwapScenarioContext,
  chainCode: number
): Promise<number[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.reserv)
    .tables.reserves.query({ limit: 50 })
  return rows
    .filter(row => slugValue(row.chain_code) === chainCode)
    .map(row => slugValue(row.token_code))
}

/**
 * Assert every expected reserve token code was seeded on a chain.
 *
 * @param seeded - Token codes read back from the depot.
 * @param expected - Token codes the bootstrap must have seeded.
 * @param chainName - Chain label for the failure message.
 */
function assertReserveTokenCodes(
  seeded: number[],
  expected: number[],
  chainName: string
): void {
  expected.forEach(code =>
    Assert.ok(
      seeded.includes(code),
      `reserve for token code ${code} missing on ${chainName} (seeded: ${seeded.join(", ")})`
    )
  )
}

/**
 * The verify tail every swap cell shares: the depot opens a NEW uwreq row, the
 * underwriter race resolves it to CONFIRMED, both legs lock, and the user's
 * destination balance bumps by the variance-adjusted target.
 *
 * @param cell - The swap cell under verification.
 * @returns The four verify steps, in lifecycle order.
 */
function swapVerifySteps(cell: SwapCell): ClusterBuildStep.Any<SwapScenarioContext>[] {
  const destinationActor =
    cell.destination === SwapDestinationKind.ethereumNative
      ? Actor.EthereumOutpost
      : Actor.SolanaOutpost
  return [
    TokenSteps.verifyUwreqCreated(
      Actor.Sysio,
      "uwreq-created",
      "depot opens a new UWREQ row for the swap",
      UwreqStepOptions,
      cell
    ),
    TokenSteps.verifyUwreqConfirmed(
      Actor.Underwriter,
      "uwreq-confirmed",
      "the underwriter race resolves the UWREQ to CONFIRMED",
      RaceStepOptions,
      cell
    ),
    TokenSteps.verifyUwreqLocks(
      Actor.Sysio,
      "uwreq-locks",
      `both legs locked (${Constants.LocksPerSwap} persistent locks)`,
      UwreqStepOptions,
      cell
    ),
    TokenSteps.verifyDestinationPayout(
      destinationActor,
      "payout",
      "the user's destination balance bumps by the variance-adjusted target",
      RemitStepOptions,
      cell
    )
  ]
}

/**
 * Flow: SWAP_REQUEST → underwriter race → SWAP_REMIT for **non-native** source
 * tokens on both outposts. Extends the bidirectional native swap proven in
 * `flow-swap-with-underwriting` to ERC-20 source custody on Ethereum
 * (USDC via EIP-2612 permit, USDT via pre-set allowance) and SPL source
 * custody on Solana (USDCSOL via signed `request_swap_spl`), plus the mixed
 * ERC-20 → SPL combinations (USDC → USDTSOL, USDC → USDCSOL bridging).
 *
 * Scenario phases on top of the bootstrap:
 *
 * 1. **UnderwriterCollateral** — bond every (chain, token) leg the swap matrix
 *    touches (from the `underwriterCollateral` defaults matrix).
 * 2. **SwapUser** — provision the dual-chain swap user identity.
 * 3. **SetupTokens** — mint mock stablecoin balances to the user (one write
 *    step per mint on each chain).
 * 4. **ClusterHealth** — chain liveness + the bootstrap-seeded non-native
 *    reserves on both chains (old phase-0 assertions).
 * 5. **UnderwriterBondsRelayed** — gate: every bond credited depot-side.
 * 6. **SwapEthereumToSolanaErc20** — the four ERC-20-source cells (permit /
 *    approval / mixed SPL destinations).
 * 7. **SwapSolanaToEthereumSpl** — the SPL-source inverse direction.
 *
 * **Canonical proof** for every cell: the destination balance bumps by the
 * variance-adjusted target — only achievable if every layer (source custody,
 * OPP envelope round-trip, underwriter race, depot variance check, destination
 * payout) worked.
 */
export class SwapNonNativeScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-non-native-tokens"
  readonly description =
    "SWAP with non-native tokens (USDC / USDT / USDCSOL / USDTSOL) across both outposts"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Timing.EpochDurationSec,
    // The underwriter must bond on every (chain, token) leg this flow's swap
    // matrix touches — `sysio.uwrit::createuwreq` re-checks `meets_role_min`
    // for BOTH legs, and the underwriter plugin's `select_coverable` requires
    // a non-zero credit line per (chain, token).
    requiredUnderwriterCollateral: [
      {
        chainCode: Reserves.Ethereum.ChainCode,
        tokenCode: Reserves.Ethereum.ETH,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Reserves.Solana.ChainCode,
        tokenCode: Reserves.Solana.SOL,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ],
    underwriterCollateral: [underwriterCollateralLegs()]
  }

  override createContext(config: ClusterConfig, log: Logger): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  build(cluster: ClusterBuild<SwapScenarioContext>): void {
    const config = cluster.context.config
    const underwriterAccounts = Array.from(
      { length: config.underwriterCount },
      (_, index) => HarnessConstants.underwriterAccountName(index)
    )
    const collateral = config.underwriterCollateral
    Assert.ok(
      collateral != null && collateral.length === underwriterAccounts.length,
      `flow-swap-non-native-tokens: expected a collateral matrix for ` +
        `${underwriterAccounts.length} underwriter(s), got ${collateral?.length ?? 0}`
    )

    // ── 1. Bond every (chain, token) leg the swap matrix touches ──
    WireUnderwriterTool.deposit<SwapScenarioContext>(
      cluster,
      "UnderwriterCollateral",
      "Bond the per-leg underwriter collateral for the swap matrix",
      WriteStepOptions,
      underwriterAccounts,
      collateral
    )

    // ── 2. The dual-chain swap end-user ──
    SwapUserIdentities.ensure<SwapScenarioContext>(
      cluster,
      "SwapUser",
      "Provision the dual-chain swap user identity",
      WriteStepOptions
    )

    // ── 3. Mock stablecoin balances for the user's source legs ──
    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "SetupTokens",
      "Mint mock stablecoin balances to the swap user on both chains"
    ).push(
      TokenSteps.mintErc20ToSwapUser(
        Actor.User,
        "mint-usdc",
        `mint ${Constants.Erc20FundingAmount} USDC base units to the swap user`,
        WriteStepOptions,
        Reserves.Ethereum.USDC,
        Constants.Erc20FundingAmount
      ),
      TokenSteps.mintErc20ToSwapUser(
        Actor.User,
        "mint-usdt",
        `mint ${Constants.Erc20FundingAmount} USDT base units to the swap user`,
        WriteStepOptions,
        Reserves.Ethereum.USDT,
        Constants.Erc20FundingAmount
      ),
      TokenSteps.mintSplToSwapUser(
        Actor.User,
        "mint-usdcsol",
        `mint ${Constants.SplFundingAmount} USDCSOL base units into the swap user's ATA`,
        WriteStepOptions,
        Reserves.Solana.USDCSOL,
        Constants.SplFundingAmount
      ),
      TokenSteps.mintSplToSwapUser(
        Actor.User,
        "mint-usdtsol",
        `mint ${Constants.SplFundingAmount} USDTSOL base units into the swap user's ATA`,
        WriteStepOptions,
        Reserves.Solana.USDTSOL,
        Constants.SplFundingAmount
      )
    )

    // ── 4. Cluster health + non-native reserve presence (old phase 0) ──
    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "ClusterHealth",
      "Chain liveness + bootstrap-seeded non-native reserves"
    ).push(
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "chain-producing",
        "WIRE chain is producing blocks",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            "WIRE chain reported head_block_num 0"
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "ethereum-reserves-seeded",
        "bootstrap seeded the ETH / LIQETH / USDC / USDT reserves on ETHEREUM",
        async ctx => {
          assertReserveTokenCodes(
            await readReserveTokenCodes(ctx, Reserves.Ethereum.ChainCode),
            EthereumReserveTokenCodes,
            "ETHEREUM"
          )
        }
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Sysio,
        "solana-reserves-seeded",
        "bootstrap seeded the SOL / LIQSOL / USDCSOL / USDTSOL reserves on SOLANA",
        async ctx => {
          assertReserveTokenCodes(
            await readReserveTokenCodes(ctx, Reserves.Solana.ChainCode),
            SolanaReserveTokenCodes,
            "SOLANA"
          )
        }
      )
    )

    // ── 5. Gate: outpost bonds credited depot-side before the first swap ──
    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "UnderwriterBondsRelayed",
      "Every underwriter bond relayed + credited on sysio.opreg"
    ).push(
      TokenSteps.verifyUnderwriterBondsRelayed(
        Actor.Sysio,
        "bonds-relayed",
        "sysio.opreg balance rows exist for every collateral leg",
        RemitStepOptions,
        underwriterAccounts,
        collateral
      )
    )

    // ── 6. ERC-20 source custody on Ethereum → Solana payouts ──
    const ethereumToSolana = ClusterBuildPhaseGroup.create<SwapScenarioContext>(
      cluster,
      "SwapEthereumToSolanaErc20",
      "ERC-20 source custody on Ethereum → Solana payouts (permit + approval paths)"
    )
    ClusterBuildPhase.create<SwapScenarioContext>(
      ethereumToSolana,
      "UsdcPermitToSolanaNative",
      "USDC (ETH) → native SOL: permit custody + cross-chain payout"
    ).push(
      TokenSteps.quoteTarget(
        Actor.Sysio,
        "quote-target",
        "quote the swap live against the depot reserve books",
        WriteStepOptions,
        UsdcPermitToSolanaNativeCell
      ),
      TokenSteps.signPermit(
        Actor.User,
        "sign-permit",
        "user signs the EIP-2612 permit for the swap amount",
        WriteStepOptions,
        UsdcPermitToSolanaNativeCell
      ),
      TokenSteps.requestSwapErc20WithPermit(
        Actor.User,
        "request-swap",
        `swap ${SwapAmounts.SourceErc20Stable} USDC base units → SOL via inline permit`,
        WriteStepOptions,
        UsdcPermitToSolanaNativeCell
      ),
      TokenSteps.verifyErc20Custody(
        Actor.EthereumOutpost,
        "custody-escrowed",
        "ReserveManager's USDC balance bumps by exactly the source amount",
        WriteStepOptions,
        UsdcPermitToSolanaNativeCell
      ),
      ...swapVerifySteps(UsdcPermitToSolanaNativeCell)
    )
    ClusterBuildPhase.create<SwapScenarioContext>(
      ethereumToSolana,
      "UsdtApprovalToSolanaNative",
      "USDT (ETH) → native SOL: pre-set-allowance custody + cross-chain payout"
    ).push(
      TokenSteps.quoteTarget(
        Actor.Sysio,
        "quote-target",
        "quote the swap live against the depot reserve books",
        WriteStepOptions,
        UsdtApprovalToSolanaNativeCell
      ),
      TokenSteps.approveErc20Spend(
        Actor.User,
        "approve-spend",
        "user pre-approves ReserveManager for the swap amount (no-permit path)",
        WriteStepOptions,
        UsdtApprovalToSolanaNativeCell
      ),
      TokenSteps.requestSwapErc20WithApproval(
        Actor.User,
        "request-swap",
        `swap ${SwapAmounts.SourceErc20Stable} USDT base units → SOL via pre-set allowance`,
        WriteStepOptions,
        UsdtApprovalToSolanaNativeCell
      ),
      TokenSteps.verifyErc20Custody(
        Actor.EthereumOutpost,
        "custody-escrowed",
        "ReserveManager's USDT balance bumps by exactly the source amount",
        WriteStepOptions,
        UsdtApprovalToSolanaNativeCell
      ),
      ...swapVerifySteps(UsdtApprovalToSolanaNativeCell)
    )
    ClusterBuildPhase.create<SwapScenarioContext>(
      ethereumToSolana,
      "UsdcPermitToUsdtSolana",
      "USDC (ETH) → USDT (SOL): cross-chain ERC-20 → SPL stablecoin swap"
    ).push(
      TokenSteps.quoteTarget(
        Actor.Sysio,
        "quote-target",
        "quote the swap live against the depot reserve books",
        WriteStepOptions,
        UsdcPermitToUsdtSolanaCell
      ),
      TokenSteps.signPermit(
        Actor.User,
        "sign-permit",
        "user signs the EIP-2612 permit for the swap amount",
        WriteStepOptions,
        UsdcPermitToUsdtSolanaCell
      ),
      TokenSteps.requestSwapErc20WithPermit(
        Actor.User,
        "request-swap",
        `swap ${SwapAmounts.SourceErc20Stable} USDC base units → USDTSOL via inline permit`,
        WriteStepOptions,
        UsdcPermitToUsdtSolanaCell
      ),
      TokenSteps.verifyErc20Custody(
        Actor.EthereumOutpost,
        "custody-escrowed",
        "ReserveManager's USDC balance bumps by exactly the source amount",
        WriteStepOptions,
        UsdcPermitToUsdtSolanaCell
      ),
      ...swapVerifySteps(UsdcPermitToUsdtSolanaCell)
    )
    ClusterBuildPhase.create<SwapScenarioContext>(
      ethereumToSolana,
      "UsdcPermitToUsdcSolana",
      "USDC (ETH) → USDCSOL: cross-chain same-asset bridging"
    ).push(
      TokenSteps.quoteTarget(
        Actor.Sysio,
        "quote-target",
        "quote the swap live against the depot reserve books",
        WriteStepOptions,
        UsdcPermitToUsdcSolanaCell
      ),
      TokenSteps.signPermit(
        Actor.User,
        "sign-permit",
        "user signs the EIP-2612 permit for the swap amount",
        WriteStepOptions,
        UsdcPermitToUsdcSolanaCell
      ),
      TokenSteps.requestSwapErc20WithPermit(
        Actor.User,
        "request-swap",
        `swap ${SwapAmounts.SourceErc20Stable} USDC base units → USDCSOL via inline permit`,
        WriteStepOptions,
        UsdcPermitToUsdcSolanaCell
      ),
      TokenSteps.verifyErc20Custody(
        Actor.EthereumOutpost,
        "custody-escrowed",
        "ReserveManager's USDC balance bumps by exactly the source amount",
        WriteStepOptions,
        UsdcPermitToUsdcSolanaCell
      ),
      ...swapVerifySteps(UsdcPermitToUsdcSolanaCell)
    )

    // ── 7. SPL source custody on Solana → native ETH payout ──
    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "SwapSolanaToEthereumSpl",
      "SPL source custody on Solana → native ETH payout"
    ).push(
      TokenSteps.quoteTarget(
        Actor.Sysio,
        "quote-target",
        "quote the swap live against the depot reserve books",
        WriteStepOptions,
        UsdcSolanaToEthereumNativeCell
      ),
      TokenSteps.requestSwapSpl(
        Actor.User,
        "request-swap",
        `swap ${SwapAmounts.SourceSplStable} USDCSOL base units → ETH via signed request_swap_spl`,
        WriteStepOptions,
        UsdcSolanaToEthereumNativeCell
      ),
      ...swapVerifySteps(UsdcSolanaToEthereumNativeCell)
    )
  }
}
