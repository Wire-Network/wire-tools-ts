import Assert from "node:assert"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import type { WireClient } from "../../clients/wire/WireClient.js"
import { slugValue } from "../../utils/slugUtils.js"

const { SysioContractName } = SysioContracts

/**
 * AMM / reserve math + reads for the depot's swap surface — the TypeScript
 * mirror of `sysio::opp::amm` (constant-product output, WIRE-leg fee split)
 * plus the client-side `swapquote` evaluation over the live
 * `sysio.reserv::reserves` books. Pure value helpers (called inside step
 * runners) and reads only — every swap WRITE is a Step owned by the swap
 * tools.
 */
export namespace WireReserveTool {
  /** Basis-point denominator (10000 = 100%). */
  export const BpsTotal = 10_000

  /**
   * Reward share of the WIRE-leg fee, in basis points (the remainder routes to
   * the emissions treasury). Mirrors `sysio.reserv::FEE_REWARD_SHARE_BPS`
   * (5000 = a 50/50 reward/emissions split). The reward share is retained in
   * `sysio.reserv` custody as a rewards bucket; only the emissions share leaves
   * custody — so it is the half that shifts a flow's custody-balance assertion.
   */
  export const FeeRewardShareBps = 5_000

  /** The WIRE chain's slug value (the depot leg of every quote). */
  export const WireChainCode = Number(SlugName.from("WIRE"))
  /** The WIRE token's slug value. */
  export const WireTokenCode = Number(SlugName.from("WIRE"))

  /**
   * Upper bound for a single-page scan of `sysio.reserv::reserves`. The table
   * grows linearly in configured pairs — a couple hundred is enough headroom
   * for any cluster `swapquote` would target.
   */
  export const MaxReservesScan = 256

  /**
   * Decomposition of a WIRE-leg swap fee — the TypeScript mirror of
   * `sysio::opp::amm::wire_fee`. Every field is an exact integer quantity:
   * `rewardShare + emissionsShare === fee` and `net + fee === wireAmount`,
   * with no rounding leak.
   */
  export interface WireFee {
    /** Total fee charged on the WIRE leg. */
    fee: bigint
    /** Portion accrued to the rewards bucket — stays in `sysio.reserv` custody. */
    rewardShare: bigint
    /** Portion returned to the emissions treasury — leaves `sysio.reserv` custody. */
    emissionsShare: bigint
    /** `wireAmount - fee`: the net WIRE that continues through the swap. */
    net: bigint
  }

  /**
   * Constant-product output — matches `sysio.reserv::cp_output` bit-for-bit
   * (floored integer division, uint128-safe via bigint). Returns `0n` when any
   * side is zero or negative.
   *
   * @param reserveSource - The source-side reserve depth.
   * @param reserveDestination - The destination-side reserve depth.
   * @param sourceAmount - The amount entering the source side.
   * @returns The destination amount the curve yields.
   */
  export function cpOutput(
    reserveSource: bigint,
    reserveDestination: bigint,
    sourceAmount: bigint
  ): bigint {
    if (reserveSource <= 0n || reserveDestination <= 0n || sourceAmount <= 0n)
      return 0n
    return (reserveDestination * sourceAmount) / (reserveSource + sourceAmount)
  }

  /**
   * Split a gross WIRE amount into its swap fee and remainder, mirroring
   * `sysio::opp::amm::split_wire_fee` bit-for-bit (floored integer math).
   *
   * `feeBps` is deliberately REQUIRED — the depot charges whatever the
   * `sysio.uwrit::uwconfig` singleton holds (the bootstrap seeds it via
   * `setconfig`), so callers read the live value ({@link readFeeBps}) instead
   * of relying on a hardcoded default that silently drifts from the cluster.
   *
   * @param wireAmount - The gross WIRE leg — the constant-product intermediate
   *   for a token source, or the user's escrowed WIRE for a from-WIRE swap.
   * @param feeBps - Fee in basis points — pass the live `uwconfig.fee_bps`.
   * @param rewardShareBps - Reward share of the fee in bps (defaults to
   *   {@link FeeRewardShareBps}).
   * @returns The {@link WireFee} decomposition.
   */
  export function splitWireFee(
    wireAmount: bigint,
    feeBps: number,
    rewardShareBps: number = FeeRewardShareBps
  ): WireFee {
    const bps = BigInt(BpsTotal),
      clampedFeeBps = BigInt(Math.min(Math.max(feeBps, 0), BpsTotal)),
      clampedRewardBps = BigInt(
        Math.min(Math.max(rewardShareBps, 0), BpsTotal)
      ),
      fee = (wireAmount * clampedFeeBps) / bps,
      rewardShare = (fee * clampedRewardBps) / bps
    return {
      fee,
      rewardShare,
      emissionsShare: fee - rewardShare,
      net: wireAmount - fee
    }
  }

