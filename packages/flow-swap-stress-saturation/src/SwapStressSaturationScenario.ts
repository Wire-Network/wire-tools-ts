import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { ChainKind, TokenAmount } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireUnderwriterTool,
  FlowScenario,
  matchesProtoEnum,
  pollStep,
  slugValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type Logger
} from "@wireio/cluster-tool"
import { SwapStressSaturationScenarioConstants as Constants } from "./SwapStressSaturationScenarioConstants.js"
import { SwapStressSaturationScenarioRungSteps as RungSteps } from "./steps/SwapStressSaturationScenarioRungSteps.js"
import { SwapStressSaturationScenarioOwnerSteps as OwnerSteps } from "./steps/SwapStressSaturationScenarioOwnerSteps.js"
import { SwapStressSaturationScenarioReserveSteps as ReserveSteps } from "./steps/SwapStressSaturationScenarioReserveSteps.js"
import { SwapStressSaturationScenarioUserSteps as UserSteps } from "./steps/SwapStressSaturationScenarioUserSteps.js"

const {
  SysioContractName,
  SysioOpregOperatorstatus,
  SysioReservReservestatus
} = SysioContracts
const { Actor } = Report

const log = getLogger(__filename)

/** The scenario context — the shared swap-flow depot query surface. */
type Context = SwapScenarioContext

// ── Depot read helpers (reads execute freely inside verify runners) ─────────

/** The PRIVATE reserve row for `(chainCode, tokenCode)`, or nothing yet. */
async function readPrivateReserveRow(
  ctx: Context,
  chainCode: number,
  tokenCode: number
// eslint-disable-next-line no-restricted-syntax -- this package sets strictNullChecks: true, so the `| null` union IS compiler-enforced
): Promise<SysioContracts.SysioReservReserveRowType | null> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.reserv)
    .tables.reserves.query()
  return (
    rows.find(
      row =>
        slugValue(row.chain_code) === chainCode &&
        slugValue(row.token_code) === tokenCode &&
        slugValue(row.reserve_code) === Constants.Reserves.PrivateReserveCode
    ) ?? null
  )
}

/** True when the reserve row exists and reports `want` (either wire shape). */
function reserveStatusIs(
  row: SysioContracts.SysioReservReserveRowType | null,
  want: number
): boolean {
  return row != null && matchesProtoEnum(row.status, SysioReservReservestatus, want)
}

/**
 * The first underwriter's on-chain account (the SubstrateHealth activation
 * probe).
 *
 * Master split the durable harness LABEL from the generated ACCOUNT, so the
 * account is only knowable from the key store once that operator's
 * materialize step has run — it cannot be derived from the index.
 *
 * @param ctx - The scenario context (carries the accumulated key store).
 * @returns The first underwriter's account name.
 */
function firstUnderwriterAccount(ctx: Context): string {
  const label = HarnessConstants.underwriterLabel(0),
    { account } = ctx.keyStore.assertOperator(label)
  // `account` is optional on OperatorAccount because it is generated at
  // materialize time. Reaching this probe means provisioning already ran, so an
  // absent account is a real ordering bug, not a missing-value case.
  Assert.ok(account != null, `underwriter ${label} has no provisioned account`)
  return account
}

// ── Verify runners (each is the body of a verifyStep) ───────────────────────

/** WIRE chain is producing blocks. */
async function runVerifyWireChainProducing(
  ctx: Context,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const info = await ctx.wire.getInfo()
  Assert.ok(
    Number(info.head_block_num) > 0,
    `WIRE chain is not producing blocks (head_block_num=${info.head_block_num})`
  )
}

/** The first underwriter's deposits credit and it flips ACTIVE. */
const runVerifyUnderwriterActive = pollStep.lift<Context>(
  // The LABEL is the durable harness handle, known at plan time; the ACCOUNT
  // is only knowable from the key store once the operator materializes, so it
  // is resolved inside the predicate rather than interpolated here.
  `${HarnessConstants.underwriterLabel(0)} ACTIVE`,
  async ctx => {
    const account = firstUnderwriterAccount(ctx),
      { rows } = await ctx.wire
        .getSysioContract(SysioContractName.opreg)
        .tables.operators.query()
    return rows.some(
      row =>
        row.account === account &&
        matchesProtoEnum(
          row.status,
          SysioOpregOperatorstatus,
          SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
        )
    )
  },
  Constants.Timing.UwreqDeadlineMs,
  Constants.Timing.LongPollIntervalMs
)

/** The ETH-side private depot row appears with status=PENDING. */
const runVerifyEthereumDepotRowPending = pollStep.lift<Context>(
  "ETH private depot row PENDING",
  async ctx =>
    reserveStatusIs(
      await readPrivateReserveRow(
        ctx,
        Constants.Reserves.Ethereum.ChainCode,
        Constants.Reserves.Ethereum.TokenCode
      ),
      SysioReservReservestatus.RESERVE_STATUS_PENDING
    ),
  Constants.Timing.RelayDeadlineMs,
  Constants.Timing.LongPollIntervalMs
)