  /** One reserve row's `(chain, wire)` book. */
  export interface ReserveBook {
    /** The reserve's chain-side (token) depth. */
    chain: bigint
    /** The reserve's WIRE-side depth. */
    wire: bigint
  }

  /**
   * Post-fee swap quote along the depot curve — the TypeScript mirror of
   * `sysio::opp::amm::quote_swap`, evaluated over book values the caller
   * already holds. Pass `null` for a WIRE endpoint: the depot IS the WIRE side,
   * so that leg consults no reserve.
   *
   * The WIRE-leg fee is charged BETWEEN the hops — the source side gives up the
   * full gross intermediate, and only the post-fee remainder converts into the
   * destination token. Quoting the hops fee-free overstates the destination
   * amount by roughly `feeBps`, which is what the depot settles short of: since
   * `sysio.uwrit` derives `dst_amount` from this same expression, a fee-free
   * quote is not a settlement amount, it is a settlement amount plus the fee.
   *
   * @param source - The source reserve's book, or `null` for a WIRE source.
   * @param destination - The destination reserve's book, or `null` for a WIRE
   *   destination.
   * @param amountIn - The source amount in the source leg's depot-frame units.
   * @param feeBps - The WIRE-leg fee in basis points — pass the live
   *   `uwconfig.fee_bps` ({@link readFeeBps}).
   * @returns The destination amount the recipient receives, or `0n` when the
   *   input or either hop is degenerate — the on-chain "no quote available"
   *   convention.
   */
  export function quoteSwap(
    source: ReserveBook | null,
    destination: ReserveBook | null,
    amountIn: bigint,
    feeBps: number
  ): bigint {
    if (amountIn <= 0n) return 0n
    // WIRE → WIRE is a plain transfer: no curve, no fee.
    if (source == null && destination == null) return amountIn
    const wireLeg =
      source == null ? amountIn : cpOutput(source.chain, source.wire, amountIn)
    if (wireLeg === 0n) return 0n
    const { net } = splitWireFee(wireLeg, feeBps)
    // A WIRE destination receives the post-fee WIRE leg directly.
    if (destination == null) return net
    return cpOutput(destination.wire, destination.chain, net)
  }

  /**
   * The drift window a swap's destination payout may deviate from its quoted
   * target — `target × toleranceBps / 10000` (floored).
   *
   * @param target - The quoted destination amount.
   * @param toleranceBps - The variance tolerance in basis points.
   * @returns The allowed absolute drift.
   */
  export function varianceDrift(target: bigint, toleranceBps: number): bigint {
    return (target * BigInt(toleranceBps)) / BigInt(BpsTotal)
  }

  /**
   * The depot-frame precision CAP. A token's depot precision is
   * `min(nativeDecimals, DepotPrecisionCap)` — a token at or below the cap
   * (6-dec stablecoins, 9-dec lamports) rides OPP envelopes at its NATIVE
   * precision (identity), and only an above-cap token (18-dec wei) scales.
   * Mirrors Ethereum `PrecisionLib.DEPOT_PRECISION` and Solana
   * `precision::DEPOT_PRECISION_DECIMALS`; changing it requires a
   * coordinated depot + outpost migration.
   */
  export const DepotPrecisionCap = 9

  /**
   * The depot-frame precision the depot records for a token —
   * `min(nativeDecimals, DepotPrecisionCap)` (mirror of Ethereum's
   * `PrecisionLib.depotPrecision`).
   *
   * @param nativeDecimals - The token's chain-native decimal scale.
   * @returns The token's depot-frame precision.
   */
  export function depotPrecision(nativeDecimals: number): number {
    Assert.ok(
      Number.isInteger(nativeDecimals) && nativeDecimals > 0,
      `WireReserveTool.depotPrecision: invalid native decimals ${nativeDecimals}`
    )
    return Math.min(nativeDecimals, DepotPrecisionCap)
  }

  /**
   * Convert a chain-native amount to the token's depot frame — the exact
   * scaling the source outpost applies before stamping an outbound
   * `SwapRequest.source_amount` (mirror of Ethereum's `PrecisionLib.toDepot`
   * and Solana's `precision::to_depot`). Per-token precision: an at-or-below-cap
   * token is identity; only an above-cap token downscales.
   *
   * @param nativeAmount - Amount in chain-native base units (wei, lamports, ERC-20 units).
   * @param nativeDecimals - The token's chain-native decimal scale.
   * @returns The amount in the token's depot-frame units (floored when downscaling).
   */
  export function toDepot(
    nativeAmount: bigint,
    nativeDecimals: number
  ): bigint {
    const precision = depotPrecision(nativeDecimals)
    return nativeDecimals > precision
      ? nativeAmount / 10n ** BigInt(nativeDecimals - precision)
      : nativeAmount
  }