/** The ETH depot row is ACTIVE after the owner's match. */
async function runVerifyEthereumDepotRowActive(
  ctx: Context,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const row = await readPrivateReserveRow(
    ctx,
    Constants.Reserves.Ethereum.ChainCode,
    Constants.Reserves.Ethereum.TokenCode
  )
  Assert.ok(
    reserveStatusIs(row, SysioReservReservestatus.RESERVE_STATUS_ACTIVE),
    "ETH private depot row is not ACTIVE after matchreserve"
  )
}

/** RESERVE_READY flips the ETH outpost-local private record ACTIVE. */
const runVerifyEthereumLocalReserveActive = pollStep.lift<Context>(
  "ETH outpost-local private record ACTIVE",
  ctx => ReserveSteps.readEthereumLocalReserveActive(ctx),
  Constants.Timing.ReadyDeadlineMs,
  Constants.Timing.LongPollIntervalMs
)

/** The SOL-side private depot row appears with status=PENDING. */
const runVerifySolanaDepotRowPending = pollStep.lift<Context>(
  "SOL private depot row PENDING",
  async ctx =>
    reserveStatusIs(
      await readPrivateReserveRow(
        ctx,
        Constants.Reserves.Solana.ChainCode,
        Constants.Reserves.Solana.TokenCode
      ),
      SysioReservReservestatus.RESERVE_STATUS_PENDING
    ),
  Constants.Timing.RelayDeadlineMs,
  Constants.Timing.LongPollIntervalMs
)

/** The SOL depot row is ACTIVE after the owner's match. */
async function runVerifySolanaDepotRowActive(
  ctx: Context,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const row = await readPrivateReserveRow(
    ctx,
    Constants.Reserves.Solana.ChainCode,
    Constants.Reserves.Solana.TokenCode
  )
  Assert.ok(
    reserveStatusIs(row, SysioReservReservestatus.RESERVE_STATUS_ACTIVE),
    "SOL private depot row is not ACTIVE after matchreserve"
  )
}

/** RESERVE_READY flips the SOL outpost-local Reserve PDA ACTIVE. */
const runVerifySolanaLocalReserveActive = pollStep.lift<Context>(
  "SOL outpost-local Reserve PDA ACTIVE",
  ctx => ReserveSteps.readSolanaLocalReserveActive(ctx),
  Constants.Timing.ReadyDeadlineMs,
  Constants.Timing.LongPollIntervalMs
)

/**
 * Flow (excluded soak): saturate both Ethereum OPP directions by ramping
 * low-value swaps from many wallets through a same-owner PRIVATE reserve pair.
 *
 * This scenario is registered with the CI gate's `FLOW_EXCLUDE` deny-list: it
 * is an out-of-band soak, not a per-PR gate flow. Setup stands up the same
 * gated same-owner PRIVATE reserve pair as `flow-swap-private-reserves` (ETH
 * native × USDCSOL SPL) via the REAL handshake — outpost `create_reserve` →
 * depot PENDING → owner `matchreserve` → ACTIVE + RESERVE_READY — sized ~1000×
 * the per-swap draw, then provisions the deterministic stress-user roster the
 * ramp campaign reuses.
 *
 * The RunCampaign phase then drives `runSaturationRamp` — per-swap ETH
 * `ReserveManager.requestSwap` + `sysio.uwrit::swapfromwire` bursts with
 * delta-based payout observers and canonical OPP-envelope telemetry — and the
 * closing verify step asserts BOTH Ethereum OPP directions saturated.
 */