  /**
   * Convert a depot-frame amount to chain-native base units — the exact
   * scaling the destination outpost applies when paying out a remit (mirror
   * of Ethereum's `PrecisionLib.fromDepot` and Solana's `precision::from_depot`).
   * Per-token precision: an at-or-below-cap token is identity; only an
   * above-cap token upscales.
   *
   * @param depotAmount - Amount in the token's depot-frame units.
   * @param nativeDecimals - The destination token's chain-native decimal scale.
   * @returns The amount in chain-native base units.
   */
  export function fromDepot(
    depotAmount: bigint,
    nativeDecimals: number
  ): bigint {
    const precision = depotPrecision(nativeDecimals)
    return nativeDecimals > precision
      ? depotAmount * 10n ** BigInt(nativeDecimals - precision)
      : depotAmount
  }

  /**
   * The live WIRE-leg fee (bps) from the `sysio.uwrit::uwconfig` singleton —
   * the exact value the bootstrap's `setconfig` seeded and the depot charges
   * (a read).
   *
   * @param wire - The depot client.
   * @returns The configured `fee_bps`.
   */
  export async function readFeeBps(wire: WireClient): Promise<number> {
    const { rows } = await wire
      .getSysioContract(SysioContractName.uwrit)
      .tables.uwconfig.query()
    return Number(rows[0]?.fee_bps ?? 0)
  }

  /** One reserve's identifying slug triple. */
  export interface ReserveTriple {
    /** The reserve's chain slug value. */
    chainCode: number
    /** The reserve's token slug value. */
    tokenCode: number
    /** The reserve's own slug value. */
    reserveCode: number
  }

  /** Input for {@link swapquote}. */
  export interface SwapQuoteRequest {
    /** The source leg's reserve triple (WIRE/WIRE for a from-WIRE swap). */
    from: ReserveTriple
    /** The source amount, in the source leg's depot-frame units. */
    fromAmount: bigint
    /** The destination leg's reserve triple (WIRE/WIRE for a to-WIRE swap). */
    to: ReserveTriple
  }

  /** Whether a triple denotes the WIRE leg (no reserve consulted). */
  function isWireLeg(triple: ReserveTriple): boolean {
    return (
      triple.chainCode === WireChainCode && triple.tokenCode === WireTokenCode
    )
  }

  /**
   * Cross-chain swap quote — the read-only `sysio.reserv::swapquote` surface,
   * evaluated client-side from the live `reserves` table and the live
   * `uwconfig.fee_bps` (reads). A thin composition of {@link quoteSwap} over
   * those rows, so callers can assert expected quotes before issuing a
   * SWAP_REQUEST and get the amount the depot will actually settle.
   *
   * The fee is read here rather than accepted as a parameter: `sysio.uwrit`
   * reads `uwconfig.fee_bps` fresh at both ingestion and settlement, and a
   * caller who forgets to apply it gets a quote that is short by exactly the
   * fee — silently, since a loose variance tolerance still admits the request.
   *
   * @param wire - The depot client.
   * @param request - The source triple + amount and destination triple.
   * @returns The destination amount, or `0n` when any required reserve row is
   *   missing — matching the on-chain "no quote available" convention.
   */
  export async function swapquote(
    wire: WireClient,
    request: SwapQuoteRequest
  ): Promise<bigint> {
    const { from, fromAmount, to } = request
    if (fromAmount <= 0n) return 0n
    const fromIsWire = isWireLeg(from),
      toIsWire = isWireLeg(to)
    if (fromIsWire && toIsWire) return fromAmount

    const { rows } = await wire
      .getSysioContract(SysioContractName.reserv)
      .tables.reserves.query({ limit: MaxReservesScan })
    const bookFor = (triple: ReserveTriple): ReserveBook | undefined => {
      const reserve = rows.find(
        row =>
          slugValue(row.chain_code) === triple.chainCode &&
          slugValue(row.token_code) === triple.tokenCode &&
          slugValue(row.reserve_code) === triple.reserveCode
      )
      return reserve == null
        ? undefined
        : {
            chain: BigInt(reserve.reserve_chain_amount),
            wire: BigInt(reserve.reserve_wire_amount)
          }
    }

    // `null` denotes the WIRE leg (no reserve consulted); a missing row for a
    // non-WIRE leg is "no quote available".
    let source: ReserveBook | null = null
    if (!fromIsWire) {
      const book = bookFor(from)
      if (book == null) return 0n
      source = book
    }
    let destination: ReserveBook | null = null
    if (!toIsWire) {
      const book = bookFor(to)
      if (book == null) return 0n
      destination = book
    }
    return quoteSwap(source, destination, fromAmount, await readFeeBps(wire))
  }
}