export class SwapStressSaturationScenario extends FlowScenario<Context> {
  readonly name = "flow-swap-stress-saturation"
  readonly description =
    "Excluded soak: ramp low-value swaps from many wallets through a same-owner PRIVATE reserve pair until both Ethereum OPP directions saturate"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.Timing.EpochDurationSec,
    // The ramp rides the ETH/PRIMARY public reserve on BOTH campaign phases
    // (phase-1 source side, phase-2 target side) — the bootstrap must seed the
    // mock PRIMARY reserves (mock seeding is opt-in, per scenario defaults).
    enableMockReserves: true,
    // `createuwreq` re-checks `meets_role_min` for BOTH legs of every swap.
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
    // The underwriter bonds on every leg the ramp touches: native ETH (sized
    // for the full ramp's phase-2 remit volume), native SOL, and USDCSOL.
    underwriterCollateral: [
      [
        {
          chain_code: Constants.Reserves.Ethereum.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
            amount: Constants.Underwriting.EthereumCollateral
          })
        },
        {
          chain_code: Constants.Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Solana.NativeTokenCode),
            amount: Constants.Underwriting.SolanaCollateral
          })
        },
        {
          chain_code: Constants.Reserves.Solana.ChainCode,
          amount: TokenAmount.create({
            tokenCode: BigInt(Constants.Reserves.Solana.TokenCode),
            amount: Constants.Underwriting.SolanaCollateral
          })
        }
      ]
    ]
  }

  override createContext(config: ClusterConfig, contextLog: Logger): Context {
    return new SwapScenarioContext(config, contextLog)
  }

  plan(cluster: ClusterBuild<Context>): void {
    const writeOptions = { timeoutMs: Constants.Timing.WriteDeadlineMs },
      relayOptions = {
        timeoutMs:
          Constants.Timing.RelayDeadlineMs + Constants.Timing.PollDeadlineBufferMs
      },
      readyOptions = {
        timeoutMs:
          Constants.Timing.ReadyDeadlineMs + Constants.Timing.PollDeadlineBufferMs
      },
      uwreqOptions = {
        timeoutMs:
          Constants.Timing.UwreqDeadlineMs + Constants.Timing.PollDeadlineBufferMs
      }

    // ── 1. Underwriter collateral (the old harness's bootstrap deposits) ──
    const underwriterAccounts = Array.from(
      { length: cluster.config.underwriterCount },
      (_value, index) => HarnessConstants.underwriterLabel(index)
    )
    WireUnderwriterTool.planCollateralDeposit(
      cluster,
      "UnderwriterCollateral",
      "Underwriters bond collateral on every leg the ramp touches",
      writeOptions,
      underwriterAccounts,
      cluster.config.underwriterCollateral ??
        WireUnderwriterTool.load(null, cluster.config.underwriterCount)
    )

    // ── 2. Substrate health ──
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
        `${HarnessConstants.underwriterLabel(0)} becomes ACTIVE (deposits credit)`,
        runVerifyUnderwriterActive,
        uwreqOptions
      )
    )

    // ── 3. The reserve creator's dual-chain identity (creator on BOTH chains) ──
    SwapUserIdentities.planIdentityProvisioning<Context>(
      cluster,
      "CreatorIdentity",
      "Provision the dual-chain reserve creator identity",
      writeOptions
    )

    // ── 4. The single owner — WIRE account + authex links + SPL funding ──
    ClusterBuildPhase.create<Context>(
      cluster,
      "OwnerProvisioning",
      `Provision ${Constants.Accounts.Owner} (WIRE account, BOTH-chain authex links, creator USDCSOL funding)`
    ).push(
      OwnerSteps.planProvisionOwner<Context>(
        Actor.User,
        "provision-owner",
        `create + fund the ${Constants.Accounts.Owner} WIRE account`,
        writeOptions
      ),
      OwnerSteps.planLinkOwner<Context>(
        Actor.User,
        "link-owner-ethereum",
        `authex-link ${Constants.Accounts.Owner} to the ETH creator wallet's secp256k1 key`,
        writeOptions,
        ChainKind.EVM
      ),
      OwnerSteps.planLinkOwner<Context>(
        Actor.User,
        "link-owner-solana",
        `authex-link ${Constants.Accounts.Owner} to the SOL creator keypair's ed25519 key`,
        writeOptions,
        ChainKind.SVM
      ),
      OwnerSteps.planMintCreatorUsdcSol<Context>(
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
      ReserveSteps.planCreateEthereumReserve<Context>(
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
      ReserveSteps.planMatchReserve<Context>(
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
        "the ETH depot row is ACTIVE after the owner's match",
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
      "SOL outpost create_reserve(isPrivate) → depot PENDING → matchreserve → ACTIVE + RESERVE_READY"
    ).push(
      ReserveSteps.planCreateSolanaReserve<Context>(
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
      ReserveSteps.planMatchReserve<Context>(
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
        "the SOL depot row is ACTIVE after the owner's match",
        runVerifySolanaDepotRowActive,
        writeOptions
      ),
      verifyStep<Context>(
        Actor.SolanaOutpost,
        "solana-local-record-active",
        "RESERVE_READY flips the SOL outpost-local Reserve PDA ACTIVE",
        runVerifySolanaLocalReserveActive,
        readyOptions
      )
    )

    // ── 7. The deterministic stress-user roster the ramp reuses ──
    UserSteps.planProvisionStressAccounts<Context>(
      cluster,
      "StressWireAccounts",
      `Provision ${Constants.StressAccounts.Count} deterministic stress WIRE accounts`,
      writeOptions,
      Constants.StressAccounts.Count,
      Constants.StressAccounts.Funding
    )

    // ── 8. The ramp campaign: one Phase per rung + saturation verification ──
    //
    // The curve is static (derived from the load profile at plan time), so the
    // whole campaign is registered up-front and the Report narrates every
    // rung's individual bursts, payout observations, and metric collections
    // instead of hiding them inside one multi-minute row. The campaign is ONE
    // PhaseGroup so the Report marks where the stress run begins and ends.
    const campaign = RungSteps.planCampaign<Context>(cluster)
    log.debug(
      `${this.name}: setup + ${campaign.name} group of ` +
        `${campaign.children.length} phases registered ` +
        `(${Constants.Ramp.RungAccountCounts.join(" → ")} accounts, ` +
        `load level '${Constants.Ramp.Level}', ` +
        `${Constants.Ramp.SaturatedEnvelopeMinBytes}-byte envelope target)`
    )
  }
}
